import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { GoodweSemsClient, SolarSnapshot } from "../goodwe/client.js";
import { TeslaApiError, TeslaFleetClient, VehicleChargeState } from "../tesla/client.js";
import { TelemetryHint, TelemetryIngest } from "../tesla/telemetry.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "controller" });

// No realistic home AC charging setup draws anywhere near this - a
// telemetry reading above it almost certainly means ACChargingPower's
// actual units don't match the kW assumption in tesla/telemetry.ts.
const SANITY_MAX_CHARGER_POWER_W = 30_000;

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
  // Wall-clock companion bound to MAX_UNTHROTTLED_RETRIES (see
  // resolveVehicleState) - reset whenever override is turned on.
  private unthrottledGraceStartedAt = 0;
  private static readonly UNTHROTTLED_GRACE_WINDOW_MS = 2 * 60 * 1000;
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
    if (enabled) {
      this.consecutiveFailures = 0;
      this.unthrottledGraceStartedAt = Date.now();
    }
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
    // Tesla only pushes DetailedChargeState/ChargePortDoorOpen on *change*,
    // not periodically - so right after a restart (hint map starts empty),
    // a vehicle that's been steadily "Charging" the whole time won't get a
    // fresh push until its state actually changes, potentially for the
    // rest of the session. Meanwhile other fields (ACChargingPower) that do
    // change continuously keep refreshing lastSeenAt, which would make a
    // pure time-based check see this as "fresh" despite chargingState still
    // being unknown - requiring a known chargingState too routes that case
    // into the same poll-fallback below instead of confidently (and
    // wrongly) treating an actively-charging vehicle as unplugged/idle.
    const hintFresh =
      hint !== undefined &&
      hint.chargingState !== "Unknown" &&
      now - hint.lastSeenAt.getTime() <= config.tesla.telemetryStaleMs;
    this.status.telemetryLastSeenAt = hint?.lastSeenAt ?? null;

    if (hintFresh && hint.chargingState === "Charging") {
      const chargingDataFresh =
        hint.chargingDataLastSeenAt !== null &&
        now - hint.chargingDataLastSeenAt.getTime() <= config.tesla.telemetryChargingStaleMs;

      if (chargingDataFresh) {
        // Telemetry is delivering real, recent ChargeAmps/ACChargingPower
        // readings - the ramp loop can run on that instead of polling.
        return this.buildStateFromHint(hint);
      }

      // Charging per telemetry, but the charging-power fields specifically
      // haven't reported anything recent (session just started and hasn't
      // caught up yet, or they've gone stale independent of the general
      // hint). Poll once for authoritative numbers; once telemetry catches
      // up, subsequent cycles go back to the branch above.
      const polled = await this.pollDirect({ wakeOnFailure: false });
      return polled ?? this.lastPolledVehicle;
    }

    if (hintFresh) {
      return this.buildStateFromHint(hint);
    }

    // No hint yet, telemetry has gone quiet, or chargingState specifically
    // is still unknown (car offline/deep asleep, the ingest pipe itself is
    // down, this vehicle never established a telemetry connection, or it's
    // the post-restart gap described above). Rate-limit the recovery poll
    // so a persistently unreachable vehicle doesn't rack up Data/Wake cost
    // every 30s.
    //
    // Solar charging being on gets a short grace window of full-cadence
    // retries in case the car is mid-wake and about to answer - but NOT an
    // indefinite one. Bounded by BOTH a retry count and a wall-clock
    // window: count alone isn't enough, because a *successful* poll resets
    // consecutiveFailures to 0, and if chargingState stays unknown for
    // reasons other than unreachability (the post-restart gap above -
    // every poll can keep succeeding while telemetry still never reports
    // the field), count-only would keep the grace window open, and thus
    // the unthrottled 30s cadence, indefinitely - which is exactly the
    // hours-long hammering that caused the 2026-07-25 rate-limit incident.
    // pollDirect() success also seeds the telemetry hint's chargingState
    // directly, which is the real fix for that gap - this time bound is
    // defense in depth for whatever isn't covered by that.
    const dueForRecoveryPoll = now - this.lastFallbackAttemptAt >= config.tesla.telemetryRecoveryPollMs;
    const withinUnthrottledGrace =
      this.status.override.enabled &&
      this.consecutiveFailures < ChargeController.MAX_UNTHROTTLED_RETRIES &&
      now - this.unthrottledGraceStartedAt < ChargeController.UNTHROTTLED_GRACE_WINDOW_MS;

    if (!dueForRecoveryPoll && !withinUnthrottledGrace) {
      return this.lastPolledVehicle;
    }
    return this.pollDirect({ wakeOnFailure: this.status.override.enabled && this.consecutiveFailures === 0 });
  }

  /**
   * decide()'s ramp math only ever uses chargerVoltage * chargerActualCurrent
   * as a product (never independently), so splitting hint.chargerPowerW into
   * a nominal voltage and a back-derived "current" that multiplies out to
   * the same real watts is exact for that purpose, while still leaving both
   * fields individually plausible for dashboard display.
   */
  private buildStateFromHint(hint: TelemetryHint): VehicleChargeState {
    if (hint.chargerPowerW > SANITY_MAX_CHARGER_POWER_W) {
      log.warn(
        { chargerPowerW: hint.chargerPowerW },
        "Telemetry chargerPowerW is implausibly high - possible unit mismatch in ACChargingPower parsing (see tesla/telemetry.ts)"
      );
    }
    const chargerVoltage = hint.chargerPowerW > 0 ? config.chargerVoltage : 0;
    const chargerActualCurrent = chargerVoltage > 0 ? hint.chargerPowerW / chargerVoltage : 0;

    return {
      chargingState: hint.chargingState,
      chargeAmps: hint.chargeAmps,
      chargeLimitSoc: hint.chargeLimitSoc || this.lastPolledVehicle?.chargeLimitSoc || 0,
      batteryLevel: hint.batteryLevel,
      chargerVoltage,
      chargerActualCurrent,
      pluggedIn: hint.pluggedIn,
      timestamp: hint.lastSeenAt,
    };
  }

  private async pollDirect(opts: { wakeOnFailure: boolean }): Promise<VehicleChargeState | null> {
    this.lastFallbackAttemptAt = Date.now();
    try {
      const vehicle = await this.tesla.getChargeState();
      this.lastPolledVehicle = vehicle;
      this.consecutiveFailures = 0;
      // Backfill telemetry's chargingState/pluggedIn from this authoritative
      // read if telemetry hasn't reported them yet (see the post-restart
      // gap explained in resolveVehicleState) - lets subsequent cycles use
      // the telemetry-driven branch instead of polling again next tick.
      this.telemetry?.seedChargingState(this.tesla.getVehicleTag(), vehicle.chargingState, vehicle.pluggedIn);
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
      // Fully hands-off when disabled - no commands to the vehicle at all,
      // not even a "cleanup" stop. This used to stop_charge whenever it
      // saw "Charging" while disabled (on the assumption evcharge itself
      // had started that session), but that meant the toggle only ever
      // controlled evcharge's own *decisions*, not whether it touched the
      // car - with the pm2 process left running, it kept firing charge_stop
      // at any session it saw, including ones started by something else
      // entirely (ChargeHQ, the Tesla app, manual start) - see
      // evcharge_project memory, 2026-07-27. The toggle is now the actual
      // on/off switch: disabled means don't send anything, full stop.
      this.status.decision = "idle";
      this.status.targetAmps = null;
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
