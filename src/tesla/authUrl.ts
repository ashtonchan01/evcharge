/**
 * Fleet API refresh tokens are issued by Tesla's fleet auth host.
 * auth.tesla.com is the consumer login edge; from this VM it returns an
 * Akamai "Access Denied" HTML 403 in tens of milliseconds, which is not a
 * vehicle rate limit. Override with TESLA_AUTH_URL if Tesla moves the host.
 */
export const DEFAULT_FLEET_AUTH_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

export function resolveFleetAuthUrl(override?: string): string {
  const raw = (override || DEFAULT_FLEET_AUTH_URL).trim().replace(/\/+$/, "");
  return raw || DEFAULT_FLEET_AUTH_URL;
}

/** Response text safe to log: no refresh tokens, collapsed whitespace, capped length. */
export function describeTeslaHttpBody(body: string): string {
  return body
    .replace(/\s+/g, " ")
    .replace(/refresh_token=[^&\s"]+/gi, "refresh_token=[redacted]")
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"[redacted]"')
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"[redacted]"')
    .trim()
    .slice(0, 500);
}
