import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { GoodweSemsClient, SolarSnapshot } from "../goodwe/client.js";
import { TeslaApiError, TeslaFleetClient, VehicleChargeState } from "../tesla/client.js";
import { TelemetryIngest } from "../tesla/telemetry.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "controller" });

export interface OverrideState {
  /** false = fully off, ignore solar. true = automatic solar-following. */
  enabled: boolean;
  setAt: Date | null;
  setBy: string | null;
}

export interface ControllerStatus {
  solar: SolarSnapshot | null;
  vehicle: VehicleChargeState | null;
  vehicleTag: string;
  surplusW: number | null;
  targetAmps: number | null;
  decision: "charging" | "idle" | "waiting_for_stability" | "unavailable";
  override: OverrideState;
  gridImportBufferW: number;
  lastError: string | null;
  lastPollAt: Date | null;
  pollIntervalMs: number;
  telemetryEnabled: boolean;
  telemetryLastSeenAt: Date | null;
  rateLimitedUntil: Date | null;
}

/**
 * Core control loop: poll solar production/consumption, poll the vehicle,
 * and decide whether there's enough spare solar to charge from - unless
 * turned off, in which case it stays idle regardless of solar.
 */
export class ChargeController extends EventEmitter {
  private status: ControllerStatus = {
    solar: null,
    vehicle: null,
    vehicleTag: "",
    surplusW: null,
    targetAmps: null,
    decision: "unavailable",
    override: { enabled: false, setAt: null, setBy: null },
    gridImportBufferW: 0,
    lastError: null,
    lastPollAt: null,
    pollIntervalMs: config.pollIntervalMs,
    telemetryEnabled: false,
    telemetryLastSeenAt: null,
    rateLimitedUntil: null,
  };

  private timer: NodeJS.Timeout | null = null;
  private aboveStartThresholdCount = 0;
  private belowStopThresholdCount = 0;
  private lastRawSolar: { pvPowerW: number; loadPowerW: number } | null = null;
  // Last vehicle_data poll result, kept only as a fallback source when a
  // fresh in-session poll fails (see resolveVehicleState) - never used to
  // paper over a genuinely stale/unknown state.
  private lastPolledVehicle: VehicleChargeState | null = null;
  private lastFallbackAttemptAt = 0;
  private lastWakeAttemptAt = 0;
  // Consecutive pollDirect() failures with no success in between - lets a
  // vehicle with no telemetry hint get a few full-cadence retries (it might
  // just be waking up) before backing off to the same slow recovery cadence
  // used when telemetry is merely stale, even with solar charging on.
  private consecutiveFailures = 0;
  private static readonly MAX_UNTHROTTLED_RETRIES = 3;
  // Set on a 403/429 from Tesla - a hard signal to stop calling Tesla
  // entirely (reads, commands, wake_up) until this time, rather than
  // retrying every cycle into an account-level block that retrying won't
  // clear any faster.
  private rateLimitedUntil = 0;

  constructor(
    private readonly goodwe: GoodweSemsClient,
    private readonly tesla: TeslaFleetClient,
    private readonly telemetry: TelemetryIngest | null = null
  ) {
    super();
    this.status.vehicleTag = tesla.getVehicleTag();
    this.status.telemetryEnabled = telemetry !== null;
  }

  getStatus(): ControllerStatus {
    return this.status;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: config.pollIntervalMs }, "Starting control loop");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(enabled: boolean, setBy: string): void {
    this.status.override = { enabled, setAt: new Date(), setBy };
    log.info({ enabled, setBy }, "Enabled state changed");
    this.aboveStartThresholdCount = 0;
    this.belowStopThresholdCount = 0;
    this.emitUpdate();
  }

  setGridImportBufferW(bufferW: number, setBy: string): void {
    log.info({ bufferW, setBy }, "Grid import buffer changed");
    this.status.gridImportBufferW = bufferW;
    this.emitUpdate();
  }

  setVehicleTag(tag: string, setBy: string): void {
    log.info({ tag, setBy }, "Switching active vehicle");
    this.tesla.setVehicleTag(tag);
    this.status.vehicleTag = tag;
    this.status.vehicle = null;
    this.status.decision = "unavailable";
    this.aboveStartThresholdCount = 0;
    this.belowStopThresholdCount = 0;
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.emit("update", this.status);
  }

  private async tick(): Promise<void> {
    try {
      const [solar, vehicle] = await Promise.all([this.goodwe.getSnapshot(), this.resolveVehicleState()]);

      this.status.solar = solar;
      this.status.vehicle = vehicle;
      this.status.lastPollAt = new Date();
      this.status.lastError = null;

      // GoodWe's SEMS portal is cloud-relayed and can go several poll cycles
      // without actually refreshing - an unchanged pv/load reading is our
      // signal that this snapshot is stale, not a real measurement of the
      // current moment.
      const solarStale =
        this.lastRawSolar !== null &&
        solar.pvPowerW === this.lastRawSolar.pvPowerW &&
        solar.loadPowerW === this.lastRawSolar.loadPowerW;
      this.lastRawSolar = { pvPowerW: solar.pvPowerW, loadPowerW: solar.loadPowerW };

      // The true remaining balance: what's actually left over (or being
      // drawn from the grid) after every load, including the EV, is
      // accounted for. This is what we show and what start/stop decisions
      // are based on.
      const surplusW = solar.pvPowerW - solar.loadPowerW - this.status.gridImportBufferW;
      this.status.surplusW = surplusW;

      await this.decide(surplusW, vehicle, solarStale);
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.status.decision = "unavailable";
      log.error({ err: this.status.lastError }, "Poll cycle failed");
    }

    this.emitUpdate();
  }

  /**
   * Without telemetry configured, falls back to the original behavior:
   * poll vehicle_data every cycle, rate-limited wake on failure. With
   * telemetry configured, that per-cycle Data-category cost only applies
   * while a charge session is actually active (to get accurate
   * charger_actual_current/voltage for the ramp math, which telemetry
   * hints deliberately don't carry - see tesla/telemetry.ts). The rest of
   * the time - parked, asleep, off-peak - state comes from the pushed
   * telemetry hint and costs nothing.
   */
  private async resolveVehicleState(): Promise<VehicleChargeState | null> {
    const now = Date.now();

    // Hard circuit breaker: Tesla told us to stop (403/429). Every field
    // below - telemetry hints, override state, "just started charging" -
    // gets ignored until the cooldown expires, because none of it changes
    // the fact that retrying now just extends whatever got us blocked.
    if (now < this.rateLimitedUntil) {
      this.status.rateLimitedUntil = new Date(this.rateLimitedUntil);
      return this.lastPolledVehicle;
    }
    this.status.rateLimitedUntil = null;

    if (!this.telemetry) {
      return this.pollDirect({ wakeOnFailure: true });
    }

    const vin = this.tesla.getVehicleTag();
    const hint = this.telemetry.getHint(vin);
    const hintFresh = hint !== undefined && now - hint.lastSeenAt.getTime() <= config.tesla.telemetryStaleMs;
    this.status.telemetryLastSeenAt = hint?.lastSeenAt ?? null;

    if (hintFresh && hint.chargingState === "Charging") {
      // Active session: need authoritative amp/voltage data for the ramp
      // loop, so this is the one case that still polls every cycle.
      const polled = await this.pollDirect({ wakeOnFailure: false });
      return polled ?? this.lastPolledVehicle;
    }

    if (hintFresh) {
      // Plugged-in/idle/disconnected: the decide() branches that run for a
      // non-charging vehicle never read chargerVoltage/chargerActualCurrent,
      // so a hint-derived stand-in is safe here (see tesla/telemetry.ts).
      return {
        chargingState: hint.chargingState,
        chargeAmps: 0,
        chargeLimitSoc: this.lastPolledVehicle?.chargeLimitSoc ?? 0,
        batteryLevel: hint.batteryLevel,
        chargerVoltage: 0,
        chargerActualCurrent: 0,
        pluggedIn: hint.pluggedIn,
        timestamp: hint.lastSeenAt,
      };
    }

    // No hint yet, or telemetry has gone quiet (car offline/deep asleep,
    // the ingest pipe itself is down, or this vehicle just never
    // established a telemetry connection). Rate-limit the recovery poll so
    // a persistently unreachable vehicle doesn't rack up Data/Wake cost
    // every 30s.
    //
    // Solar charging being on gets a short grace window of full-cadence
    // retries (MAX_UNTHROTTLED_RETRIES) in case the car is mid-wake and
    // about to answer - but NOT an indefinite one. A vehicle that's failed
    // several times in a row isn't "about to answer any second", it's
    // unreachable, and hammering it every 30s bought nothing but a 403
    // account-level suspension last time this ran unthrottled for hours.
    // Once that grace window is used up, fall back to the same slow
    // recovery cadence used when charging is off, until a poll actually
    // succeeds (which resets the counter) or the caller flips override off.
    const dueForRecoveryPoll = now - this.lastFallbackAttemptAt >= config.tesla.telemetryRecoveryPollMs;
    const withinUnthrottledGrace =
      this.status.override.enabled && this.consecutiveFailures < ChargeController.MAX_UNTHROTTLED_RETRIES;

    if (!dueForRecoveryPoll && !withinUnthrottledGrace) {
      return this.lastPolledVehicle;
    }
    return this.pollDirect({ wakeOnFailure: this.status.override.enabled && this.consecutiveFailures === 0 });
  }

  private async pollDirect(opts: { wakeOnFailure: boolean }): Promise<VehicleChargeState | null> {
    this.lastFallbackAttemptAt = Date.now();
    try {
      const vehicle = await this.tesla.getChargeState();
      this.lastPolledVehicle = vehicle;
      this.consecutiveFailures = 0;
      return vehicle;
    } catch (err) {
      this.consecutiveFailures += 1;

      if (err instanceof TeslaApiError && (err.status === 403 || err.status === 429)) {
        this.rateLimitedUntil = Date.now() + config.tesla.rateLimitCooldownMs;
        this.status.rateLimitedUntil = new Date(this.rateLimitedUntil);
        log.error(
          { err: String(err), cooldownMs: config.tesla.rateLimitCooldownMs },
          "Tesla rejected the request with 403/429 - pausing ALL Tesla calls (reads, commands, wake_up) for the cooldown period"
        );
        return null;
      }

      log.warn({ err: String(err) }, "Vehicle unreachable this cycle");
      const now = Date.now();
      // wake_up is itself billed and only useful once every so often - a
      // vehicle that's genuinely offline shouldn't get hit every cycle.
      if (opts.wakeOnFailure && now - this.lastWakeAttemptAt >= config.tesla.telemetryRecoveryPollMs) {
        this.lastWakeAttemptAt = now;
        this.tesla.wakeUp().catch((wakeErr) => log.debug({ err: String(wakeErr) }, "wake_up failed"));
      }
      return null;
    }
  }

  private async decide(surplusW: number, vehicle: VehicleChargeState | null, solarStale: boolean): Promise<void> {
    if (Date.now() < this.rateLimitedUntil) {
      // Don't issue commands (stop/start/set-amps) off a stale cached
      // vehicle reading either - those are Tesla calls too, and firing
      // them into an active cooldown just adds more blocked requests.
      this.status.decision = "unavailable";
      this.status.targetAmps = null;
      return;
    }

    if (!this.status.override.enabled) {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      if (vehicle?.chargingState === "Charging") {
        await this.tesla.stopCharging().catch((err) => log.warn({ err: String(err) }, "stop failed"));
      }
      return;
    }

    if (!vehicle) {
      this.status.decision = "unavailable";
      return;
    }

    if (!vehicle.pluggedIn) {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      this.aboveStartThresholdCount = 0;
      this.belowStopThresholdCount = 0;
      return;
    }

    // Trust the vehicle's own reported state, not our memory of what commands
    // we've sent - a command can silently fail to reach the car (e.g. asleep,
    // signed-command proxy timeout) and we'd otherwise get stuck believing
    // it's charging when it never started.
    const currentlyCharging = vehicle.chargingState === "Charging";

    // The vehicle itself stops charging once it hits its own charge-limit
    // slider (charging_state -> "Complete") - without this check the
    // !currentlyCharging branch below would treat "Complete" the same as
    // "hasn't started yet" and, given ongoing solar surplus, repeatedly
    // call applyCharge() -> startCharging() against a battery that's
    // already at its limit. Turn the automation off instead, both to
    // respect the car's own limit and to stop paying for poll/command
    // cycles once there's nothing left to do until it's unplugged.
    if (vehicle.chargingState === "Complete") {
      log.info({ vehicleTag: this.status.vehicleTag }, "Charge complete - turning off solar charging automation");
      this.status.decision = "idle";
      this.status.targetAmps = null;
      this.setEnabled(false, "auto:charge-complete");
      return;
    }

    if (!currentlyCharging) {
      if (surplusW >= config.minSurplusStartW) {
        this.aboveStartThresholdCount += 1;
      } else {
        this.aboveStartThresholdCount = 0;
      }

      if (this.aboveStartThresholdCount >= config.stableCyclesToStart) {
        const ok = await this.applyCharge(config.minChargeAmps, vehicle);
        if (ok) {
          this.status.decision = "charging";
          this.status.targetAmps = config.minChargeAmps;
        } else {
          this.status.decision = "waiting_for_stability";
          this.status.targetAmps = null;
        }
        this.belowStopThresholdCount = 0;
      } else {
        this.status.decision = "waiting_for_stability";
        this.status.targetAmps = null;
      }
      return;
    }

    // The wall connector has no network connection of its own, so the
    // GoodWe inverter's load reading already includes whatever the car is
    // currently drawing - it looks like ordinary house load. For the ramp
    // target only (not the true balance above), add the car's own draw
    // (reported directly by the vehicle, independent of the wall connector)
    // back in, otherwise raising the charge current would eat its own
    // surplus and the loop would never ramp up.
    const evDrawW = vehicle.chargerVoltage * vehicle.chargerActualCurrent;
    const targetSurplusW = surplusW + evDrawW;
    const ampsAvailable = wattsToAmps(targetSurplusW);

    // Ramp amps down as the available surplus shrinks; only stop outright
    // once even the minimum charge rate isn't sustainable for a couple of
    // consecutive polls, rather than cutting straight to zero the moment
    // the balance dips negative.
    if (ampsAvailable < config.minChargeAmps) {
      this.belowStopThresholdCount += 1;
    } else {
      this.belowStopThresholdCount = 0;
    }

    if (this.belowStopThresholdCount >= config.stableCyclesToStop) {
      const ok = await this.tesla
        .stopCharging()
        .then(() => true)
        .catch((err) => {
          log.warn({ err: String(err) }, "stop failed");
          this.status.lastError = `Failed to stop charging: ${err instanceof Error ? err.message : String(err)}`;
          return false;
        });
      if (ok) {
        this.status.decision = "idle";
        this.status.targetAmps = null;
        this.aboveStartThresholdCount = 0;
      }
      return;
    }

    let amps = clamp(ampsAvailable, config.minChargeAmps, config.maxChargeAmps);
    if (solarStale) {
      // Don't trust a jump up while we can't confirm the load reading is
      // current - the car's own draw could be masking a stale (lower) load
      // figure and make surplus look bigger than it really is. Holding or
      // decreasing is still safe either way.
      amps = Math.min(amps, vehicle.chargeAmps);
    }
    this.status.decision = "charging";
    this.status.targetAmps = amps;
    if (amps !== vehicle.chargeAmps) {
      await this.tesla.setChargeAmps(amps).catch((err) => {
        log.warn({ err: String(err) }, "amps failed");
        this.status.lastError = `Failed to adjust charge amps: ${err instanceof Error ? err.message : String(err)}`;
      });
    }
  }

  private async applyCharge(amps: number, vehicle: VehicleChargeState | null): Promise<boolean> {
    try {
      if (vehicle?.chargingState !== "Charging") {
        await this.tesla.startCharging();
      }
      await this.tesla.setChargeAmps(amps);
      return true;
    } catch (err) {
      log.warn({ err: String(err) }, "applyCharge failed");
      this.status.lastError = `Failed to start charging: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }
}

function wattsToAmps(watts: number): number {
  if (watts <= 0) return 0;
  const volts = config.chargerVoltage * config.chargerPhases;
  return Math.floor(watts / volts);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
