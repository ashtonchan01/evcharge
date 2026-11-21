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
import type { AddressInfo } from "node:net";
import {
  ampCommandIsIdenticalRepeat,
  ampCommandNeeded,
  ampSendGapOpen,
  budgetBlocksPaidCalls,
  chargeSnapshotIsAwake,
  chargeStartConfirmCapReached,
  chargeStartConfirmShouldPoll,
  classifyTeslaBlock,
  commandGapElapsed,
  dailyVehicleDataCapReached,
  planRecovery,
  shouldSkipVehicleDataPoll,
  telemetryResumesVehicleDataPoll,
  vehicleDataDayKey,
} from "../src/controller/teslaRecovery.ts";

const FIVE_MIN = 300_000;
const THIRTY_MIN = 1_800_000;
const FAILURE_BACKOFF = 45_000;
const AMP_CHANGE_GAP = 60_000;

function useFreshHoldsFile(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcharge-holds-"));
  process.env.TESLA_HOLDS_PATH = path.join(dir, "holds.json");
  process.env.CHARGE_FORCE_OFF_PATH = path.join(dir, "force.json");
  process.env.ACTIVE_VEHICLE_PATH = path.join(dir, "vehicle.json");
}

describe("classifyTeslaBlock", () => {
  it("keeps plain 403 and 429 on the rate-limit path", () => {
    assert.equal(classifyTeslaBlock(403, "Tesla request GET /api/1/vehicles failed: HTTP 403"), "rate_limit");
    assert.equal(classifyTeslaBlock(429, "too many requests"), "rate_limit");
    assert.equal(classifyTeslaBlock(403, "Access Denied You don't have permission"), "auth");
    assert.equal(
      classifyTeslaBlock(403, "Tesla token refresh failed: HTTP 403 <HTML><TITLE>Access Denied</TITLE>"),
      "auth"
    );
  });

  it("treats 402 and billing wording as a billing hold, not a shorter cooldown", () => {
    assert.equal(classifyTeslaBlock(402, "Payment Required"), "billing");
    assert.equal(classifyTeslaBlock(403, "developer billing spending limit reached"), "billing");
    assert.equal(classifyTeslaBlock(403, '{"error":"EXCEEDED_LIMIT"}'), "billing");
    assert.equal(classifyTeslaBlock(429, "EXCEEDED_LIMIT monthly limit"), "billing");
    assert.equal(classifyTeslaBlock(400, "vehicle unavailable"), null);
  });
});

describe("amp commands", () => {
  it("does not send set_charging_amps when the integer target already matches reported amps", () => {
    assert.equal(ampCommandNeeded(7, 7, null), false);
    assert.equal(ampCommandNeeded(7.2, 7, null), false);
    assert.equal(ampCommandNeeded(8, 8.4, 5), false);
  });

  it("sends when reported amps lag, even if the target matches a prior accepted command", () => {
    assert.equal(ampCommandNeeded(10, 32, 10), true);
    assert.equal(ampCommandNeeded(12, 5, 12), true);
    assert.equal(ampCommandNeeded(12, 5, null), true);
  });

  it("does not treat a gap as elapsed early", () => {
    assert.equal(commandGapElapsed(10_000, 9_000, FIVE_MIN), false);
    assert.equal(commandGapElapsed(10_000 + FIVE_MIN, 10_000, FIVE_MIN), true);
    assert.equal(commandGapElapsed(10_000, 0, FIVE_MIN), true);
  });

  it("throttles a new amp target until TESLA_AMP_CHANGE_MIN_INTERVAL_MS from last acceptance", () => {
    const base = {
      commandMinIntervalMs: FIVE_MIN,
      ampChangeMinIntervalMs: AMP_CHANGE_GAP,
      commandFailureBackoffMs: FAILURE_BACKOFF,
      lastCommandedAmps: 12,
      lastAmpAttemptSucceeded: true,
      sessionBundleOpen: false,
      explicitSession: false,
      lastAmpCommandAt: 19_000,
      lastAmpAcceptedAt: 19_000,
    };
    assert.equal(ampCommandIsIdenticalRepeat(12, 12), true);
    assert.equal(ampCommandIsIdenticalRepeat(14, 12), false);
    assert.equal(ampSendGapOpen({ ...base, now: 20_000, targetAmps: 14 }), false);
    assert.equal(
      ampSendGapOpen({ ...base, now: 19_000 + AMP_CHANGE_GAP, targetAmps: 14 }),
      true
    );
    assert.equal(ampSendGapOpen({ ...base, now: 20_000, targetAmps: 12 }), false);
    assert.equal(
      ampSendGapOpen({ ...base, now: 19_000 + FIVE_MIN, targetAmps: 12 }),
      true
    );
  });

  it("uses a short backoff after a failed amp command", () => {
    const base = {
      commandMinIntervalMs: FIVE_MIN,
      ampChangeMinIntervalMs: AMP_CHANGE_GAP,
      commandFailureBackoffMs: FAILURE_BACKOFF,
      lastCommandedAmps: 10,
      lastAmpAttemptSucceeded: false,
      sessionBundleOpen: false,
      explicitSession: false,
      lastAmpCommandAt: 100_000,
      lastAmpAcceptedAt: 50_000,
    };
    assert.equal(ampSendGapOpen({ ...base, now: 120_000, targetAmps: 14 }), false);
    assert.equal(ampSendGapOpen({ ...base, now: 100_000 + FAILURE_BACKOFF, targetAmps: 14 }), true);
  });
});

describe("planRecovery", () => {
  const base = {
    now: 1_000_000,
    solarEnabled: true,
    telemetryFresh: false,
    lastFallbackAttemptAt: 1_000_000 - 10_000,
    lastWakeAttemptAt: 1_000_000 - 10_000,
    consecutiveFailures: 0,
    recoveryPollMs: FIVE_MIN,
    rateLimitedUntil: 0,
    budgetBlocked: false,
    sessionProbePending: false,
    quietHours: false,
    budgetUntil: 0,
    vehicleDataPaused: false,
  };

  it("does not poll or wake inside the recovery gap", () => {
    const plan = planRecovery(base);
    assert.equal(plan.shouldPoll, false);
    assert.equal(plan.shouldWake, false);
    // Last poll succeeded, so this gap is not a "waking" countdown.
    assert.equal(plan.wait, "none");
    assert.equal(plan.nextAttemptAt, null);
  });

  it("shows asleep with no timer when vehicle_data is paused after a miss", () => {
    const plan = planRecovery({
      ...base,
      consecutiveFailures: 2,
      vehicleDataPaused: true,
    });
    assert.equal(plan.shouldPoll, false);
    assert.equal(plan.shouldWake, false);
    assert.equal(plan.wait, "asleep");
    assert.equal(plan.nextAttemptAt, null);
  });

  it("allows one poll when the user just enabled solar, and still will not poll twice inside the gap", () => {
    const probe = planRecovery({ ...base, sessionProbePending: true, consecutiveFailures: 4 });
    assert.equal(probe.shouldPoll, true);
    assert.equal(probe.shouldWake, false);
    const again = planRecovery({ ...base, sessionProbePending: false, consecutiveFailures: 4 });
    assert.equal(again.shouldPoll, false);
    assert.equal(again.shouldWake, false);
  });

  it("does not poll again on a timer while paused, even after the recovery gap", () => {
    const plan = planRecovery({
      ...base,
      lastFallbackAttemptAt: base.now - FIVE_MIN,
      consecutiveFailures: 3,
      vehicleDataPaused: true,
    });
    assert.equal(plan.shouldPoll, false);
    assert.equal(plan.shouldWake, false);
    assert.equal(plan.wait, "asleep");
  });

  it("allows one poll when the owner turns solar on while paused", () => {
    const plan = planRecovery({
      ...base,
      vehicleDataPaused: true,
      sessionProbePending: true,
      consecutiveFailures: 4,
    });
    assert.equal(plan.shouldPoll, true);
    assert.equal(plan.shouldWake, false);
  });

  it("does not poll while telemetry is fresh, solar is off, quiet hours, rate limited, or budget blocked", () => {
    assert.equal(planRecovery({ ...base, telemetryFresh: true }).shouldPoll, false);
    assert.equal(planRecovery({ ...base, solarEnabled: false }).shouldPoll, false);
    assert.equal(planRecovery({ ...base, quietHours: true }).shouldWake, false);
    const limited = planRecovery({ ...base, rateLimitedUntil: base.now + THIRTY_MIN, sessionProbePending: true });
    assert.equal(limited.shouldPoll, false);
    assert.equal(limited.shouldWake, false);
    assert.equal(limited.wait, "rate_limited");
    assert.equal(limited.nextAttemptAt, base.now + THIRTY_MIN);
    const budget = planRecovery({ ...base, budgetBlocked: true, budgetUntil: base.now + 21_600_000, sessionProbePending: true });
    assert.equal(budget.shouldPoll, false);
    assert.equal(budget.wait, "budget");
  });
});

describe("chargeSnapshotIsAwake", () => {
  it("treats charging and live charger fields as awake, not a sleep", () => {
    assert.equal(chargeSnapshotIsAwake({ chargingState: "Charging", chargerVoltage: 240, chargerActualCurrent: 8 }), true);
    assert.equal(chargeSnapshotIsAwake({ chargingState: "Stopped", chargerVoltage: 0, chargerActualCurrent: 0 }), true);
    assert.equal(chargeSnapshotIsAwake({ chargingState: "Unknown", chargerVoltage: 0, chargerActualCurrent: 0 }), false);
    assert.equal(chargeSnapshotIsAwake(null), false);
  });
});

describe("budgetBlocksPaidCalls", () => {
  it("blocks forced-on and an active auto hold, except the one session bundle", () => {
    assert.equal(
      budgetBlocksPaidCalls({ mode: "on", now: 0, budgetUntil: 0, sessionCredit: false, sessionBundleOpen: false }),
      true
    );
    assert.equal(
      budgetBlocksPaidCalls({ mode: "on", now: 0, budgetUntil: 0, sessionCredit: true, sessionBundleOpen: false }),
      false
    );
    assert.equal(
      budgetBlocksPaidCalls({ mode: "auto", now: 5_000, budgetUntil: 9_000, sessionCredit: false, sessionBundleOpen: false }),
      true
    );
    assert.equal(
      budgetBlocksPaidCalls({ mode: "auto", now: 5_000, budgetUntil: 0, sessionCredit: false, sessionBundleOpen: false }),
      false
    );
    assert.equal(
      budgetBlocksPaidCalls({ mode: "off", now: 5_000, budgetUntil: 9_000, sessionCredit: false, sessionBundleOpen: false }),
      false
    );
  });
});

describe("amp command send timing", () => {
  it("retries after failure backoff and does not block a new target", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");

    const amps: number[] = [];
    let failNext = true;
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        return {
          chargingState: "Charging",
          chargeAmps: 5,
          chargeLimitSoc: 80,
          batteryLevel: 50,
          chargerVoltage: 240,
          chargerActualCurrent: 5,
          pluggedIn: true,
          timestamp: new Date(),
        };
      },
      async wakeUp() {},
      async startCharging() {},
      async stopCharging() {},
      async setChargeAmps(value: number) {
        if (failNext) {
          failNext = false;
          throw new Error("vehicle unavailable");
        }
        amps.push(value);
      },
    };

    const controller = new ChargeController({} as never, tesla as never, null);
    const internal = controller as unknown as {
      sendAmps(target: number, reported: number): Promise<string>;
      lastAmpCommandAt: number;
      lastAmpAcceptedAt: number;
    };

    assert.equal(await internal.sendAmps(12, 5), "failed");
    assert.equal(await internal.sendAmps(12, 5), "held");
    internal.lastAmpCommandAt = Date.now() - FAILURE_BACKOFF - 1_000;
    assert.equal(await internal.sendAmps(12, 5), "sent");
    assert.equal(await internal.sendAmps(16, 5), "held");
    internal.lastAmpAcceptedAt = Date.now() - AMP_CHANGE_GAP - 1_000;
    assert.equal(await internal.sendAmps(16, 5), "sent");
    assert.deepEqual(amps, [12, 16]);
  });
});

describe("charge command dedup and cooldowns", () => {
  it("sends start and set_amps once, keeps the 30 minute 403 cooldown, and opens a billing hold", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");
    const { config } = await import("../src/config.ts");

    const starts: number[] = [];
    const amps: number[] = [];
    const stops: number[] = [];
    const polls: number[] = [];
    const wakes: number[] = [];
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 4000,
          loadPowerW: 400,
          gridPowerW: -3600,
          batteryPowerW: 0,
          batterySoc: 0,
        };
      },
    };
    let reportCharging = false;
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        polls.push(Date.now());
        return {
          chargingState: reportCharging ? "Charging" : "Stopped",
          chargeAmps: 5,
          chargeLimitSoc: 80,
          batteryLevel: 50,
          chargerVoltage: reportCharging ? 240 : 0,
          chargerActualCurrent: reportCharging ? 5 : 0,
          pluggedIn: true,
          timestamp: new Date(),
        };
      },
      async wakeUp() {
        wakes.push(Date.now());
      },
      async startCharging() {
        starts.push(Date.now());
        reportCharging = true;
      },
      async stopCharging() {
        stops.push(Date.now());
        reportCharging = false;
      },
      async setChargeAmps(value: number) {
        amps.push(value);
      },
    };

    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      sendStart(): Promise<string>;
      sendStop(): Promise<string>;
      sendAmps(target: number, reported: number): Promise<string>;
      chargeStartConfirmPending: boolean;
      lastAmpAcceptedAt: number;
    };

    controller.setEnabled(true, "test");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(polls.length, 1, "enabling solar polls once");
    await internal.tick();
    assert.equal(polls.length, 1, "the next tick must not poll inside the recovery gap");
    assert.equal(wakes.length, 0, "never wake_up after a failed vehicle_data");
    assert.ok(starts.length <= 1, "start is not repeated on the next tick");

    const startsBefore = starts.length;
    const pollsBeforeStart = polls.length;
    const firstStart = await internal.sendStart();
    const secondStart = await internal.sendStart();
    if (startsBefore === 0) {
      assert.equal(firstStart, "sent");
      assert.equal(secondStart, "held");
      // charge_start spends one confirm vehicle_data (not a per-cycle poll).
      assert.equal(polls.length, pollsBeforeStart + 1, "one confirm poll after charge_start");
      assert.equal(controller.getStatus().vehicle?.chargingState, "Charging");
      assert.equal(internal.chargeStartConfirmPending, false);
    } else {
      assert.equal(firstStart, "held");
      assert.equal(secondStart, "held");
    }
    assert.equal(starts.length, Math.max(startsBefore, 1));

    assert.equal(await internal.sendAmps(5, 5), "unchanged");
    assert.equal(await internal.sendAmps(12, 5), "sent");
    assert.equal(await internal.sendAmps(12, 5), "held");
    assert.equal(await internal.sendAmps(14, 5), "held");
    internal.lastAmpAcceptedAt = Date.now() - AMP_CHANGE_GAP - 1_000;
    assert.equal(await internal.sendAmps(14, 5), "sent");
    assert.deepEqual(amps, [12, 14]);

    assert.equal(await internal.sendStop(), "sent");
    assert.equal(await internal.sendStop(), "held");
    assert.equal(stops.length, 1);

    const before = Date.now();
    controller.noteRateLimit("test-403");
    const firstUntil = controller.getStatus().rateLimitedUntil?.getTime() ?? 0;
    assert.ok(firstUntil - before >= config.tesla.rateLimitCooldownMs - 20);
    assert.ok(firstUntil - before < config.tesla.rateLimitCooldownMs + 2_000);
    controller.noteRateLimit("test-403-again");
    const secondUntil = controller.getStatus().rateLimitedUntil?.getTime() ?? 0;
    assert.ok(secondUntil >= firstUntil);
    assert.equal(controller.getStatus().teslaWait, "rate_limited");

    if (config.tesla.apiBudgetMode !== "off") {
      const billBefore = Date.now();
      controller.observeTeslaError("vehicle_data", new TeslaApiError("HTTP 402 payment required", 402));
      const status = controller.getStatus();
      const budgetAt = status.nextTeslaAttemptAt?.getTime() ?? 0;
      assert.equal(status.apiBudgetActive, true);
      assert.equal(status.teslaWait, "budget");
      assert.ok(budgetAt - billBefore >= config.tesla.apiBudgetCooldownMs - 50);
      assert.ok((status.rateLimitedUntil?.getTime() ?? 0) >= firstUntil);
    }
  });
});

describe("vehicle_data budget helpers", () => {
  it("caps charge_start confirmation attempts and honors the recovery gap", () => {
    const base = {
      now: 1_000_000,
      pending: true,
      attempts: 0,
      firstAttemptAt: 990_000,
      lastFallbackAttemptAt: 1_000_000 - FIVE_MIN - 1,
      recoveryPollMs: FIVE_MIN,
      maxAttempts: 4,
      maxDurationMs: 120_000,
    };
    assert.equal(chargeStartConfirmShouldPoll(base), true);
    assert.equal(chargeStartConfirmShouldPoll({ ...base, lastFallbackAttemptAt: base.now - 1_000 }), false);
    assert.equal(chargeStartConfirmCapReached({ ...base, attempts: 4 }), true);
    assert.equal(chargeStartConfirmCapReached({ ...base, now: base.firstAttemptAt + 121_000 }), true);
  });

  it("skips polls when telemetry or last snapshot is unplugged", () => {
    const now = Date.now();
    assert.equal(
      shouldSkipVehicleDataPoll({
        telemetryHint: { pluggedIn: false, chargingState: "Stopped", lastSeenAt: new Date(now) },
        telemetryStaleMs: 600_000,
        now,
        recoveryPollMs: FIVE_MIN,
      }),
      true
    );
    assert.equal(
      shouldSkipVehicleDataPoll({
        telemetryHint: { pluggedIn: true, chargingState: "Charging", lastSeenAt: new Date(now) },
        telemetryStaleMs: 600_000,
        now,
        recoveryPollMs: FIVE_MIN,
      }),
      false
    );
  });

  it("detects daily vehicle_data cap", () => {
    assert.equal(dailyVehicleDataCapReached(59, 60), false);
    assert.equal(dailyVehicleDataCapReached(60, 60), true);
    assert.equal(dailyVehicleDataCapReached(100, 0), false);
    assert.ok(vehicleDataDayKey(Date.now(), "Australia/Sydney").length >= 8);
  });

  it("resumes vehicle_data only when telemetry shows plugged in", () => {
    const now = Date.now();
    assert.equal(
      telemetryResumesVehicleDataPoll(
        { pluggedIn: true, chargingState: "Stopped", lastSeenAt: new Date(now) },
        now,
        600_000
      ),
      true
    );
    assert.equal(
      telemetryResumesVehicleDataPoll(
        { pluggedIn: false, chargingState: "Disconnected", lastSeenAt: new Date(now) },
        now,
        600_000
      ),
      false
    );
  });
});

describe("charge_start confirmation", () => {
  it("leaves Stopped / 0 V after charge_start and confirms Charging on the next poll", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { config } = await import("../src/config.ts");

    let starts = 0;
    let pollsAfterStart = 0;
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 4000,
          loadPowerW: 400,
          gridPowerW: -3600,
          batteryPowerW: 0,
          batterySoc: 0,
        };
      },
    };
    const stopped = {
      chargingState: "Stopped",
      chargeAmps: 5,
      chargeLimitSoc: 90,
      batteryLevel: 83,
      chargerVoltage: 0,
      chargerActualCurrent: 0,
      pluggedIn: true,
      timestamp: new Date(),
    };
    const charging = {
      chargingState: "Charging",
      chargeAmps: 5,
      chargeLimitSoc: 90,
      batteryLevel: 83,
      chargerVoltage: 243,
      chargerActualCurrent: 5,
      pluggedIn: true,
      timestamp: new Date(),
    };
    const tesla = {
      getVehicleTag: () => "5YJXDCE25JF080915",
      setVehicleTag() {},
      async getChargeState() {
        if (starts === 0) return { ...stopped, timestamp: new Date() };
        pollsAfterStart += 1;
        // Tesla often still reports Stopped on the immediate post-start read.
        if (pollsAfterStart === 1) return { ...stopped, timestamp: new Date() };
        return { ...charging, timestamp: new Date() };
      },
      async wakeUp() {},
      async startCharging() {
        starts += 1;
      },
      async stopCharging() {},
      async setChargeAmps() {},
    };

    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      aboveStartThresholdCount: number;
      lastFallbackAttemptAt: number;
      sessionProbePending: boolean;
      chargeStartConfirmPending: boolean;
    };

    controller.setEnabled(true, "test");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(starts, 0, "enable probe alone does not start (needs stable cycles)");

    // Second stable cycle with a fresh Stopped poll (production: session/recovery
    // read), then charge_start. Immediate confirm still returns Stopped.
    internal.aboveStartThresholdCount = 1;
    internal.sessionProbePending = true;
    await internal.tick();

    assert.equal(starts, 1);
    const afterStart = controller.getStatus();
    // Immediate confirm still saw Stopped — display must be optimistic Starting.
    assert.equal(afterStart.vehicle?.chargingState, "Starting");
    assert.equal(afterStart.decision, "charging");
    assert.equal(internal.chargeStartConfirmPending, true);

    // Next eligible tick (recovery gap) confirms live fields — not every 30s tick.
    internal.sessionProbePending = false;
    internal.lastFallbackAttemptAt = Date.now() - config.tesla.telemetryRecoveryPollMs - 1_000;
    await internal.tick();
    const confirmed = controller.getStatus();
    assert.equal(confirmed.vehicle?.chargingState, "Charging");
    assert.equal(confirmed.vehicle?.chargerVoltage, 243);
    assert.equal(confirmed.vehicle?.chargerActualCurrent, 5);
    assert.equal(confirmed.decision, "charging");
    assert.equal(internal.chargeStartConfirmPending, false);
  });

  it("does not poll every tick while confirm is pending and the car returns 408", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");
    const { config } = await import("../src/config.ts");

    let polls = 0;
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 5000,
          loadPowerW: 400,
          gridPowerW: -4600,
          batteryPowerW: 0,
          batterySoc: 0,
        };
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        polls += 1;
        throw new TeslaApiError("HTTP 408 vehicle asleep", 408);
      },
      async wakeUp() {},
      async startCharging() {},
      async stopCharging() {},
      async setChargeAmps() {},
    };

    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      chargeStartConfirmPending: boolean;
      lastFallbackAttemptAt: number;
      sendStart(): Promise<string>;
    };

    controller.setEnabled(true, "test");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const pollsAfterEnable = polls;
    internal.lastFallbackAttemptAt = Date.now() - config.tesla.telemetryRecoveryPollMs - 1_000;
    await internal.sendStart();
    const pollsAfterStart = polls - pollsAfterEnable;
    assert.ok(pollsAfterStart <= 2, "at most immediate confirm plus one retry");

    for (let i = 0; i < 5; i += 1) {
      internal.lastFallbackAttemptAt = Date.now() - config.tesla.telemetryRecoveryPollMs - 1_000;
      await internal.tick();
    }
    assert.ok(polls - pollsAfterEnable <= 4, "confirm path must not hammer vehicle_data");
    assert.equal(internal.chargeStartConfirmPending, false);
  });
});

describe("awake snapshot display", () => {
  it("does not stay on waking after a poll shows the car charging", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");

    let polls = 0;
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 4000,
          loadPowerW: 400,
          gridPowerW: -3600,
          batteryPowerW: 0,
          batterySoc: 0,
        };
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3F7EA5KF461091",
      setVehicleTag() {},
      async getChargeState() {
        polls += 1;
        return {
          chargingState: "Charging",
          chargeAmps: 5,
          chargeLimitSoc: 80,
          batteryLevel: 50,
          chargerVoltage: 240,
          chargerActualCurrent: 8,
          pluggedIn: true,
          timestamp: new Date(),
        };
      },
      async wakeUp() {},
      async startCharging() {},
      async stopCharging() {},
      async setChargeAmps() {},
    };

    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as { tick(): Promise<void> };
    controller.setEnabled(true, "test");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await internal.tick();

    const status = controller.getStatus();
    assert.equal(polls, 1, "the follow-up tick must not spend another vehicle_data call");
    assert.equal(status.vehicle?.chargingState, "Charging");
    assert.equal(status.decision, "charging");
    assert.notEqual(status.teslaWait, "waking");
    assert.notEqual(status.teslaWait, "asleep");
    assert.equal(status.nextTeslaAttemptAt, null);
  });
});

describe("persisted Tesla holds", () => {
  it("reloads a rate-limit hold after restart and does not wake when solar is turned on", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");

    let wakes = 0;
    let polls = 0;
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 3000,
          loadPowerW: 400,
          gridPowerW: -2600,
          batteryPowerW: 0,
          batterySoc: 0,
        };
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3F7EA5KF461091",
      setVehicleTag() {},
      async getChargeState() {
        polls += 1;
        throw new TeslaApiError('{"error":"EXCEEDED_LIMIT"}', 403);
      },
      async wakeUp() {
        wakes += 1;
      },
      async startCharging() {},
      async stopCharging() {},
      async setChargeAmps() {},
    };

    const first = new ChargeController(goodwe as never, tesla as never, null);
    first.observeTeslaError("wake_up", new TeslaApiError('{"error":"EXCEEDED_LIMIT"}', 403));
    const status = first.getStatus();
    assert.equal(status.teslaWait, "budget");
    assert.equal(status.apiBudgetActive, true);
    assert.equal(status.rateLimitedUntil, null);

    const restarted = new ChargeController(goodwe as never, tesla as never, null);
    assert.equal(restarted.getStatus().teslaWait, "budget");
    assert.equal(restarted.getStatus().apiBudgetActive, true);
    restarted.setEnabled(true, "test");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(wakes, 0);
    assert.equal(polls, 0);
  });

  it("treats a plain 429 as a short persisted pause and still will not wake", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");
    const { config } = await import("../src/config.ts");

    const controller = new ChargeController({} as never, { getVehicleTag: () => "VIN", setVehicleTag() {} } as never, null);
    const before = Date.now();
    controller.observeTeslaError("vehicle_data", new TeslaApiError("HTTP 429 too many requests", 429));
    const until = controller.getStatus().rateLimitedUntil?.getTime() ?? 0;
    assert.ok(until - before >= config.tesla.transientRateLimitCooldownMs - 50);
    assert.ok(until - before < config.tesla.rateLimitCooldownMs - 60_000);
    assert.equal(controller.getStatus().teslaWait, "rate_limited");

    const restarted = new ChargeController(
      {} as never,
      { getVehicleTag: () => "VIN", setVehicleTag() {} } as never,
      null
    );
    const reloaded = restarted.getStatus().rateLimitedUntil?.getTime() ?? 0;
    assert.ok(Math.abs(reloaded - until) < 5);
  });
});

describe("auth edge 403", () => {
  it("does not start a 30 minute rate-limit hold for an Access Denied token refresh", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");
    const { config } = await import("../src/config.ts");

    const controller = new ChargeController({} as never, { getVehicleTag: () => "VIN", setVehicleTag() {} } as never, null);
    const before = Date.now();
    controller.observeTeslaError(
      "token refresh",
      new TeslaApiError("Tesla token refresh failed: HTTP 403 <HTML><TITLE>Access Denied</TITLE></HTML>", 403)
    );
    const status = controller.getStatus();
    assert.equal(status.teslaWait, "auth");
    assert.equal(status.rateLimitedUntil, null);
    const until = status.nextTeslaAttemptAt?.getTime() ?? 0;
    assert.ok(until - before >= config.tesla.authFailureCooldownMs - 50);
    assert.ok(until - before < config.tesla.rateLimitCooldownMs - 60_000);

    const restarted = new ChargeController(
      {} as never,
      { getVehicleTag: () => "VIN", setVehicleTag() {} } as never,
      null
    );
    assert.equal(restarted.getStatus().teslaWait, "auth");
  });
});

describe("GET /api/vehicles cache", () => {
  it("does not call Tesla again on a warm cache or during a 429 cooldown", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TeslaApiError } = await import("../src/tesla/client.ts");
    const { createApp } = await import("../src/server/index.ts");

    let calls = 0;
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async listVehicles() {
        calls += 1;
        if (calls === 1) {
          return [{ id: "1", vin: "5YJ3TESTVIN000001", displayName: "Test", state: "asleep" }];
        }
        throw new TeslaApiError("HTTP 429", 429);
      },
      async getChargeState() {
        throw new Error("not used");
      },
    };
    const controller = new ChargeController({} as never, tesla as never, null);
    const app = createApp(controller, tesla as never, {} as never);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const first = await fetch(`http://127.0.0.1:${port}/api/vehicles`);
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as { vehicles: { vin: string }[]; stale: boolean };
      assert.equal(firstBody.stale, false);
      assert.equal(firstBody.vehicles[0].vin, "5YJ3TESTVIN000001");

      const second = await fetch(`http://127.0.0.1:${port}/api/vehicles`);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);

      controller.noteRateLimit("test");
      const third = await fetch(`http://127.0.0.1:${port}/api/vehicles`);
      assert.equal(third.status, 429);
      const thirdBody = (await third.json()) as { vehicles: { vin: string }[]; stale: boolean; error: string };
      assert.equal(thirdBody.stale, true);
      assert.equal(thirdBody.vehicles[0].vin, "5YJ3TESTVIN000001");
      assert.match(thirdBody.error, /rate limit/i);
      assert.equal(calls, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe("enable solar inside the recovery gap", () => {
  it("clears the asleep wait and polls once without wake_up", async () => {
    useFreshHoldsFile();
    const { ChargeController } = await import("../src/controller/index.ts");
    const polls: number[] = [];
    const wakes: number[] = [];
    const goodwe = {
      async getSnapshot() {
        return {
          timestamp: new Date(),
          pvPowerW: 2000,
          loadPowerW: 500,
          gridPowerW: 1500,
          batteryPowerW: 0,
          batterySoc: null,
        };
      },
    };
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag() {},
      async getChargeState() {
        polls.push(Date.now());
        throw new Error("asleep");
      },
      async wakeUp() {
        wakes.push(Date.now());
      },
    };
    const controller = new ChargeController(goodwe as never, tesla as never, null);
    const internal = controller as unknown as {
      tick(): Promise<void>;
      tickInFlight: boolean;
      lastFallbackAttemptAt: number;
      lastWakeAttemptAt: number;
      consecutiveFailures: number;
    };
    const now = Date.now();
    internal.lastFallbackAttemptAt = now;
    internal.lastWakeAttemptAt = now;
    internal.consecutiveFailures = 2;
    (internal as unknown as { vehicleDataPaused: boolean }).vehicleDataPaused = true;
    controller.getStatus().teslaWait = "asleep";
    controller.getStatus().nextTeslaAttemptAt = new Date(now + 9 * 60 * 1000);

    controller.setEnabled(true, "test");
    const next = controller.getStatus().nextTeslaAttemptAt;
    const stillWaitingOutTheGap = next !== null && next.getTime() - Date.now() > 60_000;
    assert.equal(stillWaitingOutTheGap, false);
    assert.notEqual(controller.getStatus().teslaWait, "asleep");

    for (let i = 0; i < 50 && internal.tickInFlight; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(polls.length, 1);
    assert.equal(wakes.length, 0);

    await internal.tick();
    assert.equal(wakes.length, 0);
    assert.equal(polls.length, 1, "no extra poll while paused after the enable probe fails");
  });
});
