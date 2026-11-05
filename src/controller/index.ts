import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { GoodweSemsClient, SolarSnapshot } from "../goodwe/client.js";
import { TeslaApiError, TeslaFleetClient, VehicleChargeState } from "../tesla/client.js";
import { TelemetryHint, TelemetryIngest } from "../tesla/telemetry.js";
import { logger } from "../util/logger.js";
import {
  ampCommandNeeded,
  budgetBlocksPaidCalls,
  chargeSnapshotIsAwake,
  classifyTeslaBlock,
  commandGapElapsed,
  planRecovery,
  RecoveryPlan,
  TeslaWait,
} from "./teslaRecovery.js";
import { loadActiveVehicleTag, loadSolarEnabled, saveActiveVehicleTag, saveSolarEnabled } from "./chargeSettings.js";
import { loadTeslaHolds, saveTeslaHolds } from "./teslaHolds.js";

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
  decision: "charging" | "idle" | "waiting_for_stability" | "unavailable" | "online";
  override: OverrideState;
  gridImportBufferW: number;
  lastError: string | null;
  lastPollAt: Date | null;
  pollIntervalMs: number;
  telemetryEnabled: boolean;
  telemetryLastSeenAt: Date | null;
  rateLimitedUntil: Date | null;
  /** When the next Tesla read, wake, or budget/rate-limit hold ends. */
  nextTeslaAttemptAt: Date | null;
  /** Why the car isn't being commanded, for the dashboard. */
  teslaWait: TeslaWait;
  /** True while paid Fleet API calls are paused for a billing cap (or mode=on). */
  apiBudgetActive: boolean;
  /** Short non-error note, e.g. a command that was skipped because it repeated. */
  statusNote: string | null;
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
    nextTeslaAttemptAt: null,
    teslaWait: config.tesla.apiBudgetMode === "on" ? "budget" : "none",
    apiBudgetActive: config.tesla.apiBudgetMode === "on",
    statusNote: null,
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
  /**
   * False when this cycle has no fresh telemetry hint and no successful
   * poll. decide() must not send charge commands off a stale "Stopped"
   * snapshot — that loop is what produced thousands of billed commands
   * while the car's reported state lagged.
   */
  private haveFreshControlState = false;
  private tickInFlight = false;
  /** User turned solar on. One vehicle_data/wake is allowed inside the slow gap. */
  private sessionProbePending = false;
  /** User turned solar on during a billing hold. One paid bundle, then pause again. */
  private sessionCredit = false;
  /** True after the credit is consumed, until this tick finishes. */
  private sessionBundleOpen = false;
  /** auto-mode billing hold end. 0 = none. Forced `on` does not need this. */
  private budgetUntil = 0;
  private lastStartCommandAt = 0;
  private lastStopCommandAt = 0;
  private lastAmpCommandAt = 0;
  private lastCommandedAmps: number | null = null;
  /**
   * charge_start was accepted but vehicle_data / telemetry has not yet
   * reported Charging. Until then the dash must not keep a pre-start
   * Stopped / 0 V / 0 A snapshot, and recovery may poll once per tick
   * (inside the normal gap) to confirm the session.
   */
  private chargeStartConfirmPending = false;
  // Set on a 403/429 from Tesla - a hard signal to stop calling Tesla
  // entirely (reads, commands, wake_up) until this time, rather than
  // retrying every cycle into an account-level block that retrying won't
  // clear any faster.
  private rateLimitedUntil = 0;
  /** Auth-edge HTML 403 (not a vehicle rate limit). Short persisted pause. */
  private authPausedUntil = 0;
  /** After a persisted hold, the next Tesla call is vehicle_data, never wake_up. */
  private suppressWake = false;
  // Charge limit just accepted by the car. Telemetry's ChargeLimitSoc is
  // pushed on a long interval, and an in-flight poll can still be holding
  // the previous percent — keep showing the commanded value until a
  // ChargeLimitSoc observation (or a vehicle_data poll) from after `at`.
  private commandedChargeLimit: { percent: number; at: number } | null = null;

  constructor(
    private readonly goodwe: GoodweSemsClient,
    private readonly tesla: TeslaFleetClient,
    private readonly telemetry: TelemetryIngest | null = null
  ) {
    super();
    // Only the last dashboard selection (persisted) is the active car.
    // Ignore TESLA_VEHICLE_TAG / whatever the Tesla client was constructed
    // with — restart must not flip back to Model 3 or the first listed VIN.
    const savedTag = loadActiveVehicleTag();
    if (savedTag) {
      this.tesla.setVehicleTag(savedTag);
      this.status.vehicleTag = savedTag;
    } else {
      this.tesla.setVehicleTag("");
      this.status.vehicleTag = "";
      log.info("No persisted active vehicle — waiting for a dashboard selection");
    }
    this.status.telemetryEnabled = telemetry !== null;
    this.restoreHolds();
    const savedEnabled = loadSolarEnabled();
    if (savedEnabled !== null) {
      this.status.override = { enabled: savedEnabled, setAt: null, setBy: "restart" };
    }
  }

  private restoreHolds(): void {
    const saved = loadTeslaHolds();
    const now = Date.now();
    if (saved.rateLimitedUntil > now) this.rateLimitedUntil = saved.rateLimitedUntil;
    if (saved.budgetUntil > now) this.budgetUntil = saved.budgetUntil;
    if (saved.authPausedUntil > now) this.authPausedUntil = saved.authPausedUntil;
    this.suppressWake =
      saved.suppressWake || saved.rateLimitedUntil > now || saved.budgetUntil > now || saved.authPausedUntil > now;
    // Only restore a charge snapshot when a VIN is already selected —
    // never invent a car from a leftover hold after an unset selection.
    if (saved.vehicle && this.status.vehicleTag) {
      this.lastPolledVehicle = saved.vehicle;
      this.status.vehicle = saved.vehicle;
    }
    if (this.rateLimitedUntil > now || this.authPausedUntil > now || this.budgetHoldActive()) this.publishBlockStatus();
  }

  private persistHolds(): void {
    saveTeslaHolds({
      rateLimitedUntil: this.rateLimitedUntil,
      budgetUntil: this.budgetUntil,
      authPausedUntil: this.authPausedUntil,
      suppressWake: this.suppressWake,
      vehicle: this.lastPolledVehicle,
    });
  }

  private paidHoldActive(): boolean {
    const now = Date.now();
    return now < this.rateLimitedUntil || now < this.authPausedUntil || this.budgetHoldActive();
  }

  private recentlyAwake(): boolean {
    const vehicle = this.lastPolledVehicle;
    if (!vehicle || !chargeSnapshotIsAwake(vehicle)) return false;
    const age = Date.now() - new Date(vehicle.timestamp).getTime();
    const windowMs = Math.max(config.tesla.telemetryRecoveryPollMs, config.tesla.telemetryStaleMs);
    return age >= -5_000 && age <= windowMs;
  }

  private telemetryFreshNow(): boolean {
    const hint = this.telemetry?.getHint(this.tesla.getVehicleTag());
    return this.isHintFresh(hint, Date.now());
  }

  getStatus(): ControllerStatus {
    this.status.apiBudgetActive = this.budgetHoldActive();
    return this.status;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: config.pollIntervalMs }, "Starting control loop");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  /**
   * Tesla returned 403 or 429. Stop every Tesla call (reads, wake_up,
   * commands, vehicle list) until the cooldown ends. A later call cannot
   * shorten a cooldown that's already running — retrying sooner is what
   * extended the July 2026 account block.
   */
  noteRateLimit(source: string, cooldownMs = config.tesla.rateLimitCooldownMs): void {
    const until = Date.now() + cooldownMs;
    if (until <= this.rateLimitedUntil) return;
    this.rateLimitedUntil = until;
    this.haveFreshControlState = false;
    this.sessionCredit = false;
    this.sessionBundleOpen = false;
    this.sessionProbePending = false;
    this.suppressWake = true;
    log.error(
      { source, cooldownMs, until: new Date(until) },
      "Tesla rate limit — pausing ALL Tesla calls (reads, commands, wake_up). The hold is persisted across restarts."
    );
    this.persistHolds();
    this.publishBlockStatus();
    this.emitUpdate();
  }

  /**
   * Billing-cap / HTTP 402. Longer hold than 403/429. Does not shorten an
   * existing 403 cooldown — callers still invoke noteRateLimit for 403/429.
   */
  noteBillingLimit(source: string): void {
    if (config.tesla.apiBudgetMode === "off") {
      log.error({ source }, "Tesla billing-cap response ignored because TESLA_API_BUDGET_MODE=off");
      return;
    }
    const until = Date.now() + config.tesla.apiBudgetCooldownMs;
    if (until > this.budgetUntil) this.budgetUntil = until;
    this.sessionCredit = false;
    this.sessionBundleOpen = false;
    this.sessionProbePending = false;
    this.haveFreshControlState = false;
    this.suppressWake = true;
    log.error(
      { source, cooldownMs: config.tesla.apiBudgetCooldownMs, until: new Date(this.budgetUntil) },
      "Tesla billing cap — pausing paid Fleet API calls"
    );
    this.persistHolds();
    this.publishBlockStatus();
    this.emitUpdate();
  }

  /**
   * Token host returned an auth-edge denial (HTML Access Denied), not a
   * vehicle 429 and not EXCEEDED_LIMIT. Short pause so we don't hammer,
   * labeled as auth so it is not a 30-minute rate-limit hold.
   */
  noteAuthFailure(source: string, detail: string): void {
    const until = Date.now() + config.tesla.authFailureCooldownMs;
    if (until <= this.authPausedUntil) return;
    this.authPausedUntil = until;
    this.sessionCredit = false;
    this.sessionBundleOpen = false;
    this.sessionProbePending = false;
    this.suppressWake = true;
    this.haveFreshControlState = false;
    this.status.lastError = `Tesla auth failed: ${detail}`;
    log.error(
      { source, cooldownMs: config.tesla.authFailureCooldownMs, until: new Date(until), detail },
      "Tesla auth failed — not a vehicle rate limit and not a billing cap"
    );
    this.persistHolds();
    this.publishBlockStatus();
    this.emitUpdate();
  }

  /** Classify a Tesla client error and apply the matching hold. */
  observeTeslaError(source: string, err: unknown): void {
    if (!(err instanceof TeslaApiError)) return;
    const kind = classifyTeslaBlock(err.status, err.message);
    log.error({ source, status: err.status, kind, body: err.message }, "Tesla call failed");
    if (kind === "billing") {
      if (config.tesla.apiBudgetMode === "off") this.noteRateLimit(source);
      else this.noteBillingLimit(source);
      return;
    }
    if (kind === "auth") {
      this.noteAuthFailure(source, err.message);
      return;
    }
    if (kind !== "rate_limit") return;
    // 429 is a transient throttle. A non-auth 403 keeps the long cooldown.
    // Neither path calls wake_up to "check again".
    const cooldown = err.status === 429 ? config.tesla.transientRateLimitCooldownMs : config.tesla.rateLimitCooldownMs;
    this.noteRateLimit(source, cooldown);
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
    saveSolarEnabled(enabled);
    if (enabled) {
      // Do not spend a paid probe during a billing/rate-limit hold, or when
      // the last snapshot already shows the car online. Otherwise contact
      // Tesla now: one vehicle_data read, then one wake if that read gets
      // nothing. Do not leave the previous "next try in 10 min" countdown
      // on screen for this tap.
      const held = this.paidHoldActive();
      this.sessionCredit = false;
      this.explicitSession = !held;
      this.sessionProbePending = !held && !this.telemetryFreshNow() && !this.recentlyAwake();
      if (this.sessionProbePending) this.clearRecoveryCountdown();
    } else {
      // Off stops the car and keeps it stopped, even when solar is abundant.
      this.sessionCredit = false;
      this.sessionProbePending = false;
      this.explicitSession = true;
      this.status.decision = "idle";
      this.status.targetAmps = null;
    }
    this.emitUpdate();
    void this.tick();
  }

  setGridImportBufferW(_bufferW: number, setBy: string): void {
    // The dash no longer exposes a buffer. Keep the endpoint so an old
    // page cannot stick a reserve that would hide surplus.
    log.info({ setBy }, "Ignoring grid import buffer; surplus stays the full balance");
    this.status.gridImportBufferW = 0;
    this.emitUpdate();
  }

  setVehicleTag(tag: string, setBy: string): void {
    const trimmed = tag.trim();
    log.info({ tag: trimmed, setBy }, "Switching active vehicle");
    this.tesla.setVehicleTag(trimmed);
    this.status.vehicleTag = trimmed;
    saveActiveVehicleTag(trimmed);
    this.status.vehicle = null;
    this.status.decision = "unavailable";
    this.aboveStartThresholdCount = 0;
    this.belowStopThresholdCount = 0;
    this.lastPolledVehicle = null;
    this.haveFreshControlState = false;
    this.consecutiveFailures = 0;
    this.lastCommandedAmps = null;
    // Drop the previous car's charge snapshot from the holds file so a
    // restart cannot paint the new VIN with the old car's battery/%.
    this.persistHolds();
    if (this.status.override.enabled) {
      const held = this.paidHoldActive();
      this.sessionCredit = false;
      this.explicitSession = !held;
      this.sessionProbePending = !held && !this.telemetryFreshNow() && !this.recentlyAwake();
      if (this.sessionProbePending) this.clearRecoveryCountdown();
    }
    this.emitUpdate();
    if (this.status.override.enabled) void this.tick();
  }

  /**
   * Call after Tesla accepts set_charge_limit. Updates the cached vehicle
   * and the telemetry hint so the dashboard doesn't keep rendering the
   * previous chargeLimitSoc (the command response does not include it).
   */
  noteChargeLimit(percent: number): void {
    const rounded = Math.round(percent);
    this.commandedChargeLimit = { percent: rounded, at: Date.now() };
    this.telemetry?.noteChargeLimit(this.tesla.getVehicleTag(), rounded);
    this.patchDisplayedChargeLimit(rounded);
    this.emitUpdate();
  }

  private patchDisplayedChargeLimit(percent: number): void {
    if (this.status.vehicle) {
      this.status.vehicle = { ...this.status.vehicle, chargeLimitSoc: percent };
    }
    if (this.lastPolledVehicle) {
      this.lastPolledVehicle = { ...this.lastPolledVehicle, chargeLimitSoc: percent };
    }
  }

  /**
   * A tick that started before noteChargeLimit can assign a vehicle
   * snapshot that still says the old percent. Put the commanded value
   * back unless the car has reported ChargeLimitSoc since the command.
   */
  private reapplyCommandedChargeLimit(): void {
    const cmd = this.commandedChargeLimit;
    if (!cmd) return;

    const hint = this.telemetry?.getHint(this.tesla.getVehicleTag());
    if (hint?.chargeLimitObservedAt && hint.chargeLimitObservedAt.getTime() > cmd.at) {
      this.commandedChargeLimit = null;
      return;
    }

    this.patchDisplayedChargeLimit(cmd.percent);
  }

  private emitUpdate(): void {
    this.emit("update", this.status);
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const [solar, vehicle] = await Promise.all([this.goodwe.getSnapshot(), this.resolveVehicleState()]);

      this.status.solar = solar;
      // Keep the last known charge snapshot on screen when this cycle
      // couldn't reach the car, so the picker and "Stopped / plugged in"
      // don't flash blank. decide() is still given null in that case.
      this.status.vehicle = vehicle ?? this.lastPolledVehicle;
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

      // Full spare solar after house load. The grid-import buffer control
      // was removed, so a value left in memory must not keep reserving watts.
      this.status.gridImportBufferW = 0;
      const surplusW = solar.pvPowerW - solar.loadPowerW;
      this.status.surplusW = surplusW;

      const controlVehicle = this.haveFreshControlState ? (vehicle ?? this.lastPolledVehicle) : null;
      await this.decide(surplusW, controlVehicle, solarStale);
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.status.decision = "unavailable";
      log.error({ err: this.status.lastError }, "Poll cycle failed");
    } finally {
      this.sessionBundleOpen = false;
      this.explicitSession = false;
      this.tickInFlight = false;
    }

    this.reapplyCommandedChargeLimit();
    this.reconcileAwakeDisplay();
    this.emitUpdate();
  }

  /**
   * A successful vehicle_data read already proved the car is online. Later
   * ticks still wait out the recovery gap before the next paid poll, but
   * that wait must not be labeled "Waking" / "Asleep" over a live snapshot.
   */
  private reconcileAwakeDisplay(): void {
    if (
      this.status.teslaWait === "rate_limited" ||
      this.status.teslaWait === "budget" ||
      this.status.teslaWait === "auth" ||
      this.status.teslaWait === "quiet_hours"
    ) {
      return;
    }
    if (this.consecutiveFailures > 0 || this.status.lastError) return;

    const vehicle = this.status.vehicle;
    if (!vehicle || !this.snapshotIsCurrent(vehicle) || !chargeSnapshotIsAwake(vehicle)) return;

    if (this.status.teslaWait === "waking" || this.status.teslaWait === "asleep") {
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
    }

    if (this.status.decision === "unavailable") {
      const charging =
        vehicle.chargingState === "Charging" ||
        vehicle.chargingState === "Starting" ||
        (vehicle.chargerVoltage > 0 && vehicle.chargerActualCurrent > 0);
      this.status.decision = charging ? "charging" : "online";
    }
  }

  private snapshotIsCurrent(vehicle: VehicleChargeState): boolean {
    const age = Date.now() - new Date(vehicle.timestamp).getTime();
    return age >= -5_000 && age <= config.tesla.telemetryRecoveryPollMs;
  }

  /**
   * Prefer the free telemetry hint. Direct vehicle_data is only on the
   * slow recovery gap (or one probe when the user just enabled solar).
   * There is no per-cycle poll while charging-power fields are briefly
   * stale — that fallback is on the same gap, because Data calls are billed.
   */
  private async resolveVehicleState(): Promise<VehicleChargeState | null> {
    if (!this.tesla.getVehicleTag()) {
      // No dashboard pick yet (and none persisted). Do not invent a default
      // VIN — leave the car unset and skip Tesla contact for this cycle.
      this.haveFreshControlState = false;
      this.status.decision = "unavailable";
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
      this.status.telemetryLastSeenAt = null;
      return null;
    }

    const now = Date.now();
    const hint = this.telemetry?.getHint(this.tesla.getVehicleTag());
    const hintFresh = this.isHintFresh(hint, now);
    this.status.telemetryLastSeenAt = hint?.lastSeenAt ?? null;

    const plan = this.recoveryPlan(now, hintFresh);
    this.publishTeslaWait(plan);

    if (plan.wait === "rate_limited" || plan.wait === "budget" || plan.wait === "quiet_hours") {
      this.haveFreshControlState = hintFresh && plan.wait !== "rate_limited";
      // Budget hold still shows telemetry, but decide() must not command
      // unless this tick holds the one session credit (armed on the paid call).
      if (plan.wait !== "budget") this.haveFreshControlState = false;
      return hintFresh ? this.buildStateFromHint(hint) : this.lastPolledVehicle;
    }

    if (!this.status.override.enabled) {
      // No polls or wakes while the switch is off, so a stuck car cannot
      // lock the dashboard. decide() may still send one stop so the car
      // does not keep charging. Free telemetry still updates the display.
      this.haveFreshControlState = hintFresh;
      return hintFresh ? this.buildStateFromHint(hint) : this.lastPolledVehicle;
    }

    // Tesla only pushes DetailedChargeState/ChargePortDoorOpen on *change*,
    // not periodically - so right after a restart (hint map starts empty),
    // a vehicle that's been steadily "Charging" the whole time won't get a
    // fresh push until its state actually changes, potentially for the
    // rest of the session. Meanwhile other fields (ACChargingPower) that do
    // change continuously keep refreshing lastSeenAt, which would make a
    // pure time-based check see this as "fresh" despite chargingState still
    // being unknown - requiring a known chargingState too routes that case
    // into the poll fallback below instead of treating an actively-charging
    // vehicle as unplugged/idle.
    if (hintFresh && hint.chargingState === "Charging") {
      this.chargeStartConfirmPending = false;
      const chargingDataFresh =
        hint.chargingDataLastSeenAt !== null &&
        now - hint.chargingDataLastSeenAt.getTime() <= config.tesla.telemetryChargingStaleMs;
      const chargingPollDue =
        !chargingDataFresh &&
        (this.lastFallbackAttemptAt <= 0 || now - this.lastFallbackAttemptAt >= config.tesla.telemetryRecoveryPollMs);

      if (chargingPollDue && this.armPaidCall()) {
        const polled = await this.pollDirect();
        if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil) {
          this.haveFreshControlState = false;
          this.publishBlockStatus();
          return this.lastPolledVehicle;
        }
        if (polled) {
          this.haveFreshControlState = true;
          this.status.teslaWait = "none";
          this.status.nextTeslaAttemptAt = null;
          return polled;
        }
      }

      this.haveFreshControlState = true;
      if (this.status.teslaWait !== "rate_limited" && this.status.teslaWait !== "budget") {
        this.status.teslaWait = "none";
        this.status.nextTeslaAttemptAt = null;
      }
      return this.buildStateFromHint(hint);
    }

    // After charge_start, do not trust a fresh Stopped hint or the recovery
    // gap — confirm with vehicle_data (or keep the optimistic Starting
    // snapshot) until the car reports Charging.
    if (this.chargeStartConfirmPending) {
      return this.pollForChargeStartConfirm();
    }

    if (hintFresh) {
      this.haveFreshControlState = true;
      this.sessionProbePending = false;
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
      return this.buildStateFromHint(hint);
    }

    return this.pollForRecovery(plan);
  }

  /**
   * One vehicle_data read to replace the optimistic Starting snapshot with
   * live charge fields. If Tesla still says Stopped (common for a few
   * seconds after charge_start), keep Starting and try again next tick.
   */
  private async pollForChargeStartConfirm(): Promise<VehicleChargeState | null> {
    if (!this.armPaidCall()) {
      this.haveFreshControlState = false;
      this.publishBlockStatus();
      return this.lastPolledVehicle;
    }

    const polled = await this.pollDirect();
    if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil) {
      this.haveFreshControlState = false;
      this.publishBlockStatus();
      return this.lastPolledVehicle;
    }

    if (polled && (polled.chargingState === "Charging" || polled.chargingState === "Starting")) {
      this.chargeStartConfirmPending = false;
      this.haveFreshControlState = true;
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
      return polled;
    }

    // Still Stopped / unreachable — keep Starting on screen so the dash
    // does not freeze on the pre-start Stopped / 0 V / 0 A reading.
    this.markChargingStarting();
    this.haveFreshControlState = false;
    this.status.teslaWait = "none";
    this.status.nextTeslaAttemptAt = null;
    return this.lastPolledVehicle;
  }

  private isHintFresh(hint: TelemetryHint | undefined, now: number): hint is TelemetryHint {
    return (
      hint !== undefined &&
      hint.chargingState !== "Unknown" &&
      now - hint.lastSeenAt.getTime() <= config.tesla.telemetryStaleMs
    );
  }

  private budgetHoldActive(): boolean {
    return budgetBlocksPaidCalls({
      mode: config.tesla.apiBudgetMode,
      now: Date.now(),
      budgetUntil: this.budgetUntil,
      sessionCredit: false,
      sessionBundleOpen: false,
    });
  }

  /** True if a billed call may proceed. Consumes the one-shot session credit. */
  private armPaidCall(): boolean {
    if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil) return false;
    if (
      budgetBlocksPaidCalls({
        mode: config.tesla.apiBudgetMode,
        now: Date.now(),
        budgetUntil: this.budgetUntil,
        sessionCredit: this.sessionCredit,
        sessionBundleOpen: this.sessionBundleOpen,
      })
    ) {
      return false;
    }
    if (this.budgetHoldActive() && this.sessionCredit) {
      this.sessionCredit = false;
      this.sessionBundleOpen = true;
    }
    return true;
  }

  private recoveryPlan(now: number, telemetryFresh: boolean): RecoveryPlan {
    return planRecovery({
      now,
      solarEnabled: this.status.override.enabled,
      telemetryFresh,
      lastFallbackAttemptAt: this.lastFallbackAttemptAt,
      lastWakeAttemptAt: this.lastWakeAttemptAt,
      consecutiveFailures: this.consecutiveFailures,
      recoveryPollMs: config.tesla.telemetryRecoveryPollMs,
      rateLimitedUntil: this.rateLimitedUntil,
      authPausedUntil: this.authPausedUntil,
      budgetBlocked: budgetBlocksPaidCalls({
        mode: config.tesla.apiBudgetMode,
        now,
        budgetUntil: this.budgetUntil,
        sessionCredit: this.sessionCredit,
        sessionBundleOpen: this.sessionBundleOpen,
      }),
      sessionProbePending: this.sessionProbePending,
      suppressWake: this.suppressWake,
      knownAwake: this.recentlyAwake(),
      quietHours: this.isWithinQuietHours(now),
      budgetUntil: this.budgetUntil,
    });
  }

  private publishBlockStatus(): void {
    const now = Date.now();
    const rateUntil = this.rateLimitedUntil > now ? this.rateLimitedUntil : 0;
    const authUntil = this.authPausedUntil > now ? this.authPausedUntil : 0;
    const budget = this.budgetHoldActive();
    const budgetUntil = budget && this.budgetUntil > now ? this.budgetUntil : 0;
    this.status.apiBudgetActive = budget;
    this.status.targetAmps = null;
    this.haveFreshControlState = false;
    this.status.decision = "unavailable";
    this.status.statusNote = null;
    this.status.rateLimitedUntil = rateUntil ? new Date(rateUntil) : null;

    // Count down to whichever hold actually ends last. A billing pause must
    // not replace a 403/429 window with a shorter one, and a 403 window must
    // not hide a longer billing pause. An auth-edge denial is labeled auth,
    // not rate limited.
    const effectiveUntil = Math.max(rateUntil, budgetUntil, authUntil);
    const showBudget = budget && (config.tesla.apiBudgetMode === "on" || budgetUntil >= Math.max(rateUntil, authUntil));
    if (showBudget) {
      this.status.teslaWait = "budget";
      this.status.nextTeslaAttemptAt = effectiveUntil > now ? new Date(effectiveUntil) : null;
      return;
    }
    if (rateUntil && rateUntil >= authUntil) {
      this.status.teslaWait = "rate_limited";
      this.status.nextTeslaAttemptAt = new Date(rateUntil);
      return;
    }
    if (authUntil) {
      this.status.teslaWait = "auth";
      this.status.nextTeslaAttemptAt = new Date(authUntil);
    }
  }

  private publishTeslaWait(plan: RecoveryPlan): void {
    if (plan.wait === "rate_limited" || plan.wait === "budget" || plan.wait === "auth") {
      this.publishBlockStatus();
      if (plan.wait === "budget" && plan.nextAttemptAt) {
        this.status.nextTeslaAttemptAt = new Date(plan.nextAttemptAt);
      }
      return;
    }
    if (this.rateLimitedUntil <= Date.now()) this.status.rateLimitedUntil = null;
    this.status.apiBudgetActive = this.budgetHoldActive();
    this.status.teslaWait = plan.wait;
    this.status.nextTeslaAttemptAt = plan.nextAttemptAt === null ? null : new Date(plan.nextAttemptAt);
  }

  /**
   * Drop a waking/asleep countdown the moment the user asks for contact.
   * The tick that follows may put a new countdown up only after that
   * immediate probe (and its one wake) have finished.
   */
  private clearRecoveryCountdown(): void {
    if (
      this.status.teslaWait === "waking" ||
      this.status.teslaWait === "asleep" ||
      this.status.teslaWait === "none"
    ) {
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
    }
  }

  /**
   * Poll (and maybe wake once) when telemetry has no fresh hint.
   * haveFreshControlState is true only when this call actually got a reading,
   * so later ticks don't keep commanding off the cached snapshot.
   */
  private async pollForRecovery(plan: RecoveryPlan): Promise<VehicleChargeState | null> {
    if (!plan.shouldPoll) {
      this.haveFreshControlState = false;
      return this.lastPolledVehicle;
    }
    if (!this.armPaidCall()) {
      this.haveFreshControlState = false;
      this.publishBlockStatus();
      return this.lastPolledVehicle;
    }

    // Remember this before clearing the flag. A user enable polls now and,
    // if the car does not answer, wakes once even when the last wake was
    // inside the recovery gap. The next automatic cycle does not.
    const userInitiated = this.sessionProbePending;
    this.sessionProbePending = false;

    const polled = await this.pollDirect();
    if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil || this.budgetHoldActive()) {
      this.haveFreshControlState = false;
      this.suppressWake = true;
      this.persistHolds();
      this.publishBlockStatus();
      return this.lastPolledVehicle;
    }

    if (polled) {
      this.haveFreshControlState = true;
      this.consecutiveFailures = 0;
      this.suppressWake = false;
      this.status.teslaWait = "none";
      this.status.nextTeslaAttemptAt = null;
      this.persistHolds();
      return polled;
    }

    // The read failed for a non-hold reason (typically asleep). A user
    // enable gets that wake immediately. Automatic retries still wait out
    // the recovery gap, and a 403/429 never wakes.
    if (!this.suppressWake && !this.recentlyAwake() && (userInitiated || this.wakeGapElapsed())) {
      await this.wakeOnce();
      if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil || this.budgetHoldActive()) {
        this.haveFreshControlState = false;
        this.suppressWake = true;
        this.persistHolds();
        this.publishBlockStatus();
        return this.lastPolledVehicle;
      }
    }
    this.suppressWake = false;

    this.haveFreshControlState = false;
    const followUp = this.recoveryPlan(Date.now(), false);
    this.publishTeslaWait(followUp);
    return this.lastPolledVehicle;
  }

  private wakeGapElapsed(): boolean {
    if (this.lastWakeAttemptAt <= 0) return true;
    return Date.now() - this.lastWakeAttemptAt >= config.tesla.telemetryRecoveryPollMs;
  }

  /** One wake_up. The caller already decided it is due. */
  private async wakeOnce(): Promise<boolean> {
    if (!this.armPaidCall()) return false;
    this.lastWakeAttemptAt = Date.now();
    try {
      await this.tesla.wakeUp();
      return true;
    } catch (err) {
      this.observeTeslaError("wake_up", err);
      if (!(err instanceof TeslaApiError) || (err.status !== 403 && err.status !== 429)) {
        log.debug({ err: String(err) }, "wake_up failed");
      }
      return false;
    }
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

  /**
   * True during the configured overnight window (e.g. 19:00-07:00
   * Australia/Sydney), computed in QUIET_HOURS_TIMEZONE rather than the
   * server's own clock (typically UTC on a cloud VM). Unset QUIET_HOURS_START
   * disables the feature entirely (always false).
   */
  private isWithinQuietHours(now: number): boolean {
    if (!config.tesla.quietHoursStart || !config.tesla.quietHoursEnd) return false;

    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: config.tesla.quietHoursTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(now));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const nowMinutes = hour * 60 + minute;

    const [startH, startM] = config.tesla.quietHoursStart.split(":").map(Number);
    const [endH, endM] = config.tesla.quietHoursEnd.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes === endMinutes) return false;
    if (startMinutes < endMinutes) {
      // Same-day window (e.g. 09:00-17:00).
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Wraps midnight (e.g. 19:00-07:00).
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  private async pollDirect(): Promise<VehicleChargeState | null> {
    const startedAt = Date.now();
    this.lastFallbackAttemptAt = startedAt;
    try {
      const vehicle = await this.tesla.getChargeState();
      this.lastPolledVehicle = vehicle;
      this.consecutiveFailures = 0;
      // A poll that started after set_charge_limit has the car's real
      // charge_limit_soc. Trust it and stop holding the commanded value.
      // A poll that was already in flight does not — its snapshot predates
      // the command.
      if (this.commandedChargeLimit && startedAt > this.commandedChargeLimit.at) {
        this.telemetry?.noteObservedChargeLimit(this.tesla.getVehicleTag(), vehicle.chargeLimitSoc);
        this.commandedChargeLimit = null;
      }
      // Backfill telemetry's chargingState/pluggedIn from this authoritative
      // read if telemetry hasn't reported them yet (see the post-restart
      // gap explained in resolveVehicleState) - lets subsequent cycles use
      // the telemetry-driven branch instead of polling again next tick.
      this.telemetry?.seedChargingState(this.tesla.getVehicleTag(), vehicle.chargingState, vehicle.pluggedIn);
      return vehicle;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (err instanceof TeslaApiError && classifyTeslaBlock(err.status, err.message)) {
        this.observeTeslaError("vehicle_data", err);
        return null;
      }

      log.warn({ err: String(err) }, "Vehicle unreachable this cycle");
      return null;
    }
  }

  private ampsAvailable(surplusW: number, vehicle: VehicleChargeState): number {
    const evDrawW = vehicle.chargerVoltage * vehicle.chargerActualCurrent;
    return wattsToAmps(surplusW + evDrawW);
  }

  private async decide(surplusW: number, vehicle: VehicleChargeState | null, solarStale: boolean): Promise<void> {
    this.status.statusNote = null;
    if (!this.status.override.enabled) {
      // The charging switch is the only off control. Off stops the car and
      // does not start it again while surplus is high. On follows the sun.
      await this.holdChargeOff(vehicle ?? this.status.vehicle);
      return;
    }
    if (this.isWithinQuietHours(Date.now())) {
      // Mirrors resolveVehicleState's blackout - never issue a command
      // (stop/start/set-amps) during quiet hours either, off cached state.
      this.status.decision = "idle";
      this.status.targetAmps = null;
      return;
    }

    if (Date.now() < this.rateLimitedUntil || Date.now() < this.authPausedUntil) {
      // Don't issue commands (stop/start/set-amps) off a stale cached
      // vehicle reading either - those are Tesla calls too, and firing
      // them into an active cooldown just adds more blocked requests.
      this.publishBlockStatus();
      return;
    }

    if (
      budgetBlocksPaidCalls({
        mode: config.tesla.apiBudgetMode,
        now: Date.now(),
        budgetUntil: this.budgetUntil,
        sessionCredit: this.sessionCredit,
        sessionBundleOpen: this.sessionBundleOpen,
      })
    ) {
      this.publishBlockStatus();
      return;
    }

    if (!vehicle) {
      // No live car reading. Do not start or raise amps off a stale
      // snapshot — that billed thousands of commands. Do stop if the last
      // reading was Charging and surplus cannot hold the minimum rate, so
      // a phone that still shows the old 12 A does not leave the car there
      // while solar is under the threshold.
      if (await this.stopStaleChargeIfUnsustainable(surplusW)) return;
      this.status.decision = "unavailable";
      return;
    }

    // Mirrors the "Complete" handling below: once the car is unplugged
    // there's nothing left for solar charging to do until it's plugged back
    // in, so turn the automation off instead of leaving it idling and still
    // paying for telemetry/poll cycles against a car that isn't there.
    if (!vehicle.pluggedIn) {
      log.info({ vehicleTag: this.status.vehicleTag }, "Vehicle unplugged - turning off solar charging automation");
      this.status.decision = "idle";
      this.status.targetAmps = null;
      this.aboveStartThresholdCount = 0;
      this.belowStopThresholdCount = 0;
      this.setEnabled(false, "auto:unplugged");
      return;
    }

    // Trust the vehicle's own reported state, not our memory of what commands
    // we've sent - a command can silently fail to reach the car (e.g. asleep,
    // signed-command proxy timeout) and we'd otherwise get stuck believing
    // it's charging when it never started. "Starting" is the optimistic /
    // mid-handshake state after a successful charge_start (and Tesla's own
    // DetailedChargeStateStarting) — treat it as an active session so we
    // do not leave the dash on Stopped while the car is already drawing.
    const currentlyCharging =
      vehicle.chargingState === "Charging" || vehicle.chargingState === "Starting";

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
      this.emit("notify", {
        title: "Charging complete",
        body: `${this.status.vehicleTag} finished charging at ${Math.round(vehicle.batteryLevel)}%. Solar charging turned off.`,
      });
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
    const ampsAvailable = this.ampsAvailable(surplusW, vehicle);

    // Ramp amps down as the available surplus shrinks; only stop outright
    // once even the minimum charge rate isn't sustainable for a couple of
    // consecutive polls, rather than cutting straight to zero the moment
    // the balance dips negative. While we are still confirming a start,
    // chargerVoltage/current are often still 0, so surplus looks too low
    // (house load already includes the car) — do not count that as a stop.
    if (ampsAvailable < config.minChargeAmps) {
      if (vehicle.chargingState === "Starting" || this.chargeStartConfirmPending) {
        this.belowStopThresholdCount = 0;
      } else {
        this.belowStopThresholdCount += 1;
      }
    } else {
      this.belowStopThresholdCount = 0;
    }

    if (this.belowStopThresholdCount >= config.stableCyclesToStop) {
      const stopped = await this.sendStop();
      if (stopped === "blocked") {
        this.publishBlockStatus();
        return;
      }
      if (stopped === "sent" || stopped === "held") {
        this.status.decision = "idle";
        this.status.targetAmps = null;
        this.aboveStartThresholdCount = 0;
        if (stopped === "held") this.status.statusNote = this.holdNote("Stop already sent", this.lastStopCommandAt);
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
    this.status.targetAmps = Math.round(amps);
    const ampResult = await this.sendAmps(amps, vehicle.chargeAmps);
    if (ampResult === "blocked") {
      this.publishBlockStatus();
      return;
    }
    if (ampResult === "held") this.status.statusNote = this.holdNote("Charge rate already sent", this.lastAmpCommandAt);
  }

  /**
   * Charging switch is off. Stop a car that is still charging, and do not
   * start one, even when solar surplus is high. Rate-limit and billing
   * holds still block the stop command.
   */
  private async holdChargeOff(known: VehicleChargeState | null): Promise<void> {
    this.status.decision = "idle";
    this.status.targetAmps = null;
    this.aboveStartThresholdCount = 0;
    const charging = known?.chargingState === "Charging" || known?.chargingState === "Starting";
    if (!charging) return;
    const stopped = await this.sendStop();
    if (stopped === "blocked") {
      this.publishBlockStatus();
      return;
    }
    if (stopped === "held") this.status.statusNote = this.holdNote("Stop already sent", this.lastStopCommandAt);
    else if (stopped === "sent") {
      this.status.statusNote = "Charging stopped";
      this.markChargingStopped();
    } else this.status.statusNote = "Stop did not reach the car";
  }

  private markChargingStopped(): void {
    this.chargeStartConfirmPending = false;
    const stopped = (vehicle: VehicleChargeState): VehicleChargeState => ({
      ...vehicle,
      chargingState: "Stopped",
      chargeAmps: 0,
      chargerActualCurrent: 0,
    });
    if (this.status.vehicle) this.status.vehicle = stopped(this.status.vehicle);
    if (this.lastPolledVehicle) this.lastPolledVehicle = stopped(this.lastPolledVehicle);
  }

  /**
   * Optimistic mirror of markChargingStopped after a successful charge_start.
   * Keeps State off the pre-start Stopped snapshot until vehicle_data or
   * telemetry confirms Charging (often several seconds later).
   */
  private markChargingStarting(): void {
    const patch = (vehicle: VehicleChargeState): VehicleChargeState => ({
      ...vehicle,
      chargingState: "Starting",
      timestamp: new Date(),
    });
    if (this.status.vehicle) this.status.vehicle = patch(this.status.vehicle);
    if (this.lastPolledVehicle) this.lastPolledVehicle = patch(this.lastPolledVehicle);
    else if (this.status.vehicle) this.lastPolledVehicle = this.status.vehicle;
  }

  /**
   * Last known state says the car is charging, and this surplus cannot
   * support the minimum amps. Count toward the same stop threshold the
   * live path uses, then send one stop. A stale Stopped car is ignored.
   */
  private async stopStaleChargeIfUnsustainable(surplusW: number): Promise<boolean> {
    if (!this.status.override.enabled) return false;
    const last = this.status.vehicle;
    if (!last || (last.chargingState !== "Charging" && last.chargingState !== "Starting")) return false;
    // Recent charge_start: keep decision=charging and do not stop off a
    // Starting snapshot with 0 A — real draw is missing from the reading.
    if (
      this.chargeStartConfirmPending ||
      last.chargingState === "Starting" ||
      (this.lastStartCommandAt > 0 && Date.now() - this.lastStartCommandAt < config.tesla.telemetryRecoveryPollMs)
    ) {
      this.belowStopThresholdCount = 0;
      this.status.decision = "charging";
      this.status.statusNote = null;
      return true;
    }
    if (this.ampsAvailable(surplusW, last) >= config.minChargeAmps) {
      this.belowStopThresholdCount = 0;
      this.status.decision = "charging";
      // Keep the bar free for the next-check countdown; do not narrate the hold.
      this.status.statusNote = null;
      return true;
    }
    this.belowStopThresholdCount += 1;
    this.status.decision = "charging";
    if (this.belowStopThresholdCount < config.stableCyclesToStop) {
      this.status.statusNote = "Solar under minimum — stop if this holds";
      return true;
    }
    const stopped = await this.sendStop();
    if (stopped === "blocked") {
      this.publishBlockStatus();
      return true;
    }
    if (stopped === "sent" || stopped === "held") {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      this.aboveStartThresholdCount = 0;
      this.status.statusNote =
        stopped === "held"
          ? this.holdNote("Stop already sent", this.lastStopCommandAt)
          : "Solar under minimum — charging stopped";
    }
    return true;
  }

  private explicitSession = false;

  private commandGapOpen(lastAt: number): boolean {
    // The tick the user turned solar on may send the one start/stop/amp
    // bundle even if a previous attempt was recent. Every later tick waits.
    if (this.explicitSession || this.sessionBundleOpen) return true;
    return commandGapElapsed(Date.now(), lastAt, config.tesla.commandMinIntervalMs);
  }

  private holdNote(prefix: string, lastAt: number): string {
    const leftMs = Math.max(0, lastAt + config.tesla.commandMinIntervalMs - Date.now());
    const secs = Math.round(leftMs / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${prefix} · next command in ${m}m ${String(s).padStart(2, "0")}s` : `${prefix} · next command in ${s}s`;
  }

  private async applyCharge(amps: number, vehicle: VehicleChargeState | null): Promise<boolean> {
    if (vehicle?.chargingState !== "Charging" && vehicle?.chargingState !== "Starting") {
      const started = await this.sendStart();
      if (started === "blocked") {
        this.publishBlockStatus();
        return false;
      }
      if (started === "failed") return false;
      if (started === "held") {
        // Start already went out recently — keep the optimistic Starting
        // snapshot and treat the session as underway for this tick.
        this.markChargingStarting();
        this.chargeStartConfirmPending = true;
        this.status.statusNote = this.holdNote("Start already sent", this.lastStartCommandAt);
      }
    }
    const ampResult = await this.sendAmps(amps, vehicle?.chargeAmps ?? Number.NaN);
    if (ampResult === "blocked") {
      this.publishBlockStatus();
      return false;
    }
    if (ampResult === "held") this.status.statusNote = this.holdNote("Charge rate already sent", this.lastAmpCommandAt);
    return ampResult === "sent" || ampResult === "unchanged" || ampResult === "held";
  }

  private async sendStart(): Promise<"sent" | "held" | "blocked" | "failed"> {
    if (!this.armPaidCall()) return "blocked";
    if (!this.commandGapOpen(this.lastStartCommandAt)) return "held";
    this.lastStartCommandAt = Date.now();
    try {
      await this.tesla.startCharging();
      // Mirror markChargingStopped: patch display immediately, then try one
      // vehicle_data confirm so State / volts / amps leave the pre-start
      // Stopped snapshot even when fleet telemetry is silent.
      this.markChargingStarting();
      this.chargeStartConfirmPending = true;
      await this.confirmChargeStartAfterCommand();
      return "sent";
    } catch (err) {
      this.observeTeslaError("charge_start", err);
      log.warn({ err: String(err) }, "applyCharge failed");
      this.status.lastError = `Failed to start charging: ${err instanceof Error ? err.message : String(err)}`;
      return "failed";
    }
  }

  /**
   * Best-effort vehicle_data right after charge_start. Failures leave
   * chargeStartConfirmPending set so the next tick retries.
   */
  private async confirmChargeStartAfterCommand(): Promise<void> {
    if (!this.armPaidCall()) return;
    const polled = await this.pollDirect();
    if (!polled) return;
    if (polled.chargingState === "Charging" || polled.chargingState === "Starting") {
      this.chargeStartConfirmPending = false;
      this.status.vehicle = polled;
      this.haveFreshControlState = true;
      return;
    }
    // Tesla often still reports Stopped for a few seconds after accepting
    // charge_start — keep Starting and confirm on a later tick.
    this.markChargingStarting();
  }

  private async sendStop(): Promise<"sent" | "held" | "blocked" | "failed"> {
    if (!this.armPaidCall()) return "blocked";
    if (!this.commandGapOpen(this.lastStopCommandAt)) return "held";
    this.lastStopCommandAt = Date.now();
    try {
      await this.tesla.stopCharging();
      this.chargeStartConfirmPending = false;
      return "sent";
    } catch (err) {
      this.observeTeslaError("charge_stop", err);
      log.warn({ err: String(err) }, "stop failed");
      this.status.lastError = `Failed to stop charging: ${err instanceof Error ? err.message : String(err)}`;
      return "failed";
    }
  }

  private async sendAmps(
    targetAmps: number,
    reportedAmps: number
  ): Promise<"sent" | "unchanged" | "held" | "blocked" | "failed"> {
    if (!ampCommandNeeded(targetAmps, reportedAmps, this.lastCommandedAmps)) return "unchanged";
    if (!this.armPaidCall()) return "blocked";
    if (!this.commandGapOpen(this.lastAmpCommandAt)) return "held";
    const rounded = Math.round(targetAmps);
    this.lastAmpCommandAt = Date.now();
    try {
      await this.tesla.setChargeAmps(rounded);
      // Only remember a command Tesla accepted. A failure must stay eligible
      // for one retry after the gap — marking it commanded would skip that forever.
      this.lastCommandedAmps = rounded;
      if (this.status.vehicle) this.status.vehicle = { ...this.status.vehicle, chargeAmps: rounded };
      if (this.lastPolledVehicle) this.lastPolledVehicle = { ...this.lastPolledVehicle, chargeAmps: rounded };
      return "sent";
    } catch (err) {
      this.observeTeslaError("set_charging_amps", err);
      log.warn({ err: String(err) }, "amps failed");
      this.status.lastError = `Failed to adjust charge amps: ${err instanceof Error ? err.message : String(err)}`;
      return "failed";
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
