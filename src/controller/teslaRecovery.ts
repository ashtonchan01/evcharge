/**
 * Cost gates for Tesla Fleet API calls.
 *
 * Oct 2026 billing (Ashton): the $16 monthly discount was used up, mostly by
 * Commands (6,383 / $9.96), then Data (1,220 / $3.81) and Wakes (52 / $1.62).
 * Streaming telemetry was the cheap path. Nothing in here may poll, wake, or
 * command faster than the configured recovery / command gaps. A single
 * explicit session probe (the user turned solar charging on) may run once
 * inside that gap. A non-billing 403 still uses the full cooldown. Billing
 * EXCEEDED_LIMIT / 402 does not. A session probe polls vehicle_data and
 * does not call wake_up.
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
export function ampCommandNeeded(targetAmps: number, reportedAmps: number, lastCommandedAmps: number | null): boolean {
  if (!Number.isFinite(targetAmps)) return false;
  const target = Math.round(targetAmps);
  if (Number.isFinite(reportedAmps) && target === Math.round(reportedAmps)) return false;
  if (lastCommandedAmps !== null && Number.isFinite(lastCommandedAmps) && target === Math.round(lastCommandedAmps)) {
    return false;
  }
  return true;
}

export function commandGapElapsed(now: number, lastAt: number, minIntervalMs: number): boolean {
  if (lastAt <= 0) return true;
  return now - lastAt >= minIntervalMs;
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
  /** User just turned solar on and telemetry has no fresh hint. One vehicle_data poll, no wake. */
  sessionProbePending: boolean;
  /** Set after a hold. The next probe must not call wake_up. */
  suppressWake?: boolean;
  /** Last snapshot already showed the car online or charging. */
  knownAwake?: boolean;
  quietHours: boolean;
  /** When the budget hold ends. 0 if the hold is indefinite (mode forced on). */
  budgetUntil: number;
}

export interface RecoveryPlan {
  shouldPoll: boolean;
  shouldWake: boolean;
  wait: TeslaWait;
  nextAttemptAt: number | null;
}

/**
 * Direct vehicle_data / wake_up schedule. Never sooner than recoveryPollMs
 * unless `sessionProbePending` (one user-initiated try). Wake is not repeated
 * for a failure streak — that matches the pre-existing throttle and does not
 * add wakes on top of it.
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

  const gap = Math.max(input.recoveryPollMs, 1);
  const sincePoll =
    input.lastFallbackAttemptAt <= 0 ? Number.POSITIVE_INFINITY : input.now - input.lastFallbackAttemptAt;
  const sinceWake =
    input.lastWakeAttemptAt <= 0 ? Number.POSITIVE_INFINITY : input.now - input.lastWakeAttemptAt;
  const pollDue = input.sessionProbePending || sincePoll >= gap;
  // Never wake just because solar was turned on, just because a hold expired,
  // or when we already know the car is online. Wake stays a follow-up to a
  // failed vehicle_data read (see pollForRecovery), at most once per gap.
  const wakeDue =
    pollDue &&
    !input.sessionProbePending &&
    !input.suppressWake &&
    !input.knownAwake &&
    input.consecutiveFailures === 0 &&
    sinceWake >= gap;
  const nextPollAt = input.lastFallbackAttemptAt <= 0 ? input.now : input.lastFallbackAttemptAt + gap;
  // "Waking" is only for a wake that has not been answered yet. A successful
  // poll (consecutiveFailures === 0) means the car already responded — the
  // next paid poll can still wait out `gap`, but the dashboard must not
  // count that gap down as if the car were asleep.
  const outOfContact = input.consecutiveFailures > 0;
  const wokeRecently = outOfContact && input.lastWakeAttemptAt > 0 && sinceWake < gap;

  let wait: TeslaWait = "none";
  if (!pollDue && outOfContact) wait = wokeRecently ? "waking" : "asleep";

  return {
    shouldPoll: pollDue,
    shouldWake: wakeDue,
    wait,
    nextAttemptAt: pollDue ? input.now : outOfContact ? nextPollAt : null,
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
