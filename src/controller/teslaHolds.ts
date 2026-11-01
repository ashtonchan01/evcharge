import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/logger.js";
import type { VehicleChargeState } from "../tesla/client.js";

const log = logger.child({ module: "tesla-holds" });

export interface PersistedTeslaHolds {
  rateLimitedUntil: number;
  budgetUntil: number;
  authPausedUntil: number;
  /** After a 403/429/billing hold, the next contact is vehicle_data, not wake_up. */
  suppressWake: boolean;
  vehicle: VehicleChargeState | null;
}

const EMPTY: PersistedTeslaHolds = {
  rateLimitedUntil: 0,
  budgetUntil: 0,
  authPausedUntil: 0,
  suppressWake: false,
  vehicle: null,
};

/** Process-local so tests can point at a temp file before the controller is constructed. */
export function teslaHoldsPath(): string {
  return process.env.TESLA_HOLDS_PATH || path.join(process.cwd(), ".tesla-holds.json");
}

export function loadTeslaHolds(): PersistedTeslaHolds {
  try {
    const raw = fs.readFileSync(teslaHoldsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedTeslaHolds> & {
      vehicle?: (Omit<VehicleChargeState, "timestamp"> & { timestamp?: string }) | null;
    };
    const vehicle = parsed.vehicle;
    let restored: VehicleChargeState | null = null;
    if (vehicle && typeof vehicle.chargingState === "string" && vehicle.timestamp) {
      const timestamp = new Date(vehicle.timestamp);
      if (!Number.isNaN(timestamp.getTime())) {
        restored = {
          chargingState: vehicle.chargingState,
          chargeAmps: Number(vehicle.chargeAmps) || 0,
          chargeLimitSoc: Number(vehicle.chargeLimitSoc) || 0,
          batteryLevel: Number(vehicle.batteryLevel) || 0,
          chargerVoltage: Number(vehicle.chargerVoltage) || 0,
          chargerActualCurrent: Number(vehicle.chargerActualCurrent) || 0,
          pluggedIn: Boolean(vehicle.pluggedIn),
          timestamp,
        };
      }
    }
    return {
      rateLimitedUntil: Number(parsed.rateLimitedUntil) || 0,
      budgetUntil: Number(parsed.budgetUntil) || 0,
      authPausedUntil: Number(parsed.authPausedUntil) || 0,
      suppressWake: Boolean(parsed.suppressWake),
      vehicle: restored,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveTeslaHolds(holds: PersistedTeslaHolds): void {
  const file = teslaHoldsPath();
  const body = JSON.stringify({
    rateLimitedUntil: holds.rateLimitedUntil,
    budgetUntil: holds.budgetUntil,
    authPausedUntil: holds.authPausedUntil,
    suppressWake: holds.suppressWake,
    vehicle: holds.vehicle
      ? { ...holds.vehicle, timestamp: holds.vehicle.timestamp.toISOString() }
      : null,
  });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error({ err: String(err), file }, "Failed to persist Tesla hold — a restart could wake into a 403 again");
  }
}
