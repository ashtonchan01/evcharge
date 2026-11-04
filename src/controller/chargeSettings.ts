import fs from "node:fs";
import path from "node:path";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "charge-settings" });

/** Survives a browser refresh (server memory) and a process restart (this file). */
export function chargeForceOffPath(): string {
  return process.env.CHARGE_FORCE_OFF_PATH || path.join(process.cwd(), ".charge-force-off.json");
}

export function loadForceChargeOff(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(chargeForceOffPath(), "utf8")) as { forceChargeOff?: unknown };
    return parsed.forceChargeOff === true;
  } catch {
    return false;
  }
}

export function saveForceChargeOff(on: boolean): void {
  const file = chargeForceOffPath();
  const body = JSON.stringify({ forceChargeOff: on });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error({ err: String(err), file }, "Failed to persist force-off — a restart could leave the car charging");
  }
}
