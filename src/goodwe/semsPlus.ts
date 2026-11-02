import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SolarSnapshot } from "./client.js";

/** Australia SEMS+ web app. Classic semsportal.com is not this host. */
export const DEFAULT_SEMS_PLUS_WEB_ORIGIN = "https://au-semsplus.goodwe.com";
/** Used only when login omits a trusted `data.api`. */
export const DEFAULT_SEMS_PLUS_API = "https://au-gateway.semsportal.com/web/sems";
export const DEFAULT_DEVICE_ID_PATH = join(process.cwd(), ".data", "device-id");

const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export type SemsPlusFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SemsPlusSession {
  uid: string;
  token: string;
  /** Kept as returned by login so the token header matches the browser session. */
  timestamp: string | number;
  api: string;
  region: string;
  uuid: string;
  client: string;
  version: string;
  language: string;
}

export interface SemsPlusRead {
  snapshot: SolarSnapshot | null;
  /** Set when snapshot is null. Never includes the account password or session token. */
  error: string | null;
}

/**
 * Classic `GOODWE_SEMS_BASE_URL` points at www.semsportal.com. Live power
 * for that account is on SEMS+, so keep the AU web origin unless the caller
 * sets one or the base URL is already a semsplus host.
 */
export function resolveSemsPlusWebOrigin(classicBaseUrl: string, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const url = new URL(classicBaseUrl);
    if (url.hostname.toLowerCase().includes("semsplus")) return url.origin;
  } catch {
    // Classic portal URLs are the common case; fall through to AU.
  }
  return DEFAULT_SEMS_PLUS_WEB_ORIGIN;
}

/** SEMS+ web login expects base64(md5 hex of the UTF-8 password), not the raw digest. */
export function hashPasswordForSemsPlus(password: string): string {
  const md5Hex = createHash("md5").update(password, "utf8").digest("hex");
  return Buffer.from(md5Hex, "utf8").toString("base64");
}

/** X-Signature = base64(`${sha256_hex(`${ts}@${uid}@${token}`)}@${ts}`). */
export function buildXSignature(uid: string, token: string, ts: number = Date.now()): string {
  const hash = createHash("sha256").update(`${ts}@${uid}@${token}`, "utf8").digest("hex");
  return Buffer.from(`${hash}@${ts}`, "utf8").toString("base64");
}

export function buildTraceparent(): string {
  const randomHex = (byteCount: number) =>
    Array.from({ length: byteCount }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** Stable SEMS+ device uuid, same idea as the portal's localStorage `sems_device_id`. */
export function readOrCreateDeviceId(filePath: string): string {
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // Fall through and mint a new id.
  }
  const deviceId = randomUUID();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, deviceId, "utf8");
  } catch {
    // In-memory only when the disk is not writable.
  }
  return deviceId;
}

export function isSemsPlusSuccess(code: unknown): boolean {
  if (code === undefined || code === null) return true;
  if (code === 0 || code === 200) return true;
  if (typeof code === "string") {
    const normalized = code.replace(/^0+/, "") || "0";
    return normalized === "0" || normalized === "200";
  }
  return false;
}

function isTrustedApiBase(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host.endsWith(".semsportal.com") || host.endsWith(".goodwe.com");
  } catch {
    return false;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTimestamp(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return Date.now();
}

function clip(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * SEMS+ `stations/flow` power fields are kW. evcharge stores watts.
 * Positive grid watts are export, matching a live sample where
 * pAc 0.57 − pConsum 0.297 = pGrid 0.273.
 * An explicit numeric 0 on an idle plant is a real standby reading.
 * A blank `pConsum` (`" "`) is missing, not a measured 0 W house.
 */
export function kwToWatts(kw: number): number {
  return Math.round(kw * 1000);
}

/** One field. Blank strings and dashes are missing, not zero. `Number(" ")` is 0, which hid home load. */
function readKw(record: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "--") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = readKw(record, key);
    if (parsed !== null) return parsed;
  }
  return null;
}

const LOAD_KEYS = ["pConsum", "pLoad", "pload", "pConsumption", "consumption"] as const;

/**
 * Home load in kW.
 * A non-zero meter field wins (`pConsum`, then the other load names).
 * An exact 0 or a blank field while power is flowing uses the SEMS+ balance
 * `load = pSystem − pGrid + pBat` (pBat > 0 is discharge, pGrid > 0 is export).
 * That identity is what the portal's flow samples satisfy. An idle plant
 * (pv, grid, and battery all ~0) stays 0 — we do not invent a night baseload.
 * When export already accounts for generation, the balance is ~0 and stays 0.
 */
export function resolveHomeLoadKw(input: {
  reportedLoadKw: number | null;
  /** pSystem when the payload has it, otherwise the displayed PV (pAc). */
  pvBalanceKw: number;
  gridKw: number;
  batteryKw: number;
}): number {
  const idle =
    Math.abs(input.pvBalanceKw) < 0.02 &&
    Math.abs(input.gridKw) < 0.02 &&
    Math.abs(input.batteryKw) < 0.02;
  if (idle) return input.reportedLoadKw ?? 0;
  if (input.reportedLoadKw !== null && Math.abs(input.reportedLoadKw) >= 0.02) return input.reportedLoadKw;

  const derived = input.pvBalanceKw - input.gridKw + input.batteryKw;
  if (derived >= 0.02) return derived;
  if (derived > -0.02) return 0;
  return input.reportedLoadKw ?? 0;
}

function reportedLoadKw(record: Record<string, unknown>): number | null {
  let explicitZero = false;
  for (const key of LOAD_KEYS) {
    const parsed = readKw(record, key);
    if (parsed === null) continue;
    if (Math.abs(parsed) >= 0.0005) return parsed;
    explicitZero = true;
  }
  return explicitZero ? 0 : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function flatten(value: unknown, out: Record<string, unknown>): void {
  const record = asRecord(value);
  if (!record) return;
  for (const [key, nested] of Object.entries(record)) {
    if (asRecord(nested)) flatten(nested, out);
    else out[key] = nested;
  }
}

const POWER_KEYS = ["pAc", "pSystem", "pConsum", "pLoad", "pGrid"];

function hasPowerKey(record: Record<string, unknown>): boolean {
  return POWER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/** Find the object that actually carries pAc / pSystem / pConsum / pGrid. */
export function findSemsPlusPowerRecord(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  const data = asRecord(root.data) ?? root;
  for (const key of ["flow", "powerflow", "powerFlow"]) {
    const nested = asRecord(data[key]);
    if (nested && hasPowerKey(nested)) return nested;
  }
  if (hasPowerKey(data)) return data;
  const flat: Record<string, unknown> = {};
  flatten(data, flat);
  return hasPowerKey(flat) ? flat : null;
}

/**
 * Map a SEMS+ flow payload onto the controller snapshot.
 * Returns null when pv or grid is absent — that is not a 0W plant.
 *
 * - pAc, else pSystem (kW) → pvPowerW. pAc is what the verified AU sample matched.
 * - Home load: non-zero pConsum / pLoad, else the balance on pSystem (see resolveHomeLoadKw).
 * - pGrid (kW, positive = export) → gridPowerW
 * - pBat (kW, positive = discharge) → batteryPowerW when present
 * - soc → batterySoc when present
 */
export function parseSemsPlusFlow(payload: unknown, timestamp = new Date()): SolarSnapshot | null {
  const record = findSemsPlusPowerRecord(payload);
  if (!record) return null;
  const pvKw = firstFinite(record, ["pAc", "pSystem"]);
  const gridKw = firstFinite(record, ["pGrid"]);
  if (pvKw === null || gridKw === null) return null;
  const systemKw = readKw(record, "pSystem");
  const batteryKw = firstFinite(record, ["pBat", "pBattery"]);
  const loadKw = resolveHomeLoadKw({
    reportedLoadKw: reportedLoadKw(record),
    pvBalanceKw: systemKw !== null ? systemKw : pvKw,
    gridKw,
    batteryKw: batteryKw ?? 0,
  });
  const soc = firstFinite(record, ["soc", "batterySoc"]);
  return {
    timestamp,
    pvPowerW: kwToWatts(pvKw),
    loadPowerW: kwToWatts(loadKw),
    gridPowerW: kwToWatts(gridKw),
    batteryPowerW: batteryKw === null ? 0 : kwToWatts(batteryKw),
    batterySoc: soc,
  };
}

function emptyLoginToken(): string {
  return JSON.stringify({
    uid: "",
    timestamp: 0,
    token: "",
    client: "semsPlusWeb",
    version: "",
    language: "en",
  });
}

export function sessionTokenHeader(session: SemsPlusSession): string {
  return JSON.stringify({
    uid: session.uid,
    timestamp: session.timestamp,
    token: session.token,
    client: session.client,
    version: session.version,
    language: session.language,
    api: session.api,
    region: session.region,
    uuid: session.uuid,
  });
}

function browserHeaders(webOrigin: string, tokenJson: string, uid: string, token: string, uuid: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Origin: webOrigin,
    Referer: `${webOrigin}/`,
    "User-Agent": USER_AGENT,
    currentLang: "en",
    token: tokenJson,
    uuid,
    "X-Signature": buildXSignature(uid, token),
    brand: "Chrome 150.0.0.0 Google Inc. en-AU Australia/Perth",
    os: "macOS 10.15.7 desktop",
    neutral: "0",
    traceparent: buildTraceparent(),
    "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: SemsPlusFetch): Promise<Response> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let raceTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    raceTimer = setTimeout(
      () => reject(new Error(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
      REQUEST_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeoutPromise]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(raceTimer!);
  }
}

interface GatewayBody {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  data?: unknown;
}

function messageOf(body: GatewayBody): string {
  return clip(body.msg ?? body.message);
}

function looksLikeAuthFailure(body: GatewayBody): boolean {
  if (isSemsPlusSuccess(body.code)) return false;
  const code = String(body.code ?? "");
  const msg = messageOf(body);
  return code === "C0602" || /login|token|authoriz|signature|expired|abnormal/i.test(`${code} ${msg}`);
}

export class SemsPlusClient {
  private session: SemsPlusSession | null = null;
  private readonly webOrigin: string;
  private readonly deviceId: string;

  constructor(
    private readonly account: string,
    private readonly password: string,
    private readonly stationId: string,
    webOrigin: string,
    private readonly fetchImpl: SemsPlusFetch,
    deviceId?: string,
    deviceIdPath: string = DEFAULT_DEVICE_ID_PATH
  ) {
    this.webOrigin = webOrigin.replace(/\/+$/, "");
    this.deviceId = deviceId ?? readOrCreateDeviceId(deviceIdPath);
  }

  /**
   * Live plant flow. `snapshot` is set for any successful reading, including
   * explicit zeros. `error` is set when login/flow failed or the payload had
   * no power fields — the caller falls back to classic SEMS.
   */
  async readSnapshot(): Promise<SemsPlusRead> {
    try {
      let session = await this.login();
      let body = await this.getFlow(session);
      if (looksLikeAuthFailure(body)) {
        this.session = null;
        session = await this.login();
        body = await this.getFlow(session);
      }
      if (!isSemsPlusSuccess(body.code)) {
        const detail = messageOf(body);
        return {
          snapshot: null,
          error: `SEMS+ stations/flow failed (code=${String(body.code ?? "unknown")}${detail ? `: ${detail}` : ""})`,
        };
      }
      const snapshot = parseSemsPlusFlow(body);
      if (!snapshot) {
        return { snapshot: null, error: "SEMS+ stations/flow returned no pv/load/grid readings" };
      }
      return { snapshot, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { snapshot: null, error: clip(message) || "SEMS+ stations/flow failed" };
    }
  }

  private async login(): Promise<SemsPlusSession> {
    if (this.session) return this.session;
    const url = `${this.webOrigin}/web/sems/sems-user/api/v1/auth/cross-login`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          ...browserHeaders(this.webOrigin, emptyLoginToken(), "", "", this.deviceId),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          account: this.account,
          pwd: hashPasswordForSemsPlus(this.password),
          agreement: 1,
          isLocal: false,
          isChinese: false,
        }),
      },
      this.fetchImpl
    );
    const body = await readJson(res, "SEMS+ login");
    if (!isSemsPlusSuccess(body.code)) {
      const detail = messageOf(body);
      throw new Error(`SEMS+ login rejected (code=${String(body.code ?? "unknown")}${detail ? `: ${detail}` : ""})`);
    }
    const data = asRecord(body.data) ?? {};
    const uid = asNonEmptyString(data.uid);
    const token = asNonEmptyString(data.token);
    if (!uid || !token) throw new Error("SEMS+ login response missing uid/token");
    const apiCandidate = asNonEmptyString(data.api);
    const api =
      apiCandidate && isTrustedApiBase(apiCandidate) ? apiCandidate.replace(/\/+$/, "") : DEFAULT_SEMS_PLUS_API;
    this.session = {
      uid,
      token,
      timestamp: asTimestamp(data.timestamp),
      api,
      region: asNonEmptyString(data.region) ?? "au",
      uuid: asNonEmptyString(data.uuid) ?? this.deviceId,
      client: asNonEmptyString(data.client) ?? "semsPlusWeb",
      version: asNonEmptyString(data.version) ?? "",
      language: asNonEmptyString(data.language) ?? "en",
    };
    return this.session;
  }

  private async getFlow(session: SemsPlusSession): Promise<GatewayBody> {
    const url = new URL(`${session.api}/sems-plant/api/stations/flow`);
    url.searchParams.set("stationId", this.stationId);
    const res = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: browserHeaders(this.webOrigin, sessionTokenHeader(session), session.uid, session.token, session.uuid),
      },
      this.fetchImpl
    );
    return readJson(res, "SEMS+ stations/flow");
  }
}

async function readJson(res: Response, what: string): Promise<GatewayBody> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as GatewayBody;
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${res.status})`);
  }
}
