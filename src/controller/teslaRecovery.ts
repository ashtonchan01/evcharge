/**
 * Cost gates for Tesla Fleet API calls.
 *
 * Oct 2026 billing (Ashton): the $16 monthly discount was used up, mostly by
 * Commands (6,383 / $9.96), then Data (1,220 / $3.81) and Wakes (52 / $1.62).
 * Streaming telemetry was the cheap path. Nothing in here may poll, wake, or
 * command faster than the configured recovery / command gaps. A single
 * explicit session probe (the user turned solar charging on) may run once
 * inside that gap. 403/429 still uses the full cooldown — this module does
 * not shorten it.
 */

export type TeslaWait = "none" | "waking" | "asleep" | "rate_limited" | "budget" | "quiet_hours";

export type TeslaBlock = "billing" | "rate_limit";

/**
 * 402 and billing-cap wording are a spending hold. Plain 403/429 stay on the
 * existing rate-limit cooldown (including Akamai "Access Denied" on token
 * refresh — that is not a billing-cap signal).
 */
export function classifyTeslaBlock(status: number, message: string): TeslaBlock | null {
  const text = message.toLowerCase();
  if (
    status === 402 ||
    /billing|payment required|quota exceeded|spending limit|monthly limit|developer billing|insufficient fund/.test(text)
  ) {
    return "billing";
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
  budgetBlocked: boolean;
  /** User just turned solar on and telemetry has no fresh hint. One poll + maybe one wake. */
  sessionProbePending: boolean;
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
  // One wake per unreachable streak, throttled to the same gap. The session
  // probe may wake once even mid-streak; it does not start a faster cadence.
  const wakeDue = pollDue && (input.sessionProbePending || (input.consecutiveFailures === 0 && sinceWake >= gap));
  const nextPollAt = input.lastFallbackAttemptAt <= 0 ? input.now : input.lastFallbackAttemptAt + gap;
  const wokeRecently = input.lastWakeAttemptAt > 0 && sinceWake < gap;

  return {
    shouldPoll: pollDue,
    shouldWake: wakeDue,
    wait: pollDue ? "none" : wokeRecently ? "waking" : "asleep",
    nextAttemptAt: pollDue ? input.now : nextPollAt,
  };
}
