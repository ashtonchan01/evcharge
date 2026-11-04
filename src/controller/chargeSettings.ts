import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "charge-settings" });

function writeJsonAtomic(file: string, body: string, failMessage: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error({ err: String(err), file }, failMessage);
  }
}

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
  writeJsonAtomic(
    solarEnabledPath(),
    JSON.stringify({ enabled }),
    "Failed to persist the charging switch — a restart could leave the car charging"
  );
}

/**
 * Dashboard-selected VIN (or vehicle id). Survives pm2 restart / deploy.
 * Never fall back to TESLA_VEHICLE_TAG, Model 3, or the first listed car —
 * if nothing is saved yet, leave the selection unset until he picks in the UI.
 */
export function activeVehiclePath(): string {
  return process.env.ACTIVE_VEHICLE_PATH || path.join(process.cwd(), ".active-vehicle.json");
}

export function loadActiveVehicleTag(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeVehiclePath(), "utf8")) as {
      vehicleTag?: unknown;
      tag?: unknown;
    };
    const tag = parsed.vehicleTag ?? parsed.tag;
    if (typeof tag === "string" && tag.trim()) return tag.trim();
    return null;
  } catch {
    return null;
  }
}

export function saveActiveVehicleTag(tag: string): void {
  const trimmed = tag.trim();
  if (!trimmed) return;
  writeJsonAtomic(
    activeVehiclePath(),
    JSON.stringify({ vehicleTag: trimmed }),
    "Failed to persist the active vehicle — a restart could switch cars"
  );
}
