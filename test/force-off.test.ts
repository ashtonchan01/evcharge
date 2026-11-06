process.env.GOODWE_SEMS_ACCOUNT ??= "test-account";
process.env.GOODWE_SEMS_PASSWORD ??= "test-password";
process.env.GOODWE_STATION_ID ??= "test-station";
process.env.TESLA_CLIENT_ID ??= "test-client";
process.env.TESLA_CLIENT_SECRET ??= "test-secret";
process.env.TESLA_REFRESH_TOKEN ??= "test-refresh";
process.env.TESLA_VEHICLE_TAG ??= "5YJ3TESTVIN000001";
process.env.QUIET_HOURS_START ??= "";
process.env.QUIET_HOURS_END ??= "";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function useTempSettings(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcharge-force-"));
  process.env.TESLA_HOLDS_PATH = path.join(dir, "holds.json");
  process.env.CHARGE_FORCE_OFF_PATH = path.join(dir, "force.json");
  process.env.ACTIVE_VEHICLE_PATH = path.join(dir, "vehicle.json");
}

function chargingAt(amps: number) {
  return {
    chargingState: "Charging",
    chargeAmps: amps,
    chargeLimitSoc: 80,
    batteryLevel: 40,
    chargerVoltage: 240,
    chargerActualCurrent: amps,
    pluggedIn: true,
    timestamp: new Date(),
  };
}

function solar(pvPowerW: number, loadPowerW: number) {
  return {
    timestamp: new Date(),
    pvPowerW,
    loadPowerW,
    gridPowerW: pvPowerW - loadPowerW,
    batteryPowerW: 0,
    batterySoc: null,
  };
}

describe("stale charge rate and force-off", () => {
  it("stops a stale 12 A charge once solar cannot sustain 5 A, and does not start from a stale Stopped car", async () => {
    useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    const stops: number[] = [];
    const starts: number[] = [];
    let pv = 800;
    const goodwe = {
      async getSnapshot() {
        return solar(pv, 4000);
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        throw new Error("should not poll while the recovery gap is open");
      },
      async wakeUp() {
        throw new Error("should not wake for a stale stop");
      },
      async startCharging() {
        starts.push(Date.now());
      },
      async stopCharging() {
        stops.push(Date.now());
      },
      async setChargeAmps() {
        throw new Error("should not raise amps off a stale snapshot");
      },
    };
    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      status: { override: { enabled: boolean }; vehicle: ReturnType<typeof chargingAt> | null };
      lastPolledVehicle: ReturnType<typeof chargingAt> | null;
      lastFallbackAttemptAt: number;
      consecutiveFailures: number;
      sessionProbePending: boolean;
    };
    const charging = chargingAt(12);
    internal.status.override.enabled = true;
    internal.status.vehicle = charging;
    internal.lastPolledVehicle = charging;
    internal.lastFallbackAttemptAt = Date.now();
    internal.consecutiveFailures = 2;
    internal.sessionProbePending = false;

    await internal.tick();
    assert.equal(stops.length, 1);
    assert.equal(starts.length, 0);
    assert.equal(controller.getStatus().targetAmps, null);

    const stopped = { ...charging, chargingState: "Stopped", chargeAmps: 0, chargerActualCurrent: 0 };
    internal.status.vehicle = stopped;
    internal.lastPolledVehicle = stopped;
    pv = 4000;
    internal.lastFallbackAttemptAt = Date.now();
    await internal.tick();
    await internal.tick();
    assert.equal(starts.length, 0);
    assert.equal(stops.length, 1);
  });

  it("force-off stops a charging car despite surplus, persists, and solar on clears it", async () => {
    useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    const stops: number[] = [];
    const starts: number[] = [];
    const goodwe = {
      async getSnapshot() {
        return solar(5000, 400);
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        return chargingAt(12);
      },
      async wakeUp() {},
      async startCharging() {
        starts.push(Date.now());
      },
      async stopCharging() {
        stops.push(Date.now());
      },
      async setChargeAmps() {},
    };
    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tickInFlight: boolean;
      lastPolledVehicle: ReturnType<typeof chargingAt>;
      status: { vehicle: ReturnType<typeof chargingAt> };
    };
    const charging = chargingAt(12);
    internal.lastPolledVehicle = charging;
    internal.status.vehicle = charging;

    controller.setEnabled(false, "test");
    for (let i = 0; i < 50 && internal.tickInFlight; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(controller.getStatus().override.enabled, false);
    assert.equal(stops.length, 1);
    assert.equal(starts.length, 0);
    assert.equal(controller.getStatus().targetAmps, null);

    const restarted = new ChargeController(goodwe as never, tesla as never, null);
    assert.equal(restarted.getStatus().override.enabled, false);

    controller.setEnabled(true, "test");
    assert.equal(controller.getStatus().override.enabled, true);
    const { loadSolarEnabled } = await import("../src/controller/chargeSettings.ts");
    assert.equal(loadSolarEnabled(), true);
  });

  it("keeps polling solar while off or unplugged, and skips Tesla until on and plugged", async () => {
    useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    let snapshots = 0;
    let chargeReads = 0;
    const goodwe = {
      async getSnapshot() {
        snapshots += 1;
        return solar(5000, 400);
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        chargeReads += 1;
        return chargingAt(0);
      },
      async wakeUp() {},
      async startCharging() {},
      async stopCharging() {},
      async setChargeAmps() {},
    };
    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      status: { vehicle: ReturnType<typeof chargingAt> | null; override: { enabled: boolean } };
      lastPolledVehicle: ReturnType<typeof chargingAt> | null;
      explicitSession: boolean;
      sessionProbePending: boolean;
    };
    const stopped = { ...chargingAt(0), chargingState: "Stopped", chargeAmps: 0, chargerActualCurrent: 0 };
    internal.status.vehicle = stopped;
    internal.lastPolledVehicle = stopped;
    internal.status.override.enabled = false;
    internal.explicitSession = false;
    internal.sessionProbePending = false;

    await internal.tick();
    assert.equal(snapshots, 1);
    assert.equal(chargeReads, 0);
    assert.equal(controller.getStatus().surplusW, 4600);

    internal.status.override.enabled = true;
    internal.status.vehicle = { ...stopped, pluggedIn: false };
    internal.lastPolledVehicle = internal.status.vehicle;
    await internal.tick();
    assert.equal(snapshots, 2);
    assert.equal(chargeReads, 0);

    internal.status.vehicle = chargingAt(5);
    internal.lastPolledVehicle = internal.status.vehicle;
    await internal.tick();
    assert.equal(snapshots, 3);
    assert.equal(chargeReads, 1);
  });

  it("stops on one low-solar cycle for Model 3 and Model X with no telemetry", async () => {
    useTempSettings();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { config } = await import("../src/config.ts");
    assert.equal(config.stableCyclesToStop, 1);
    assert.equal(config.pollIntervalMs, 60_000);

    const vins = ["5YJ3F7EA5KF461091", "5YJXDCE25JF080915"];
    for (const vin of vins) {
      const stops: string[] = [];
      let polls = 0;
      let tag = vin;
      const goodwe = {
        async getSnapshot() {
          return solar(800, 4000);
        },
      };
      const tesla = {
        getVehicleTag: () => tag,
        setVehicleTag(next: string) {
          tag = next;
        },
        async getChargeState() {
          polls += 1;
          throw new Error("no telemetry and recovery gap is closed");
        },
        async wakeUp() {
          throw new Error("should not wake");
        },
        async startCharging() {
          throw new Error("should not start");
        },
        async stopCharging() {
          stops.push(tag);
        },
        async setChargeAmps() {
          throw new Error("should not set amps");
        },
      };
      const controller = new ChargeController(goodwe as never, tesla as never, null);
      const internal = controller as unknown as {
        tick(): Promise<void>;
        status: { override: { enabled: boolean }; vehicle: ReturnType<typeof chargingAt> | null; vehicleTag: string };
        lastPolledVehicle: ReturnType<typeof chargingAt> | null;
        lastFallbackAttemptAt: number;
        consecutiveFailures: number;
        sessionProbePending: boolean;
      };
      controller.setVehicleTag(vin, "test");
      for (let i = 0; i < 20 && (controller as unknown as { tickInFlight: boolean }).tickInFlight; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const charging = chargingAt(12);
      internal.status.override.enabled = true;
      internal.status.vehicle = charging;
      internal.lastPolledVehicle = charging;
      internal.lastFallbackAttemptAt = Date.now();
      internal.consecutiveFailures = 2;
      internal.sessionProbePending = false;

      await internal.tick();
      assert.equal(internal.status.vehicleTag, vin);
      assert.equal(controller.getStatus().pollIntervalMs, 60_000);
      assert.deepEqual(stops, [vin]);
      assert.equal(polls, 0);
      assert.equal(controller.getStatus().targetAmps, null);
    }
  });
});
