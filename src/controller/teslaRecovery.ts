/**
 * Cost gates for Tesla Fleet API calls.
 *
 * Oct 2026 billing (Ashton): the $16 monthly discount was used up, mostly by
 * Commands (6,383 / $9.96), then Data (1,220 / $3.81) and Wakes (52 / $1.62).
 * Streaming telemetry was the cheap path. Nothing in here may poll, wake, or
 * command faster than the configured recovery / command gaps, except one
 * explicit session: the user turned solar charging on (or picked a vehicle).
 * That session polls vehicle_data immediately, and if the car does not
 * answer, wakes once — even inside the recovery gap. Later automatic
 * retries keep the gap. A non-billing 403 still uses the full cooldown.
 * Billing EXCEEDED_LIMIT / 402 does not. `shouldWake` here is only the
 * automatic schedule; the enable-time wake is applied in pollForRecovery
 * so we probe first and wake only if that probe gets nothing.
 */

export type TeslaWait = "none" | "waking" | "asleep" | "rate_limited" | "budget" | "auth" | "quiet_hours";

export type TeslaBlock = "billing" | "rate_limit" | "auth";

/**
 * EXCEEDED_LIMIT and HTTP 402 are the Fleet billing cap.
 * HTML "Access Denied" is the auth edge (auth.tesla.com WAF), not a vehicle rate limit.
 * A plain 429 is a transient rate limit. Other 403s keep the long cooldown.
 */
export function classifyTeslaBlock(status: number, message: string): TeslaBlock | null {
  const text = message.toLowerCase();
  if (
    status === 402 ||
    /exceeded_limit|billing|payment required|quota exceeded|spending limit|monthly limit|developer billing|insufficient fund/.test(
      text
    )
  ) {
    return "billing";
  }
  if (status === 403 && (/access denied/.test(text) || /<html/.test(text) || /edgesuite/.test(text))) {
    return "auth";
  }
  if (status === 403 || status === 429) return "rate_limit";
  return null;
}

/** True when a set_charging_amps call would change something Tesla doesn't already have. */
export function ampCommandNeeded(
  targetAmps: number,
  reportedAmps: number,
  _lastCommandedAmps: number | null
): boolean {
  if (!Number.isFinite(targetAmps)) return false;
  const target = Math.round(targetAmps);
  if (Number.isFinite(reportedAmps) && target === Math.round(reportedAmps)) return false;
  return true;
}

/** Same integer target as the last amps Tesla accepted — throttle at commandMinIntervalMs. */
export function ampCommandIsIdenticalRepeat(targetAmps: number, lastCommandedAmps: number | null): boolean {
  if (lastCommandedAmps === null || !Number.isFinite(lastCommandedAmps)) return false;
  return Math.round(targetAmps) === Math.round(lastCommandedAmps);
}

export function commandGapElapsed(now: number, lastAt: number, minIntervalMs: number): boolean {
  if (lastAt <= 0) return true;
  return now - lastAt >= minIntervalMs;
}

export function ampSendGapOpen(input: {
  now: number;
  lastAmpCommandAt: number;
  lastAmpAcceptedAt: number;
  commandMinIntervalMs: number;
  ampChangeMinIntervalMs: number;
  commandFailureBackoffMs: number;
  targetAmps: number;
  lastCommandedAmps: number | null;
  lastAmpAttemptSucceeded: boolean;
  sessionBundleOpen: boolean;
  explicitSession: boolean;
}): boolean {
  if (input.explicitSession || input.sessionBundleOpen) return true;
  if (ampCommandIsIdenticalRepeat(input.targetAmps, input.lastCommandedAmps)) {
    return commandGapElapsed(input.now, input.lastAmpCommandAt, input.commandMinIntervalMs);
  }
  if (!input.lastAmpAttemptSucceeded && input.lastAmpCommandAt > 0) {
    return commandGapElapsed(input.now, input.lastAmpCommandAt, input.commandFailureBackoffMs);
  }
  return commandGapElapsed(input.now, input.lastAmpAcceptedAt, input.ampChangeMinIntervalMs);
}

export function startStopSendGapOpen(input: {
  now: number;
  lastCommandAt: number;
  commandMinIntervalMs: number;
  commandFailureBackoffMs: number;
  lastAttemptSucceeded: boolean;
  sessionBundleOpen: boolean;
  explicitSession: boolean;
}): boolean {
  if (input.explicitSession || input.sessionBundleOpen) return true;
  const gapMs = input.lastAttemptSucceeded ? input.commandMinIntervalMs : input.commandFailureBackoffMs;
  return commandGapElapsed(input.now, input.lastCommandAt, gapMs);
}

export function budgetBlocksPaidCalls(input: {
  mode: "auto" | "on" | "off";
  now: number;
  budgetUntil: number;
  sessionCredit: boolean;
  sessionBundleOpen: boolean;
}): boolean {
  if (input.mode === "off") return false;
  const hold = input.mode === "on" || input.budgetUntil > input.now;
  if (!hold) return false;
  return !input.sessionCredit && !input.sessionBundleOpen;
}

export function isVehicleDataUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/timed out after/i.test(err.message)) return true;
  const status = (err as { status?: number }).status;
  if (status === 408 || status === 504) return true;
  const msg = err.message.toLowerCase();
  if (/asleep|vehicle unavailable|could not wake/i.test(msg)) return true;
  if (msg.includes("http 408") || msg.includes("http 504")) return true;
  return false;
}

export function vehicleDataDayKey(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

export function dailyVehicleDataCapReached(countToday: number, dailyCap: number): boolean {
  if (dailyCap <= 0) return false;
  return countToday >= dailyCap;
}

export interface ChargeStartConfirmInput {
  now: number;
  pending: boolean;
  attempts: number;
  firstAttemptAt: number;
  lastFallbackAttemptAt: number;
  recoveryPollMs: number;
  maxAttempts: number;
  maxDurationMs: number;
}

/** Whether charge_start confirmation may spend another vehicle_data (gap + cap). */
export function chargeStartConfirmShouldPoll(input: ChargeStartConfirmInput): boolean {
  if (!input.pending) return false;
  if (input.attempts >= input.maxAttempts) return false;
  if (input.firstAttemptAt > 0 && input.now - input.firstAttemptAt > input.maxDurationMs) return false;
  const gap = Math.max(input.recoveryPollMs, 1);
  const since =
    input.lastFallbackAttemptAt <= 0 ? Number.POSITIVE_INFINITY : input.now - input.lastFallbackAttemptAt;
  return since >= gap;
}

export function chargeStartConfirmCapReached(input: ChargeStartConfirmInput): boolean {
  if (!input.pending) return false;
  if (input.attempts >= input.maxAttempts) return true;
  if (input.firstAttemptAt > 0 && input.now - input.firstAttemptAt > input.maxDurationMs) return true;
  return false;
}

/** Skip paid vehicle_data when streaming or last snapshot says unplugged / away. */
export function shouldSkipVehicleDataPoll(input: {
  telemetryHint?: { pluggedIn: boolean; chargingState: string; lastSeenAt: Date } | null;
  telemetryStaleMs: number;
  now: number;
  lastPolled?: { pluggedIn: boolean; chargingState: string; timestamp: Date } | null;
  recoveryPollMs: number;
}): boolean {
  const hint = input.telemetryHint;
  if (hint && input.now - hint.lastSeenAt.getTime() <= input.telemetryStaleMs) {
    if (!hint.pluggedIn || hint.chargingState === "Disconnected") return true;
  }
  const last = input.lastPolled;
  if (last && !last.pluggedIn) {
    const age = input.now - new Date(last.timestamp).getTime();
    if (age >= -5_000 && age <= input.recoveryPollMs) return true;
  }
  if (last?.chargingState === "Disconnected") {
    const age = input.now - new Date(last.timestamp).getTime();
    if (age >= -5_000 && age <= input.recoveryPollMs) return true;
  }
  return false;
}

/** Fresh telemetry shows the car is plugged in — may contact vehicle_data again. */
export function telemetryResumesVehicleDataPoll(
  hint: { pluggedIn: boolean; chargingState: string; lastSeenAt: Date } | undefined,
  now: number,
  telemetryStaleMs: number
): boolean {
  if (!hint) return false;
  if (now - hint.lastSeenAt.getTime() > telemetryStaleMs) return false;
  return hint.pluggedIn && hint.chargingState !== "Disconnected";
}

export interface RecoveryPlanInput {
  now: number;
  solarEnabled: boolean;
  telemetryFresh: boolean;
  lastFallbackAttemptAt: number;
  lastWakeAttemptAt: number;
  /** Failures since the last successful vehicle_data. Wake stays off once this is > 0. */
  consecutiveFailures: number;
  recoveryPollMs: number;
  rateLimitedUntil: number;
  authPausedUntil?: number;
  budgetBlocked: boolean;
  /**
   * User just turned solar on, or switched vehicle, and telemetry has no
   * fresh hint. One immediate vehicle_data poll inside the recovery gap.
   * The wake that may follow that probe is decided in pollForRecovery.
   */
  sessionProbePending: boolean;
  /** Set after a hold. The next probe must not call wake_up. */
  suppressWake?: boolean;
  /** Last snapshot already showed the car online or charging. */
  knownAwake?: boolean;
  quietHours: boolean;
  /** When the budget hold ends. 0 if the hold is indefinite (mode forced on). */
  budgetUntil: number;
  /**
   * After vehicle_data fails (408/asleep/timeout/etc.) automatic polls stop
   * until telemetry shows plugged-in activity or the owner turns solar on.
   */
  vehicleDataPaused?: boolean;
}

export interface RecoveryPlan {
  shouldPoll: boolean;
  shouldWake: boolean;
  wait: TeslaWait;
  nextAttemptAt: number | null;
}

/**
 * Direct vehicle_data schedule while telemetry is stale. Never wakes the car.
 * After a failed read, polls stop until telemetry or a user enable (`sessionProbePending`).
 */
export function planRecovery(input: RecoveryPlanInput): RecoveryPlan {
  if (input.rateLimitedUntil > input.now) {
    return {
      shouldPoll: false,
      shouldWake: false,
      wait: "rate_limited",
      nextAttemptAt: input.rateLimitedUntil,
    };
  }
  if ((input.authPausedUntil ?? 0) > input.now) {
    return {
      shouldPoll: false,
      shouldWake: false,
      wait: "auth",
      nextAttemptAt: input.authPausedUntil ?? null,
    };
  }
  if (input.budgetBlocked) {
    return {
      shouldPoll: false,
      shouldWake: false,
      wait: "budget",
      nextAttemptAt: input.budgetUntil > input.now ? input.budgetUntil : null,
    };
  }
  if (input.quietHours || !input.solarEnabled || input.telemetryFresh) {
    return {
      shouldPoll: false,
      shouldWake: false,
      wait: input.quietHours ? "quiet_hours" : "none",
      nextAttemptAt: null,
    };
  }

  if (input.vehicleDataPaused && !input.sessionProbePending) {
    return {
      shouldPoll: false,
      shouldWake: false,
      wait: "asleep",
      nextAttemptAt: null,
    };
  }

  const gap = Math.max(input.recoveryPollMs, 1);
  const sincePoll =
    input.lastFallbackAttemptAt <= 0 ? Number.POSITIVE_INFINITY : input.now - input.lastFallbackAttemptAt;
  const pollDue = input.sessionProbePending || sincePoll >= gap;

  let wait: TeslaWait = "none";
  if (!pollDue && input.consecutiveFailures > 0) wait = "asleep";

  return {
    shouldPoll: pollDue,
    shouldWake: false,
    wait,
    nextAttemptAt: pollDue ? input.now : null,
  };
}

/** True when a vehicle_data / telemetry snapshot shows the car is online. */
export function chargeSnapshotIsAwake(vehicle: {
  chargingState?: string | null;
  chargerVoltage?: number | null;
  chargerActualCurrent?: number | null;
} | null | undefined): boolean {
  if (!vehicle) return false;
  const state = vehicle.chargingState ?? "";
  if (state === "Charging" || state === "Starting") return true;
  const volts = Number(vehicle.chargerVoltage) || 0;
  const amps = Number(vehicle.chargerActualCurrent) || 0;
  if (volts > 0 && amps > 0) return true;
  return state === "Stopped" || state === "Complete" || state === "NoPower" || state === "Disconnected";
}
