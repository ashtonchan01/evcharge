import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { chargeLimitCommandBody, parseChargeLimitPercent } from "../src/chargeLimit.ts";
import { teslaCommandFailureReason } from "../src/tesla/commandResult.ts";

process.env.GOODWE_SEMS_ACCOUNT ??= "test-account";
process.env.GOODWE_SEMS_PASSWORD ??= "test-password";
process.env.GOODWE_STATION_ID ??= "test-station";
process.env.TESLA_CLIENT_ID ??= "test-client";
process.env.TESLA_CLIENT_SECRET ??= "test-secret";
process.env.TESLA_REFRESH_TOKEN ??= "test-refresh";
process.env.TESLA_VEHICLE_TAG ??= "5YJ3TESTVIN000001";
process.env.QUIET_HOURS_START ??= "";
process.env.QUIET_HOURS_END ??= "";

describe("parseChargeLimitPercent", () => {
  it("accepts every integer from 50 through 100, including 90 and 100", () => {
    for (const percent of [50, 80, 90, 99, 100]) {
      assert.deepEqual(parseChargeLimitPercent(percent), { ok: true, percent });
    }
  });

  it("rounds in-range fractions to an integer percent", () => {
    assert.deepEqual(parseChargeLimitPercent(80.4), { ok: true, percent: 80 });
    assert.deepEqual(parseChargeLimitPercent(99.6), { ok: true, percent: 100 });
  });

  it("rejects values outside 50–100 and non-numbers", () => {
    for (const value of [49, 49.9, 100.1, 101, NaN, Infinity, "100", null, undefined]) {
      const parsed = parseChargeLimitPercent(value);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.error, /50 and 100/);
    }
  });

  it("sends set_charge_limit as { percent } with no 90 cap", () => {
    assert.deepEqual(chargeLimitCommandBody(100), { percent: 100 });
    assert.deepEqual(chargeLimitCommandBody(90), { percent: 90 });
    assert.deepEqual(chargeLimitCommandBody(50), { percent: 50 });
    assert.throws(() => chargeLimitCommandBody(101), /50 and 100/);
  });
});

describe("teslaCommandFailureReason", () => {
  it("treats result true as success", () => {
    assert.equal(teslaCommandFailureReason("set_charge_limit", { response: { result: true, reason: "" } }), null);
  });

  it("surfaces Tesla's reason when HTTP 200 still has result false", () => {
    const message = teslaCommandFailureReason("set_charge_limit", {
      response: { result: false, reason: "could_not_wake_buses" },
    });
    assert.equal(message, "Tesla rejected set_charge_limit: could_not_wake_buses");
  });

  it("reads the legacy proxy string field and falls back when reason is empty", () => {
    assert.equal(
      teslaCommandFailureReason("set_charge_limit", { response: { result: false, reason: "", string: "already_set" } }),
      "Tesla rejected set_charge_limit: already_set"
    );
    assert.equal(
      teslaCommandFailureReason("set_charge_limit", { response: { result: false } }),
      "Tesla rejected set_charge_limit: unknown reason"
    );
  });

  it("does not invent a failure when the body has no result flag", () => {
    assert.equal(teslaCommandFailureReason("set_charge_limit", {}), null);
    assert.equal(teslaCommandFailureReason("set_charge_limit", null), null);
  });
});

describe("POST /api/charge-limit", () => {
  it("sends 50–100, refreshes the cached limit, and returns Tesla's rejection", async () => {
    const { ChargeController } = await import("../src/controller/index.ts");
    const { TelemetryIngest } = await import("../src/tesla/telemetry.ts");
    const { createApp } = await import("../src/server/index.ts");

    const calls: number[] = [];
    let rejectWith: string | null = null;
    const tesla = {
      getVehicleTag: () => "5YJ3TESTVIN000001",
      setVehicleTag: () => {},
      setChargeLimit: async (percent: number) => {
        calls.push(percent);
        if (rejectWith) throw new Error(rejectWith);
      },
      getChargeState: async () => {
        throw new Error("not used");
      },
    };

    const telemetry = new TelemetryIngest();
    const ingest = telemetry as unknown as { handleLine(line: string): void };
    const vin = "5YJ3TESTVIN000001";
    ingest.handleLine(
      JSON.stringify({
        vin,
        msg: "record_payload",
        data: { Soc: 74, DetailedChargeState: "DetailedChargeStateCharging", ChargeLimitSoc: 80, ChargeAmps: 12 },
      })
    );

    const controller = new ChargeController({} as never, tesla as never, telemetry);
    const vehicle = {
      chargingState: "Charging",
      chargeAmps: 12,
      chargeLimitSoc: 80,
      batteryLevel: 74,
      chargerVoltage: 240,
      chargerActualCurrent: 12,
      pluggedIn: true,
      timestamp: new Date(),
    };
    const internal = controller as unknown as {
      status: { vehicle: typeof vehicle | null };
      lastPolledVehicle: typeof vehicle | null;
      reapplyCommandedChargeLimit(): void;
      commandedChargeLimit: { percent: number; at: number } | null;
    };
    internal.status.vehicle = { ...vehicle };
    internal.lastPolledVehicle = { ...vehicle };

    const app = createApp(controller, tesla as never, {} as never);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const post = (percent: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/charge-limit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ percent }),
        });

      const tooLow = await post(49);
      assert.equal(tooLow.status, 400);
      const tooHigh = await post(101);
      assert.equal(tooHigh.status, 400);
      assert.deepEqual(calls, []);

      const ok = await post(100);
      assert.equal(ok.status, 200);
      const status = (await ok.json()) as { vehicle: { chargeLimitSoc: number } };
      assert.equal(status.vehicle.chargeLimitSoc, 100);
      assert.deepEqual(calls, [100]);
      assert.equal(controller.getStatus().vehicle?.chargeLimitSoc, 100);
      assert.equal(telemetry.getHint(vin)?.chargeLimitSoc, 100);

      // A tick that already read the old snapshot must not stick the card at 80%.
      internal.status.vehicle = { ...vehicle, chargeLimitSoc: 80 };
      internal.lastPolledVehicle = { ...vehicle, chargeLimitSoc: 80 };
      internal.reapplyCommandedChargeLimit();
      assert.equal(controller.getStatus().vehicle?.chargeLimitSoc, 100);

      // A later line that isn't ChargeLimitSoc must not wipe the commanded value.
      ingest.handleLine(JSON.stringify({ vin, msg: "record_payload", data: { Soc: 75 } }));
      assert.equal(telemetry.getHint(vin)?.chargeLimitSoc, 100);
      internal.status.vehicle = { ...vehicle, chargeLimitSoc: 80 };
      internal.reapplyCommandedChargeLimit();
      assert.equal(controller.getStatus().vehicle?.chargeLimitSoc, 100);

      // A ChargeLimitSoc reading from after the command wins, including a real 90.
      ingest.handleLine(JSON.stringify({ vin, msg: "record_payload", data: { ChargeLimitSoc: 90 } }));
      assert.equal(telemetry.getHint(vin)?.chargeLimitSoc, 90);
      internal.status.vehicle = {
        ...vehicle,
        chargeLimitSoc: telemetry.getHint(vin)!.chargeLimitSoc,
      };
      internal.reapplyCommandedChargeLimit();
      assert.equal(internal.commandedChargeLimit, null);
      assert.equal(controller.getStatus().vehicle?.chargeLimitSoc, 90);

      rejectWith = "Tesla rejected set_charge_limit: could_not_wake_buses";
      const before = controller.getStatus().vehicle?.chargeLimitSoc;
      const rejected = await post(100);
      assert.equal(rejected.status, 502);
      const rejectedBody = (await rejected.json()) as { error: string };
      assert.match(rejectedBody.error, /could_not_wake_buses/);
      assert.equal(controller.getStatus().vehicle?.chargeLimitSoc, before);
      assert.deepEqual(calls, [100, 100]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
