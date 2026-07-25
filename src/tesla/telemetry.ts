import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "telemetry" });

/**
 * Coarse, push-driven signal about a vehicle: is it plugged in, roughly
 * charging or not, and how stale is that signal. Also carries the ramp
 * loop's charging-power inputs (chargeAmps, chargerPowerW) so an active
 * session can usually run on telemetry alone instead of polling
 * vehicle_data every cycle - see src/controller/index.ts. These two are
 * tracked with their own `chargingDataLastSeenAt` timestamp, separate from
 * `lastSeenAt`, so the controller can judge specifically whether it has a
 * *recent* charging-power reading (not just any recent field at all)
 * before trusting telemetry over a direct poll during an active session.
 */
export interface TelemetryHint {
  pluggedIn: boolean;
  chargingState: string; // normalized: "Charging" | "Complete" | "Disconnected" | "Stopped" | "Unknown"
  batteryLevel: number;
  chargeAmps: number;
  /** Real AC charging power in watts, converted from Tesla's ACChargingPower (kW). */
  chargerPowerW: number;
  chargeLimitSoc: number;
  lastSeenAt: Date;
  chargingDataLastSeenAt: Date | null;
}

/**
 * Exact values from teslamotors/fleet-telemetry's protos/vehicle_data.proto
 * (DetailedChargeStateValue enum), confirmed by reading that file directly
 * rather than guessed:
 *   DetailedChargeStateUnknown, DetailedChargeStateDisconnected,
 *   DetailedChargeStateNoPower, DetailedChargeStateStarting,
 *   DetailedChargeStateCharging, DetailedChargeStateComplete,
 *   DetailedChargeStateStopped
 * "Starting" is folded into "Charging" so a session that's mid-handshake
 * doesn't look like "not charging" and trigger a redundant charge_start.
 */
function normalizeChargingState(raw: string): string {
  switch (raw) {
    case "DetailedChargeStateCharging":
    case "DetailedChargeStateStarting":
      return "Charging";
    case "DetailedChargeStateComplete":
      return "Complete";
    case "DetailedChargeStateDisconnected":
      return "Disconnected";
    case "DetailedChargeStateNoPower":
    case "DetailedChargeStateStopped":
      return "Stopped";
    default:
      return "Unknown";
  }
}

/**
 * Shape confirmed by reading teslamotors/fleet-telemetry's
 * datastore/simple/logger.go + transformers/payload.go on the deployed
 * server: the "logger" dispatcher runs each Payload through
 * PayloadToMap() (field name -> raw value, e.g. `"Soc": 72`,
 * `"DetailedChargeState": "DetailedChargeStateCharging"`) and logs it via
 * logrus as `{"data": <that map>, "vin": ..., "msg": "record_payload", ...}`.
 * Alerts/errors go through the same "record_payload" message but with
 * `data` as an array, not an object - the isArray check below is what
 * filters those out.
 */
function extractVehicleFields(line: string): { vin: string; data: Record<string, unknown> } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined; // fleet-telemetry also logs plain-text startup/connection lines
  }

  const vin = parsed.vin as string | undefined;
  const data = parsed.data;
  if (!vin || typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return { vin, data: data as Record<string, unknown> };
}

/**
 * Tails the fleet-telemetry server's "logger" dispatcher output (one JSON
 * object per line) instead of polling Tesla's vehicle_data endpoint, so
 * idle/parked time costs nothing - see README's Fleet Telemetry section
 * for the one-time server + fleet_telemetry_config setup this consumes.
 */
export class TelemetryIngest extends EventEmitter {
  private readonly byVin = new Map<string, TelemetryHint>();
  private unmatchedStreak = 0;

  /**
   * Tails one or more log files and merges their lines through the same
   * parser. fleet-telemetry's actual "record_payload" activity data has
   * been observed landing on the pm2 *error* log (its Go logger appears to
   * write there, not stdout) while the "out" log carries almost nothing -
   * tailing both makes ingest resilient to which stream a given
   * fleet-telemetry build/config happens to use, instead of silently
   * getting zero hints forever if that assumption is wrong.
   */
  start(logPaths: string[]): void {
    for (const logPath of logPaths) {
      log.info({ logPath }, "Tailing fleet-telemetry log");
      // -F follows by name (survives log rotation), -n0 skips pre-existing lines.
      const tail = spawn("tail", ["-n0", "-F", logPath]);
      const rl = readline.createInterface({ input: tail.stdout });

      rl.on("line", (line) => this.handleLine(line));
      tail.stderr.on("data", (chunk) => log.warn({ logPath, err: String(chunk).trim() }, "tail stderr"));
      tail.on("exit", (code) => {
        log.error(
          { logPath, code },
          "fleet-telemetry log tail exited - this source has stopped, vehicle state may go stale until restart"
        );
      });
    }
  }

  getHint(vin: string): TelemetryHint | undefined {
    return this.byVin.get(vin);
  }

  private handleLine(line: string): void {
    const parsed = extractVehicleFields(line);
    if (!parsed) return;
    const { vin, data } = parsed;

    const recognizedFields = [
      "Soc",
      "DetailedChargeState",
      "ChargePortDoorOpen",
      "ChargeAmps",
      "ACChargingPower",
      "ChargeLimitSoc",
    ];
    const hasRecognizedField = recognizedFields.some((f) => f in data);
    if (!hasRecognizedField) {
      this.unmatchedStreak += 1;
      if (this.unmatchedStreak === 20) {
        log.warn(
          { recognizedFields },
          "20 consecutive vehicle-data telemetry lines had none of the recognized fields - fleet_telemetry_config's requested fields may not match what telemetry.ts looks for"
        );
      }
      return;
    }
    this.unmatchedStreak = 0;

    const prior = this.byVin.get(vin);
    const detailedChargeState = data.DetailedChargeState;
    const chargePortDoorOpen = data.ChargePortDoorOpen;
    const soc = data.Soc;
    const chargeAmps = data.ChargeAmps;
    // Tesla's ACChargingPower is in kW (matches the REST API's charger_power
    // field) - convert to watts to match the rest of the app's units.
    const acChargingPowerKw = data.ACChargingPower;
    const chargeLimitSoc = data.ChargeLimitSoc;
    const now = new Date();
    const hasChargingData = typeof chargeAmps === "number" || typeof acChargingPowerKw === "number";

    const hint: TelemetryHint = {
      chargingState:
        typeof detailedChargeState === "string"
          ? normalizeChargingState(detailedChargeState)
          : prior?.chargingState ?? "Unknown",
      pluggedIn: typeof chargePortDoorOpen === "boolean" ? chargePortDoorOpen : prior?.pluggedIn ?? false,
      batteryLevel: typeof soc === "number" ? soc : prior?.batteryLevel ?? 0,
      chargeAmps: typeof chargeAmps === "number" ? chargeAmps : prior?.chargeAmps ?? 0,
      chargerPowerW: typeof acChargingPowerKw === "number" ? acChargingPowerKw * 1000 : prior?.chargerPowerW ?? 0,
      chargeLimitSoc: typeof chargeLimitSoc === "number" ? chargeLimitSoc : prior?.chargeLimitSoc ?? 0,
      lastSeenAt: now,
      chargingDataLastSeenAt: hasChargingData ? now : prior?.chargingDataLastSeenAt ?? null,
    };

    this.byVin.set(vin, hint);
    log.debug({ vin, data }, "Telemetry update");
    this.emit("update", vin, hint);
  }
}

export function createTelemetryIngest(): TelemetryIngest | null {
  if (!config.tesla.telemetryLogPath) return null;
  const paths = [config.tesla.telemetryLogPath, config.tesla.telemetryErrorLogPath].filter(
    (p): p is string => Boolean(p)
  );
  const ingest = new TelemetryIngest();
  ingest.start(paths);
  return ingest;
}
