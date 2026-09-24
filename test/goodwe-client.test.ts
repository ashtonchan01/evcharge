import assert from "node:assert/strict";
import { test } from "node:test";

// client.ts loads config, which exits if these are missing. Set fixtures
// before the import so the suite does not need a real .env.
process.env.GOODWE_SEMS_ACCOUNT ??= "fixture";
process.env.GOODWE_SEMS_PASSWORD ??= "fixture";
process.env.GOODWE_STATION_ID ??= "fixture-station";
process.env.TESLA_CLIENT_ID ??= "fixture";
process.env.TESLA_CLIENT_SECRET ??= "fixture";
process.env.TESLA_REFRESH_TOKEN ??= "fixture";
process.env.TESLA_VEHICLE_TAG ??= "fixture";

const { GoodweSemsClient, extractPowerflow, parseWatts, snapshotFromPowerflow } = await import(
  "../src/goodwe/client.js"
);

const BASE = "https://www.semsportal.com/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loginOk(): Response {
  return jsonResponse({
    code: 0,
    msg: "success",
    data: { token: "tok", uid: "uid", timestamp: 1 },
  });
}

function clientFor(
  handler: (url: string) => Response | Promise<Response>
): { client: InstanceType<typeof GoodweSemsClient>; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(url);
  };
  return {
    client: new GoodweSemsClient("acct", "pwd", "station-1", BASE, fetchImpl),
    calls,
  };
}

test("parseWatts accepts 376W and 2690(W)", () => {
  assert.equal(parseWatts("376W"), 376);
  assert.equal(parseWatts("0W"), 0);
  assert.equal(parseWatts("2690(W)"), 2690);
  assert.equal(parseWatts("216.52(W)"), 216.52);
  assert.equal(parseWatts("-40.5W"), -40.5);
  assert.equal(parseWatts(12), 12);
  assert.equal(parseWatts("nope"), null);
});

test("night GetPowerflow shape: gridStatus -1 is import", () => {
  const snap = snapshotFromPowerflow({
    pv: "0W",
    load: "376W",
    grid: "376W",
    gridStatus: -1,
    bettery: "0W",
  });
  assert.equal(snap.pvPowerW, 0);
  assert.equal(snap.loadPowerW, 376);
  assert.equal(snap.gridPowerW, -376);
  assert.equal(snap.batteryPowerW, 0);
  assert.equal(snap.batterySoc, null);
});

test("older watt strings with gridStatus 1 are export", () => {
  const snap = snapshotFromPowerflow(
    {
      pv: "2690(W)",
      load: "1000(W)",
      grid: "1690(W)",
      gridStatus: "1",
      bettery: "0(W)",
      soc: 80,
    },
    { battery_capacity: 5000 }
  );
  assert.equal(snap.pvPowerW, 2690);
  assert.equal(snap.loadPowerW, 1000);
  assert.equal(snap.gridPowerW, 1690);
  assert.equal(snap.batterySoc, 80);
});

test("unsigned grid without gridStatus keeps the pv - load sign", () => {
  const snap = snapshotFromPowerflow({
    pv: "2690(W)",
    load: "1000(W)",
    grid: "5000(W)",
  });
  assert.equal(snap.gridPowerW, 1690);
});

test("gridStatus 0 is idle even if the magnitude is non-zero", () => {
  const snap = snapshotFromPowerflow({ pv: "0W", load: "10W", grid: "10W", gridStatus: 0 });
  assert.equal(snap.gridPowerW, 0);
});

test("extractPowerflow treats an empty monitor-detail data object as missing", () => {
  assert.equal(extractPowerflow({}), null);
  assert.equal(extractPowerflow(null), null);
  assert.equal(extractPowerflow({ powerflow: {} }), null);
  const nested = extractPowerflow({
    info: { battery_capacity: 1 },
    powerflow: { pv: "1(W)", load: "2(W)" },
  });
  assert.equal(nested?.powerflow.pv, "1(W)");
  assert.equal(nested?.info.battery_capacity, 1);
});

test("getSnapshot uses GetPowerflow and skips empty monitor detail", async () => {
  const { client, calls } = clientFor((url) => {
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    if (url.endsWith("/v2/PowerStation/GetPowerflow")) {
      return jsonResponse({
        code: 0,
        msg: "success",
        data: { pv: "0W", load: "376W", grid: "376W", gridStatus: -1, bettery: "0W" },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 0);
  assert.equal(snap.loadPowerW, 376);
  assert.equal(snap.gridPowerW, -376);
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${BASE}/v2/Common/CrossLogin`, `${BASE}/v2/PowerStation/GetPowerflow`]
  );
  assert.equal(calls[1].body && (calls[1].body as { powerStationId: string }).powerStationId, "station-1");
});

test("getSnapshot falls back to monitor detail when GetPowerflow data is empty", async () => {
  const { client, calls } = clientFor((url) => {
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    if (url.endsWith("/v2/PowerStation/GetPowerflow")) {
      return jsonResponse({ code: 0, msg: "success", data: {} });
    }
    if (url.endsWith("/v2/PowerStation/GetMonitorDetailByPowerstationId")) {
      return jsonResponse({
        code: 0,
        msg: "success",
        data: {
          info: { battery_capacity: 0 },
          powerflow: { pv: "2690(W)", load: "800(W)", grid: "1890(W)", gridStatus: 1, bettery: "0(W)" },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 2690);
  assert.equal(snap.loadPowerW, 800);
  assert.equal(snap.gridPowerW, 1890);
  assert.ok(calls.some((call) => call.url.endsWith("/v2/PowerStation/GetMonitorDetailByPowerstationId")));
});

test("getSnapshot falls back when GetPowerflow returns a non-success code", async () => {
  const { client } = clientFor((url) => {
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    if (url.endsWith("/v2/PowerStation/GetPowerflow")) {
      return jsonResponse({ code: 100001, msg: "nope", data: null });
    }
    if (url.endsWith("/v2/PowerStation/GetMonitorDetailByPowerstationId")) {
      return jsonResponse({
        code: 0,
        data: { powerflow: { pv: "10(W)", load: "40(W)", grid: "30(W)", gridStatus: -1 } },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 10);
  assert.equal(snap.loadPowerW, 40);
  assert.equal(snap.gridPowerW, -30);
});

test("getSnapshot returns zeros when both SEMS payloads are empty", async () => {
  const { client } = clientFor((url) => {
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    return jsonResponse({ code: 0, data: {} });
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 0);
  assert.equal(snap.loadPowerW, 0);
  assert.equal(snap.gridPowerW, 0);
});
