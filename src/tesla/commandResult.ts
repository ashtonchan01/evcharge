/**
 * Tesla Fleet API and tesla-http-proxy both answer vehicle commands with
 * HTTP 200 when the car rejects the command. The rejection is in the body:
 * `{ "response": { "result": false, "reason": "..." } }`. Older proxy
 * builds put that text in `string` instead of `reason`. A missing result
 * is not treated as a failure — only an explicit false is.
 */
export function teslaCommandFailureReason(commandName: string, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;

  const record = body as {
    response?: { result?: boolean; reason?: string; string?: string };
    error?: string;
    error_description?: string;
  };
  const response = record.response;
  if (!response || typeof response !== "object" || response.result !== false) return null;

  const reason =
    text(response.reason) || text(response.string) || text(record.error_description) || text(record.error) || "unknown reason";

  return `Tesla rejected ${commandName}: ${reason}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
