process.env.GOODWE_SEMS_ACCOUNT ??= "test-account";
process.env.GOODWE_SEMS_PASSWORD ??= "test-password";
process.env.GOODWE_STATION_ID ??= "test-station";
process.env.TESLA_CLIENT_ID ??= "test-client";
process.env.TESLA_CLIENT_SECRET ??= "test-secret";
process.env.TESLA_REFRESH_TOKEN ??= "test-refresh";
// Env still names Model 3 — persistence must win (or leave unset).
process.env.TESLA_VEHICLE_TAG = "5YJ3F7EA5KF461091";
process.env.QUIET_HOURS_START ??= "";
process.env.QUIET_HOURS_END ??= "";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const MODEL_3 = "5YJ3F7EA5KF461091";
const MODEL_X = "5YJXDCE25JF080915";

function useTempSettings(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcharge-vehicle-"));
  process.env.TESLA_HOLDS_PATH = path.join(dir, "holds.json");
  process.env.CHARGE_FORCE_OFF_PATH = path.join(dir, "force.json");
  process.env.ACTIVE_VEHICLE_PATH = path.join(dir, "vehicle.json");
  return dir;
}

describe("active vehicle persistence", () => {
  it("leaves the active vehicle unset when nothing is persisted (ignores TESLA_VEHICLE_TAG)", async () => {
    useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    let tag = MODEL_3;
    const tesla = {
      getVehicleTag: () => tag,
      setVehicleTag(next: string) {
        tag = next;
      },
    };
    const controller = new ChargeController({} as never, tesla as never, null);
    assert.equal(controller.getStatus().vehicleTag, "");
    assert.equal(tag, "");
  });

  it("persists a dashboard pick and restores it on the next controller start", async () => {
    const dir = useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    let tag = MODEL_3;
    const tesla = {
      getVehicleTag: () => tag,
      setVehicleTag(next: string) {
        tag = next;
      },
    };

    const first = new ChargeController({} as never, tesla as never, null);
    assert.equal(first.getStatus().vehicleTag, "");
    first.setVehicleTag(MODEL_X, "dashboard");
    assert.equal(first.getStatus().vehicleTag, MODEL_X);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "vehicle.json"), "utf8")).vehicleTag, MODEL_X);

    tag = MODEL_3; // simulate createTeslaClient() still seeded from .env
    const second = new ChargeController({} as never, tesla as never, null);
    assert.equal(second.getStatus().vehicleTag, MODEL_X);
    assert.equal(tag, MODEL_X);
  });

  it("does not invent Model 3 or the first listed car from an empty persistence file", async () => {
    const dir = useTempSettings();
    fs.writeFileSync(path.join(dir, "vehicle.json"), JSON.stringify({ vehicleTag: "" }));
    const { loadActiveVehicleTag } = await import("../src/controller/chargeSettings.ts");
    assert.equal(loadActiveVehicleTag(), null);
  });
});
