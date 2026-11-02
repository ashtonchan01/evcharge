import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildXSignature,
  hashPasswordForSemsPlus,
  kwToWatts,
  parseSemsPlusFlow,
  readOrCreateDeviceId,
  resolveSemsPlusWebOrigin,
} from "../src/goodwe/semsPlus.js";

test("SEMS+ password is base64 of the md5 hex, not the raw digest", () => {
  const password = "hunter2";
  const md5Hex = createHash("md5").update(password, "utf8").digest("hex");
  assert.equal(hashPasswordForSemsPlus(password), Buffer.from(md5Hex, "utf8").toString("base64"));
  assert.notEqual(hashPasswordForSemsPlus(password), Buffer.from(md5Hex, "hex").toString("base64"));
  assert.notEqual(hashPasswordForSemsPlus(password), password);
});

test("X-Signature is base64 of sha256(ts@uid@token) at ts", () => {
  const ts = 1_700_000_000_000;
  const decoded = Buffer.from(buildXSignature("uid", "tok", ts), "base64").toString("utf8");
  const hash = createHash("sha256").update(`${ts}@uid@tok`, "utf8").digest("hex");
  assert.equal(decoded, `${hash}@${ts}`);
  const loginSig = Buffer.from(buildXSignature("", "", ts), "base64").toString("utf8");
  const emptyHash = createHash("sha256").update(`${ts}@@`, "utf8").digest("hex");
  assert.equal(loginSig, `${emptyHash}@${ts}`);
});

test("classic portal base URL still selects the AU SEMS+ web origin", () => {
  assert.equal(resolveSemsPlusWebOrigin("https://www.semsportal.com/api"), "https://au-semsplus.goodwe.com");
  assert.equal(
    resolveSemsPlusWebOrigin("https://www.semsportal.com/api", "https://eu-semsplus.goodwe.com/"),
    "https://eu-semsplus.goodwe.com"
  );
  assert.equal(
    resolveSemsPlusWebOrigin("https://hk-semsplus.goodwe.com/anything"),
    "https://hk-semsplus.goodwe.com"
  );
});

test("live SEMS+ sample maps kW to watts with positive grid as export", () => {
  const snap = parseSemsPlusFlow({
    code: "00000",
    data: { pAc: 0.57, pSystem: 0.57, pConsum: 0.297, pGrid: 0.273, status: "1" },
  });
  assert.equal(snap?.pvPowerW, kwToWatts(0.57));
  assert.equal(snap?.loadPowerW, 297);
  assert.equal(snap?.gridPowerW, 273);
  assert.equal(snap?.pvPowerW, 570);
});

test("explicit numeric zeros are a snapshot, missing power fields are not", () => {
  const zeros = parseSemsPlusFlow({
    data: { pAc: 0, pConsum: 0, pGrid: 0, status: "0" },
  });
  assert.equal(zeros?.pvPowerW, 0);
  assert.equal(zeros?.loadPowerW, 0);
  assert.equal(zeros?.gridPowerW, 0);
  assert.equal(parseSemsPlusFlow({ data: {} }), null);
  assert.equal(parseSemsPlusFlow({ data: { status: "1", refreshTime: "2026-11-03 08:22:00" } }), null);
  assert.equal(parseSemsPlusFlow({ data: { pAc: 0.4 } }), null);
});

test("pSystem is used when pAc is absent, including a nested flow object", () => {
  const snap = parseSemsPlusFlow({
    data: { flow: { pSystem: "1.25", pConsum: 0.2, pGrid: -0.1, soc: 40 } },
  });
  assert.equal(snap?.pvPowerW, 1250);
  assert.equal(snap?.loadPowerW, 200);
  assert.equal(snap?.gridPowerW, -100);
  assert.equal(snap?.batterySoc, 40);
});

test("blank or zero pConsum while solar is exporting uses the flow balance for home load", () => {
  // Portal identity: pSystem = pConsum + pGrid − pBat, so a stuck 0 load is 5.783 − 5.02 = 0.763 kW.
  const blank = parseSemsPlusFlow({
    data: { pSystem: 5.783, pAc: 5.783, pBat: 0, pGrid: 5.02, pConsum: " ", consumFlag: false },
  });
  assert.equal(blank?.pvPowerW, 5783);
  assert.equal(blank?.loadPowerW, 763);
  assert.equal(blank?.gridPowerW, 5020);

  const stuckZero = parseSemsPlusFlow({
    data: { pSystem: 5.783, pAc: 5.783, pBat: 0, pGrid: 5.02, pConsum: 0 },
  });
  assert.equal(stuckZero?.loadPowerW, 763);
});

test("a non-zero pConsum or pLoad is kept, and a fully idle plant stays 0 W", () => {
  const trusted = parseSemsPlusFlow({
    data: { pAc: 5.783, pSystem: 5.783, pConsum: 0.4, pLoad: 9, pGrid: 5.02, pBat: 0 },
  });
  assert.equal(trusted?.loadPowerW, 400);

  const otherName = parseSemsPlusFlow({
    data: { pAc: 2, pConsum: 0, pLoad: 1.8, pGrid: 0.2 },
  });
  assert.equal(otherName?.loadPowerW, 1800);

  const night = parseSemsPlusFlow({
    data: { pAc: 0, pSystem: 0, pConsum: 0, pGrid: 0, pBat: 0 },
  });
  assert.equal(night?.loadPowerW, 0);
  assert.equal(night?.pvPowerW, 0);
});

test("night grid import derives house load, and export that already matches PV does not invent one", () => {
  const importing = parseSemsPlusFlow({
    data: { pAc: 0, pSystem: 0, pGrid: -1.351, pBat: 0 },
  });
  assert.equal(importing?.pvPowerW, 0);
  assert.equal(importing?.loadPowerW, 1351);
  assert.equal(importing?.gridPowerW, -1351);

  // 4.522 kW solar and 4.644 kW export: the balance is ~0, so home stays 0 rather than a made-up baseload.
  const exporting = parseSemsPlusFlow({
    data: { pAc: 4.522, pConsum: 0, pGrid: 4.644 },
  });
  assert.equal(exporting?.pvPowerW, 4522);
  assert.equal(exporting?.loadPowerW, 0);
  assert.equal(exporting?.gridPowerW, 4644);
});

test("battery discharge at night is part of the load balance", () => {
  // pSystem 0, pBat 1.1793 discharge, pGrid 0.149 export → load 1.0303 kW.
  const snap = parseSemsPlusFlow({
    data: { pSystem: 0, pAc: 1.1793, pBat: 1.1793, pGrid: 0.149, pConsum: " " },
  });
  assert.equal(snap?.loadPowerW, 1030);
  assert.equal(snap?.batteryPowerW, 1179);
});

test("device uuid is stable across reads of the same file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sems-device-"));
  const file = path.join(dir, "device-id");
  const first = readOrCreateDeviceId(file);
  assert.equal(readOrCreateDeviceId(file), first);
  assert.equal(readFileSync(file, "utf8").trim(), first);
});
