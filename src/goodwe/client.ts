import fetch from "cross-fetch";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "goodwe" });

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

  constructor(
    private readonly account: string,
    private readonly password: string,
    private readonly stationId: string,
    baseUrl: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async login(): Promise<SemsTokenBundle> {
    const res = await fetch(`${this.baseUrl}/v2/Common/CrossLogin`, {
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
    });

    if (!res.ok) {
      throw new Error(`SEMS login failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as SemsLoginResponse;
    if (!body.data?.token) {
      throw new Error(`SEMS login rejected: ${body.msg ?? "unknown error"}`);
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
      fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          token: t.raw,
        },
        body: JSON.stringify(payload),
      });

    let res = await doRequest(bundle);
    if (res.status === 401) {
      bundle = await this.getTokenBundle(true);
      res = await doRequest(bundle);
    }

    if (!res.ok) {
      throw new Error(`SEMS request to ${path} failed: HTTP ${res.status}`);
    }

    return (await res.json()) as T;
  }

  /**
   * Fetch the latest real-time power figures for the configured power
   * station. Falls back gracefully across the couple of shapes the SEMS
   * portal is known to return depending on inverter generation.
   */
  async getSnapshot(): Promise<SolarSnapshot> {
    const body = await this.postWithAuth<{ data: Record<string, unknown> }>(
      "/v2/PowerStation/GetMonitorDetailByPowerstationId",
      { powerStationId: this.stationId }
    );

    const data = body.data ?? {};
    const kpi = (data.kpi ?? {}) as Record<string, unknown>;

    const pvKw = numberOrNull(kpi.pac) ?? numberOrNull(data.pac) ?? 0;
    const loadKw = numberOrNull(kpi.load) ?? numberOrNull(data.loadPower) ?? 0;
    const gridKw =
      numberOrNull(kpi.grid) ?? numberOrNull(data.gridPower) ?? pvKw - loadKw;
    const batteryKw = numberOrNull(kpi.battery) ?? numberOrNull(data.batteryPower) ?? 0;
    const soc = numberOrNull((data.soc as Record<string, unknown> | undefined)?.power ?? data.soc);

    return {
      timestamp: new Date(),
      pvPowerW: kwToW(pvKw),
      loadPowerW: kwToW(loadKw),
      gridPowerW: kwToW(gridKw),
      batteryPowerW: kwToW(batteryKw),
      batterySoc: soc,
    };
  }
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// SEMS reports most kpi figures in kW; the rest of this app works in watts.
function kwToW(kw: number): number {
  return Math.round(kw * 1000);
}

export function createGoodweClient(): GoodweSemsClient {
  return new GoodweSemsClient(
    config.goodwe.account,
    config.goodwe.password,
    config.goodwe.stationId,
    config.goodwe.baseUrl
  );
}
