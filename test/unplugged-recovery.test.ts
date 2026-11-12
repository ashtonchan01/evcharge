process.env.GOODWE_SEMS_ACCOUNT ??= "test-account";
process.env.GOODWE_SEMS_PASSWORD ??= "test-password";
process.env.GOODWE_STATION_ID ??= "test-station";
process.env.TESLA_CLIENT_ID ??= "test-client";
process.env.TESLA_CLIENT_SECRET ??= "test-secret";
process.env.TESLA_REFRESH_TOKEN ??= "test-refresh";
process.env.TESLA_VEHICLE_TAG ??= "5YJ3TESTVIN000001";
process.env.QUIET_HOURS_START ??= "";
process.env.QUIET_HOURS_END ??= "";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const MODEL_X = "5YJXDCE25JF080915";
const MODEL_3 = "5YJ3TESTVIN000001";
const DAY_MS = 24 * 60 * 60 * 1000;

type ChargeState = {
  chargingState: string;
  chargeAmps: number;
  chargeLimitSoc: number;
  batteryLevel: number;
  chargerVoltage: number;
  chargerActualCurrent: number;
  pluggedIn: boolean;
  timestamp: Date;
};

type Internal = {
  tick(): Promise<void>;
  tickInFlight: boolean;
  status: {
    override: { enabled: boolean };
    vehicle: ChargeState | null;
    vehicleTag: string;
  };
  lastPolledVehicle: ChargeState | null;
  lastFallbackAttemptAt: number;
  lastWakeAttemptAt: number;
  consecutiveFailures: number;
  sessionProbePending: boolean;
  explicitSession: boolean;
};

function useTempSettings(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcharge-unplugged-"));
  process.env.TESLA_HOLDS_PATH = path.join(dir, "holds.json");
  process.env.CHARGE_FORCE_OFF_PATH = path.join(dir, "force.json");
  process.env.ACTIVE_VEHICLE_PATH = path.join(dir, "vehicle.json");
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

function stopped(pluggedIn: boolean, timestamp: Date): ChargeState {
  return {
    chargingState: "Stopped",
    chargeAmps: 0,
    chargeLimitSoc: 90,
    batteryLevel: 64,
    chargerVoltage: 0,
    chargerActualCurrent: 0,
    pluggedIn,
    timestamp,
  };
}

function internals(controller: object): Internal {
  return controller as unknown as Internal;
}

async function settle(internal: Internal): Promise<void> {
  for (let i = 0; i < 50 && internal.tickInFlight; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(internal.tickInFlight, false);
}

function agePollClock(internal: Internal, gapMs: number): void {
  const past = Date.now() - gapMs - 1_000;
  internal.lastFallbackAttemptAt = past;
  internal.lastWakeAttemptAt = past;
}

type SettingsModule = typeof import("../src/controller/chargeSettings.ts");
type HoldsModule = typeof import("../src/controller/teslaHolds.ts");

async function setup(
  read: () => ChargeState | Promise<ChargeState>,
  beforeConstruct?: (deps: { settings: SettingsModule; holds: HoldsModule }) => void
) {
  useTempSettings();
  const { ChargeController } = await import("../src/controller/index.ts");
  const settings = await import("../src/controller/chargeSettings.ts");
  const holds = await import("../src/controller/teslaHolds.ts");
  settings.saveActiveVehicleTag(MODEL_X);
  beforeConstruct?.({ settings, holds });

  const counts = { snapshots: 0, polls: 0, wakes: 0, starts: 0, stops: 0 };
  const sets: string[] = [];
  let tag = "";
  const goodwe = {
    async getSnapshot() {
      counts.snapshots += 1;
      return solar(3200 + counts.snapshots * 10, 400);
    },
  };
  const tesla = {
    getVehicleTag: () => tag,
    setVehicleTag(next: string) {
      sets.push(next);
      tag = next;
    },
    async getChargeState() {
      counts.polls += 1;
      return read();
    },
    async wakeUp() {
      counts.wakes += 1;
    },
    async startCharging() {
      counts.starts += 1;
    },
    async stopCharging() {
      counts.stops += 1;
    },
    async setChargeAmps() {},
  };
  const controller = new ChargeController(goodwe as never, tesla as never, null);
  return { ChargeController, controller, internal: internals(controller), counts, sets, goodwe, tesla };
}

describe("unplugged snapshot does not lock Tesla", () => {
  it("follows an asleep On-switch probe with a later read once the car is online", async () => {
    let online = false;
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { controller, internal, counts, sets } = await setup(() => {
      if (!online) throw new Error("vehicle unavailable");
      return stopped(true, new Date());
    });
    const { config } = await import("../src/config.ts");
    const gap = config.tesla.telemetryRecoveryPollMs;

    const stale = stopped(false, staleAt);
    internal.status.vehicle = stale;
    internal.lastPolledVehicle = stale;
    assert.equal(internal.status.vehicleTag, MODEL_X);
    assert.deepEqual(sets, [MODEL_X]);

    controller.setEnabled(true, "test");
    await settle(internal);

    assert.equal(counts.polls, 1, "turning On probes Tesla once");
    assert.equal(counts.wakes, 1, "an asleep probe wakes once");
    assert.equal(controller.getStatus().override.enabled, true);
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);
    assert.equal(controller.getStatus().vehicle?.chargingState, "Stopped");
    assert.equal(new Date(controller.getStatus().vehicle!.timestamp).toISOString(), staleAt.toISOString());
    assert.equal(controller.getStatus().lastError, null);
    assert.equal(controller.getStatus().rateLimitedUntil, null);
    assert.equal(controller.getStatus().apiBudgetActive, false);

    const snapshotsAfterProbe = counts.snapshots;
    await internal.tick();
    assert.equal(counts.polls, 1, "the next tick must not busy-poll inside the recovery gap");
    assert.equal(counts.wakes, 1);
    assert.ok(counts.snapshots > snapshotsAfterProbe, "solar keeps updating while Tesla waits");
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);

    agePollClock(internal, gap);
    await internal.tick();
    assert.equal(counts.polls, 2, "a later gap retries vehicle_data after the asleep miss");
    assert.equal(counts.wakes, 1, "an unplugged recheck does not wake on every gap");
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);
    assert.equal(controller.getStatus().override.enabled, true);

    online = true;
    agePollClock(internal, gap);
    await internal.tick();
    assert.equal(counts.polls, 3);
    assert.equal(counts.wakes, 1);
    assert.equal(counts.starts, 0);
    assert.equal(counts.stops, 0);
    const status = controller.getStatus();
    assert.equal(status.override.enabled, true);
    assert.equal(status.vehicleTag, MODEL_X);
    assert.equal(status.vehicle?.pluggedIn, true);
    assert.equal(status.vehicle?.chargingState, "Stopped");
    assert.equal(status.vehicle?.chargeLimitSoc, 90);
    assert.equal(status.rateLimitedUntil, null);
    assert.equal(status.apiBudgetActive, false);
    assert.equal(sets.includes(MODEL_3), false);
  });

  it("reloads a stale unplugged snapshot on restart and still reads Tesla while the switch stays On", async () => {
    let online = false;
    const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { ChargeController, controller, internal: firstInternal, counts, goodwe, tesla } = await setup(
      () => {
        if (!online) throw new Error("vehicle unavailable");
        return stopped(true, new Date());
      },
      ({ settings, holds }) => {
        settings.saveSolarEnabled(true);
        holds.saveTeslaHolds({
          rateLimitedUntil: 0,
          budgetUntil: 0,
          authPausedUntil: 0,
          suppressWake: false,
          vehicle: stopped(false, staleAt),
        });
      }
    );
    const { config } = await import("../src/config.ts");
    const { loadTeslaHolds } = await import("../src/controller/teslaHolds.ts");
    const gap = config.tesla.telemetryRecoveryPollMs;

    const first = controller;
    assert.equal(first.getStatus().override.enabled, true);
    assert.equal(first.getStatus().vehicleTag, MODEL_X);
    assert.equal(first.getStatus().vehicle?.pluggedIn, false);

    await firstInternal.tick();
    assert.equal(counts.polls, 1, "a restarted On controller must not trust the old unplugged snapshot");
    assert.equal(counts.wakes, 1);
    const persisted = loadTeslaHolds();
    assert.equal(persisted.vehicle?.pluggedIn, false);
    assert.ok(Date.now() - persisted.vehicle!.timestamp.getTime() > 20 * 60 * 60 * 1000);

    const restarted = new ChargeController(goodwe as never, tesla as never, null);
    const internal = internals(restarted);
    assert.equal(restarted.getStatus().vehicleTag, MODEL_X);
    assert.equal(restarted.getStatus().override.enabled, true);
    await internal.tick();
    assert.equal(counts.polls, 2, "restarting again after the failed read still has to poll");
    await internal.tick();
    assert.equal(counts.polls, 2, "the follow-up waits out the recovery gap");
    assert.equal(counts.wakes, 2, "each process wakes at most once for an asleep unplugged recheck");

    online = true;
    agePollClock(internal, gap);
    await internal.tick();
    assert.equal(counts.polls, 3);
    assert.equal(counts.wakes, 2);
    assert.equal(restarted.getStatus().vehicle?.pluggedIn, true);
    assert.equal(restarted.getStatus().vehicleTag, MODEL_X);
    assert.equal(restarted.getStatus().override.enabled, true);
    assert.equal(loadTeslaHolds().vehicle?.pluggedIn, true);
  });

  it("skips further Tesla polls after a fresh unplugged read, including when the recovery gap has elapsed", async () => {
    const { controller, internal, counts } = await setup(() => stopped(false, new Date()));
    const { config } = await import("../src/config.ts");
    const gap = config.tesla.telemetryRecoveryPollMs;

    const stale = stopped(false, new Date(Date.now() - DAY_MS));
    internal.status.override.enabled = true;
    internal.status.vehicle = stale;
    internal.lastPolledVehicle = stale;
    await internal.tick();

    assert.equal(counts.polls, 1);
    assert.equal(counts.wakes, 0);
    assert.equal(controller.getStatus().override.enabled, false, "a fresh unplugged read turns the switch off");
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);

    internal.lastFallbackAttemptAt = Date.now() - gap - 5_000;
    controller.setEnabled(true, "test");
    await settle(internal);
    for (let i = 0; i < 3; i += 1) {
      await internal.tick();
    }
    assert.equal(counts.polls, 1, "a recent successful unplugged read does not busy-poll");
    assert.equal(counts.wakes, 0);
    assert.equal(controller.getStatus().override.enabled, true);
    assert.ok(counts.snapshots >= 5);
    assert.equal(typeof controller.getStatus().surplusW, "number");

    const aged = stopped(false, new Date(Date.now() - gap - 5_000));
    internal.status.vehicle = aged;
    internal.lastPolledVehicle = aged;
    internal.lastFallbackAttemptAt = Date.now() - gap - 5_000;
    await internal.tick();
    assert.equal(counts.polls, 2, "once that reading is stale, one Tesla check runs");
    assert.equal(controller.getStatus().override.enabled, false);
    await internal.tick();
    await internal.tick();
    assert.equal(counts.polls, 2, "the new unplugged reading does not start a poll every tick");
    assert.ok(counts.snapshots > counts.polls);
  });

  it("retries when the last read failed even if the saved unplugged snapshot is still recent", async () => {
    let online = false;
    const { controller, internal, counts } = await setup(() => {
      if (!online) throw new Error("vehicle unavailable");
      return stopped(true, new Date());
    });
    const { config } = await import("../src/config.ts");
    const recent = stopped(false, new Date());
    internal.status.override.enabled = true;
    internal.status.vehicle = recent;
    internal.lastPolledVehicle = recent;
    internal.consecutiveFailures = 1;
    internal.sessionProbePending = false;
    agePollClock(internal, config.tesla.telemetryRecoveryPollMs);

    await internal.tick();
    assert.equal(counts.polls, 1, "a failed read must not leave a recent unplugged snapshot in force");
    assert.equal(counts.wakes, 0);
    assert.equal(controller.getStatus().override.enabled, true);
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);

    online = true;
    agePollClock(internal, config.tesla.telemetryRecoveryPollMs);
    await internal.tick();
    assert.equal(counts.polls, 2);
    assert.equal(controller.getStatus().vehicle?.pluggedIn, true);
    assert.equal(controller.getStatus().vehicleTag, MODEL_X);
    assert.equal(controller.getStatus().override.enabled, true);
  });

  it("does not poll a recent unplugged snapshot restored at startup", async () => {
    const { controller, internal, counts } = await setup(
      () => {
        throw new Error("recent unplugged snapshot must not contact Tesla");
      },
      ({ settings, holds }) => {
        settings.saveSolarEnabled(true);
        holds.saveTeslaHolds({
          rateLimitedUntil: 0,
          budgetUntil: 0,
          authPausedUntil: 0,
          suppressWake: false,
          vehicle: stopped(false, new Date()),
        });
      }
    );

    assert.equal(controller.getStatus().override.enabled, true);
    assert.equal(controller.getStatus().vehicle?.pluggedIn, false);
    assert.equal(controller.getStatus().vehicleTag, MODEL_X);
    await internal.tick();
    await internal.tick();
    await internal.tick();
    assert.equal(counts.polls, 0);
    assert.equal(counts.wakes, 0);
    assert.equal(counts.snapshots, 3);
    assert.equal(typeof controller.getStatus().surplusW, "number");
  });

  it("keeps Tesla skipped while the switch is Off, even with a stale unplugged snapshot", async () => {
    const { controller, internal, counts } = await setup(() => {
      throw new Error("Off must not poll Tesla");
    });
    internal.status.vehicle = stopped(false, new Date(Date.now() - DAY_MS));
    internal.lastPolledVehicle = internal.status.vehicle;
    internal.lastFallbackAttemptAt = 0;
    controller.setEnabled(false, "test");
    await settle(internal);
    await internal.tick();
    assert.equal(controller.getStatus().override.enabled, false);
    assert.equal(counts.polls, 0);
    assert.equal(counts.wakes, 0);
    assert.equal(counts.stops, 0);
    assert.ok(counts.snapshots >= 2);
    assert.equal(typeof controller.getStatus().surplusW, "number");
  });

  it("does not spend a stale-unplugged retry during a rate-limit hold", async () => {
    const { controller, internal, counts } = await setup(
      () => {
        throw new Error("rate limit must block vehicle_data");
      },
      ({ settings, holds }) => {
        settings.saveSolarEnabled(true);
        holds.saveTeslaHolds({
          rateLimitedUntil: 0,
          budgetUntil: 0,
          authPausedUntil: 0,
          suppressWake: false,
          vehicle: stopped(false, new Date(Date.now() - DAY_MS)),
        });
      }
    );
    controller.noteRateLimit("test");
    await internal.tick();
    await internal.tick();
    assert.equal(counts.polls, 0);
    assert.equal(counts.wakes, 0);
    assert.equal(controller.getStatus().teslaWait, "rate_limited");
    assert.ok(controller.getStatus().rateLimitedUntil);
    assert.equal(controller.getStatus().apiBudgetActive, false);
    assert.ok((controller.getStatus().surplusW ?? 0) > 0);
  });

  it("still wakes a plugged-in car when a later recovery poll fails", async () => {
    const { controller, internal, counts } = await setup(() => {
      throw new Error("vehicle unavailable");
    });
    const { config } = await import("../src/config.ts");
    const charging = stopped(true, new Date(Date.now() - DAY_MS));
    charging.chargingState = "Charging";
    charging.chargeAmps = 12;
    charging.chargerVoltage = 240;
    charging.chargerActualCurrent = 12;
    internal.status.override.enabled = true;
    internal.status.vehicle = charging;
    internal.lastPolledVehicle = charging;
    internal.sessionProbePending = false;
    internal.consecutiveFailures = 0;
    agePollClock(internal, config.tesla.telemetryRecoveryPollMs);
    await internal.tick();
    assert.equal(counts.polls, 1);
    assert.equal(counts.wakes, 1);
    assert.equal(controller.getStatus().vehicleTag, MODEL_X);
  });
});

