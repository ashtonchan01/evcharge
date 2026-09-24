import fetch from "cross-fetch";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "goodwe" });
const REQUEST_TIMEOUT_MS = 20_000;

/** Narrower than DOM `fetch` so tests can inject a string-URL stub. */
export type SemsFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: SemsFetch): Promise<Response> {
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
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(raceTimer!);
  }
}

export interface SolarSnapshot {
  timestamp: Date;
  pvPowerW: number;
  loadPowerW: number;
  /** Positive = exporting to grid, negative = importing from grid */
  gridPowerW: number;
  batteryPowerW: number;
  batterySoc: number | null;
}

interface SemsLoginResponse {
  data: {
    token: string;
    uid: string;
    timestamp: number;
    /** Region-specific API domain this account's token is actually valid against. */
    api?: string;
  };
  code: number;
  msg: string;
}

interface SemsTokenBundle {
  token: string;
  raw: string;
}

/**
 * Client for GoodWe's SEMS cloud portal. Community reverse-engineering
 * (e.g. home-assistant-goodwe-sems) shows the portal requires a first
 * "crosslogin" call to mint a token, then that token is echoed back as the
 * `token` header on subsequent calls - including calls made purely to
 * refresh region-specific base URLs. We cache the token bundle and refresh
 * it on 401s.
 */
export class GoodweSemsClient {
  private tokenBundle: SemsTokenBundle | null = null;
  private baseUrl: string;
  private readonly fetchImpl: SemsFetch;

  constructor(
    private readonly account: string,
    private readonly password: string,
    private readonly stationId: string,
    baseUrl: string,
    fetchImpl: SemsFetch = fetch
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  private async login(): Promise<SemsTokenBundle> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/v2/Common/CrossLogin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          token: JSON.stringify({
            uid: "",
            timestamp: 0,
            token: "",
            client: "web",
            version: "",
            language: "en",
          }),
        },
        body: JSON.stringify({ account: this.account, pwd: this.password }),
      },
      this.fetchImpl
    );

    if (!res.ok) {
      throw new Error(`SEMS login failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as SemsLoginResponse;
    if (!body.data?.token) {
      throw new Error(`SEMS login rejected: ${body.msg ?? "unknown error"}`);
    }

    if (body.data.api) {
      const regionalBaseUrl = body.data.api.replace(/\/+$/, "");
      if (regionalBaseUrl !== this.baseUrl) {
        log.debug(
          { from: this.baseUrl, to: regionalBaseUrl },
          "Switching to account's region-specific SEMS API domain"
        );
        this.baseUrl = regionalBaseUrl;
      }
    }

    const raw = JSON.stringify({
      uid: body.data.uid,
      timestamp: body.data.timestamp,
      token: body.data.token,
      client: "web",
      version: "",
      language: "en",
    });

    return { token: body.data.token, raw };
  }

  private async getTokenBundle(forceRefresh = false): Promise<SemsTokenBundle> {
    if (!this.tokenBundle || forceRefresh) {
      log.debug("Refreshing SEMS session token");
      this.tokenBundle = await this.login();
    }
    return this.tokenBundle;
  }

  private async postWithAuth<T>(path: string, payload: unknown): Promise<T> {
    let bundle = await this.getTokenBundle();

    const doRequest = async (t: SemsTokenBundle) =>
      fetchWithTimeout(
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            token: t.raw,
          },
          body: JSON.stringify(payload),
        },
        this.fetchImpl
      );

    let res = await doRequest(bundle);
    if (res.status === 401) {
      bundle = await this.getTokenBundle(true);
      res = await doRequest(bundle);
    }

    if (!res.ok) {
      throw new Error(`SEMS request to ${path} failed: HTTP ${res.status}`);
    }

    let json = (await res.json()) as { code?: number; msg?: string } & T;
    // SEMS reports expired/invalid sessions as HTTP 200 with an
    // application-level error code rather than HTTP 401 - retry once
    // with a forced re-login when that happens.
    if (json.code === 100002) {
      bundle = await this.getTokenBundle(true);
      res = await doRequest(bundle);
      if (!res.ok) {
        throw new Error(`SEMS request to ${path} failed: HTTP ${res.status}`);
      }
      json = (await res.json()) as { code?: number; msg?: string } & T;
    }

    return json;
  }

  /**
   * Fetch the latest real-time power figures for the configured power
   * station.
   *
   * `GetMonitorDetailByPowerstationId` used to embed `data.powerflow`. It
   * now often returns HTTP 200 / code 0 with an empty `data` object, which
   * made every reading look like 0W. `GetPowerflow` still returns the live
   * block (`pv` / `load` / `grid` as `376W` or the older `2690(W)`). Use
   * that first, and fall back to monitor detail when it still has a
   * powerflow (or when GetPowerflow itself fails).
   */
  async getSnapshot(): Promise<SolarSnapshot> {
    const flowBody = await this.tryPost<{ code?: number | string; msg?: string; data?: unknown }>(
      "/v2/PowerStation/GetPowerflow",
      { powerStationId: this.stationId }
    );
    const fromFlow = flowBody ? extractPowerflow(flowBody.data) : null;
    if (fromFlow) {
      log.debug({ powerflow: fromFlow.powerflow }, "Using SEMS GetPowerflow for the station snapshot");
      return snapshotFromPowerflow(fromFlow.powerflow, fromFlow.info);
    }

    log.debug("GetPowerflow had no powerflow; falling back to GetMonitorDetailByPowerstationId");
    const detailBody = await this.postWithAuth<{ data?: unknown }>(
      "/v2/PowerStation/GetMonitorDetailByPowerstationId",
      { powerStationId: this.stationId }
    );
    log.debug({ body: detailBody }, "Raw SEMS monitor-detail response");
    const fromDetail = extractPowerflow(detailBody.data);
    return snapshotFromPowerflow(fromDetail?.powerflow ?? {}, fromDetail?.info ?? {});
  }

  /**
   * Like postWithAuth, but a transport error or a non-success SEMS code
   * returns null so getSnapshot can try the other endpoint. Session
   * expiry (code 100002) is still retried inside postWithAuth.
   */
  private async tryPost<T extends { code?: number | string; msg?: string }>(
    path: string,
    payload: unknown
  ): Promise<T | null> {
    try {
      const body = await this.postWithAuth<T>(path, payload);
      if (!isSemsSuccess(body)) {
        log.debug({ path, code: body.code, msg: body.msg }, "SEMS call returned a non-success code");
        return null;
      }
      return body;
    } catch (err) {
      log.debug({ path, err: err instanceof Error ? err.message : String(err) }, "SEMS call failed");
      return null;
    }
  }
}

function isSemsSuccess(body: { code?: number | string }): boolean {
  return body.code === undefined || body.code === 0 || body.code === "0";
}

const POWERFLOW_KEYS = ["pv", "load", "grid", "bettery", "battery"] as const;

function hasPowerReadings(record: Record<string, unknown>): boolean {
  return POWERFLOW_KEYS.some((key) => {
    const value = record[key];
    return value !== undefined && value !== null && value !== "";
  });
}

export interface ExtractedPowerflow {
  powerflow: Record<string, unknown>;
  info: Record<string, unknown>;
}

/**
 * GetPowerflow returns the powerflow object as `data`. Monitor detail
 * nests it under `data.powerflow` (with station `data.info` beside it).
 * An empty object is not a reading.
 */
export function extractPowerflow(data: unknown): ExtractedPowerflow | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const info =
    record.info && typeof record.info === "object" && !Array.isArray(record.info)
      ? (record.info as Record<string, unknown>)
      : {};

  const nested = record.powerflow;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const powerflow = nested as Record<string, unknown>;
    if (hasPowerReadings(powerflow)) return { powerflow, info };
  }

  if (hasPowerReadings(record)) return { powerflow: record, info };
  return null;
}

export function snapshotFromPowerflow(
  powerflow: Record<string, unknown>,
  info: Record<string, unknown> = {},
  timestamp = new Date()
): SolarSnapshot {
  const pvW = parseWatts(powerflow.pv) ?? 0;
  const loadW = parseWatts(powerflow.load) ?? 0;
  // sic - GoodWe's own field name typo is `bettery`; accept `battery` too.
  const batteryW = parseWatts(powerflow.bettery ?? powerflow.battery) ?? 0;
  const gridW = signedGridPowerW(powerflow, pvW, loadW);

  const hasBattery = Number(info.battery_capacity ?? 0) > 0;
  const soc = hasBattery ? numberOrNull(powerflow.soc) : null;

  return {
    timestamp,
    pvPowerW: pvW,
    loadPowerW: loadW,
    gridPowerW: gridW,
    batteryPowerW: batteryW,
    batterySoc: soc,
  };
}

/**
 * App convention: positive grid watts are export, negative are import.
 * SEMS reports `grid` as an unsigned magnitude (`376W` or `2690(W)`) and
 * puts direction on `gridStatus` (-1 importing, 0 idle, 1 exporting).
 * Without that status, keep the previous pv - load estimate so an older
 * monitor-detail payload does not flip sign.
 */
function signedGridPowerW(powerflow: Record<string, unknown>, pvW: number, loadW: number): number {
  const raw = parseWatts(powerflow.grid);
  if (raw === null) return pvW - loadW;

  const status = numberOrNull(powerflow.gridStatus);
  if (status === null) return raw < 0 ? raw : pvW - loadW;

  const magnitude = Math.abs(raw);
  if (status === 1) return magnitude;
  if (status === -1) return -magnitude;
  if (status === 0) return 0;
  return pvW - loadW;
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

/** SEMS power strings are either `376W` or the older `2690(W)` / `216.52(W)`. */
export function parseWatts(v: unknown): number | null {
  if (typeof v !== "string") return numberOrNull(v);
  const match = v.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function createGoodweClient(): GoodweSemsClient {
  return new GoodweSemsClient(
    config.goodwe.account,
    config.goodwe.password,
    config.goodwe.stationId,
    config.goodwe.baseUrl
  );
}
