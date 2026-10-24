/** Tesla's set_charge_limit accepts any integer percent in this range (inclusive). */
export const CHARGE_LIMIT_MIN = 50;
export const CHARGE_LIMIT_MAX = 100;

const RANGE_ERROR = `percent must be a number between ${CHARGE_LIMIT_MIN} and ${CHARGE_LIMIT_MAX}`;

/**
 * Accept any finite number from 50 to 100 inclusive and round it to the
 * integer Tesla's command expects. There is no 90 cap — 100 is a normal
 * trip charge limit, same as the Tesla app slider.
 */
export function parseChargeLimitPercent(
  value: unknown
): { ok: true; percent: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < CHARGE_LIMIT_MIN || value > CHARGE_LIMIT_MAX) {
    return { ok: false, error: RANGE_ERROR };
  }

  const percent = Math.round(value);
  if (percent < CHARGE_LIMIT_MIN || percent > CHARGE_LIMIT_MAX) {
    return { ok: false, error: RANGE_ERROR };
  }

  return { ok: true, percent };
}

/** Body for POST .../command/set_charge_limit. The field name is `percent`. */
export function chargeLimitCommandBody(percent: number): { percent: number } {
  const parsed = parseChargeLimitPercent(percent);
  if (!parsed.ok) throw new Error(parsed.error);
  return { percent: parsed.percent };
}
