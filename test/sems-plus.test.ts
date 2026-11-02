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

test("device uuid is stable across reads of the same file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sems-device-"));
  const file = path.join(dir, "device-id");
  const first = readOrCreateDeviceId(file);
  assert.equal(readOrCreateDeviceId(file), first);
  assert.equal(readFileSync(file, "utf8").trim(), first);
});
