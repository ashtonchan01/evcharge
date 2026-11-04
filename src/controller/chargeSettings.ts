import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "charge-settings" });

/**
 * The charging switch. Off means stop the car and keep it stopped.
 * Survives a browser refresh (server memory) and a process restart (this file).
 */
export function solarEnabledPath(): string {
  return process.env.CHARGE_FORCE_OFF_PATH || path.join(process.cwd(), ".charge-force-off.json");
}

export function loadSolarEnabled(): boolean | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(solarEnabledPath(), "utf8")) as {
      enabled?: unknown;
      forceChargeOff?: unknown;
    };
    if (typeof parsed.enabled === "boolean") return parsed.enabled;
    if (parsed.forceChargeOff === true) return false;
    return null;
  } catch {
    return null;
  }
}

export function saveSolarEnabled(enabled: boolean): void {
  const file = solarEnabledPath();
  const body = JSON.stringify({ enabled });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error({ err: String(err), file }, "Failed to persist the charging switch — a restart could leave the car charging");
  }
}
