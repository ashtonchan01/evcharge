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
const { hashPasswordForSemsPlus } = await import("../src/goodwe/semsPlus.js");

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

const SEMS_PLUS_LOGIN = "https://au-semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login";
const SEMS_PLUS_API = "https://au-gateway.semsportal.com/web/sems";

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function clientFor(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): {
  client: InstanceType<typeof GoodweSemsClient>;
  calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[];
} {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: headerRecord(init?.headers),
    });
    return handler(url, init);
  };
  return {
    client: new GoodweSemsClient("acct", "pwd", "station-1", BASE, fetchImpl, { deviceId: "fixture-device" }),
    calls,
  };
}

function semsPlusLoginOk(): Response {
  return jsonResponse({
    code: "00000",
    msg: "success",
    data: {
      uid: "user-1",
      timestamp: 1730000000000,
      token: "session-token",
      client: "semsPlusWeb",
      version: "",
      language: "en",
      api: SEMS_PLUS_API,
      region: "au",
      uuid: "server-device",
    },
  });
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

test("live GetPowerflow shape: 1051W pv, 1365W load, 314W grid importing", () => {
  const snap = snapshotFromPowerflow({
    pv: "1051W",
    load: "1365W",
    grid: "314W",
    gridStatus: -1,
  });
  assert.equal(snap.pvPowerW, 1051);
  assert.equal(snap.loadPowerW, 1365);
  assert.equal(snap.gridPowerW, -314);
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
    [SEMS_PLUS_LOGIN, `${BASE}/v2/Common/CrossLogin`, `${BASE}/v2/PowerStation/GetPowerflow`]
  );
  const powerflowCall = calls.find((call) => call.url.endsWith("/v2/PowerStation/GetPowerflow"));
  assert.equal(
    powerflowCall?.body && (powerflowCall.body as { powerStationId: string }).powerStationId,
    "station-1"
  );
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

test("getSnapshot throws when SEMS+ and classic payloads have no powerflow", async () => {
  const { client } = clientFor((url) => {
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    return jsonResponse({ code: 0, data: {} });
  });

  await assert.rejects(client.getSnapshot(), /SEMS solar unavailable/);
});

test("getSnapshot uses SEMS+ flow watts and does not call classic GetPowerflow", async () => {
  const { client, calls } = clientFor((url) => {
    if (url === SEMS_PLUS_LOGIN) return semsPlusLoginOk();
    if (url.startsWith(`${SEMS_PLUS_API}/sems-plant/api/stations/flow`)) {
      return jsonResponse({
        code: "00000",
        data: {
          pAc: 0.57,
          pSystem: 0.57,
          pConsum: 0.297,
          pGrid: 0.273,
          status: "1",
          refreshTime: "2026-11-03 08:22:00",
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 570);
  assert.equal(snap.loadPowerW, 297);
  assert.equal(snap.gridPowerW, 273);
  assert.ok(calls.every((call) => !call.url.includes("GetPowerflow")));
  assert.equal(calls[0]?.url, SEMS_PLUS_LOGIN);
  assert.equal((calls[0]?.body as { pwd?: string } | null)?.pwd, hashPasswordForSemsPlus("pwd"));
  const loginToken = JSON.parse(calls[0]?.headers.token ?? "{}") as { client?: string; token?: string };
  assert.equal(loginToken.client, "semsPlusWeb");
  assert.equal(loginToken.token, "");
  assert.equal(calls[0]?.headers.origin ?? calls[0]?.headers.Origin, "https://au-semsplus.goodwe.com");

  const flow = calls[1];
  assert.ok(flow);
  assert.equal(flow.method, "GET");
  assert.equal(new URL(flow.url).searchParams.get("stationId"), "station-1");
  const flowToken = JSON.parse(flow.headers.token ?? "{}") as {
    uid?: string;
    token?: string;
    api?: string;
    region?: string;
    uuid?: string;
  };
  assert.equal(flowToken.uid, "user-1");
  assert.equal(flowToken.token, "session-token");
  assert.equal((flowToken as { timestamp?: unknown }).timestamp, 1730000000000);
  assert.equal(flowToken.api, SEMS_PLUS_API);
  assert.equal(flowToken.region, "au");
  assert.equal(flowToken.uuid, "server-device");
  assert.ok(flow.headers["x-signature"] || flow.headers["X-Signature"]);
  assert.match(flow.headers.traceparent ?? flow.headers.Traceparent ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("explicit SEMS+ zeros are a real standby reading, not an error", async () => {
  const { client, calls } = clientFor((url) => {
    if (url === SEMS_PLUS_LOGIN) return semsPlusLoginOk();
    if (url.startsWith(`${SEMS_PLUS_API}/sems-plant/api/stations/flow`)) {
      return jsonResponse({
        code: "00000",
        data: { pAc: 0, pSystem: 0, pConsum: 0, pGrid: 0, status: "0" },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 0);
  assert.equal(snap.loadPowerW, 0);
  assert.equal(snap.gridPowerW, 0);
  assert.ok(calls.every((call) => !call.url.includes("GetPowerflow")));
});

test("classic explicit 0W is used when SEMS+ login fails", async () => {
  const { client } = clientFor((url) => {
    if (url === SEMS_PLUS_LOGIN) return jsonResponse({ code: "C0602", msg: "账号登录异常" });
    if (url.endsWith("/v2/Common/CrossLogin")) return loginOk();
    if (url.endsWith("/v2/PowerStation/GetPowerflow")) {
      return jsonResponse({
        code: 0,
        data: { pv: "0W", load: "0W", grid: "0W", gridStatus: 0 },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const snap = await client.getSnapshot();
  assert.equal(snap.pvPowerW, 0);
  assert.equal(snap.loadPowerW, 0);
  assert.equal(snap.gridPowerW, 0);
});

test("a failed SEMS+ poll keeps the last solar snapshot and sets lastError", async () => {
  process.env.TESLA_HOLDS_PATH = "/tmp/evcharge-sems-plus-holds-missing.json";
  process.env.ACTIVE_VEHICLE_PATH = `/tmp/evcharge-sems-plus-vehicle-${process.pid}.json`;
  const { ChargeController } = await import("../src/controller/index.js");
  const good = {
    timestamp: new Date(),
    pvPowerW: 570,
    loadPowerW: 297,
    gridPowerW: 273,
    batteryPowerW: 0,
    batterySoc: null,
  };
  let calls = 0;
  const goodwe = {
    async getSnapshot() {
      calls += 1;
      if (calls === 1) return good;
      throw new Error("SEMS solar unavailable: SEMS+ stations/flow failed; classic SEMS had no usable powerflow");
    },
  };
  const tesla = { getVehicleTag: () => "tag", setVehicleTag() {} };
  const controller = new ChargeController(goodwe as never, tesla as never, null);
  const tick = (controller as unknown as { tick(): Promise<void> }).tick.bind(controller);

  await tick();
  assert.equal(controller.getStatus().solar?.pvPowerW, 570);
  assert.equal(controller.getStatus().lastError, null);

  await tick();
  assert.equal(controller.getStatus().solar?.pvPowerW, 570);
  assert.match(controller.getStatus().lastError ?? "", /SEMS solar unavailable/);
  assert.equal(controller.getStatus().decision, "unavailable");
});
