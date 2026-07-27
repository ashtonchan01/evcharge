import fetch from "cross-fetch";
import fs from "node:fs";
import https from "node:https";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "tesla" });

/** Carries the HTTP status so callers can distinguish "rate limited/account
 * disabled" (stop hammering) from an ordinary transient failure (retry). */
export class TeslaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "TeslaApiError";
  }
}

const TESLA_AUTH_URL = "https://auth.tesla.com/oauth2/v3/token";
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: Record<string, unknown>): Promise<Response> {
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
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeoutPromise]);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(raceTimer!);
  }
}

export interface VehicleChargeState {
  chargingState: string; // "Charging" | "Stopped" | "Complete" | "Disconnected" | ...
  chargeAmps: number;
  chargeLimitSoc: number;
  batteryLevel: number;
  chargerVoltage: number;
  chargerActualCurrent: number;
  pluggedIn: boolean;
  timestamp: Date;
}

export interface VehicleSummary {
  id: string;
  vin: string;
  displayName: string;
  state: string;
}

/**
 * Calls Tesla's Fleet API directly for reads (vehicle_data, wake_up,
 * listing vehicles), which works for any vehicle. Commands (start/stop
 * charging, set amps) are tried directly first, then automatically
 * retried through a local `tesla-http-proxy` (when TESLA_COMMAND_PROXY_URL
 * is set) if Tesla rejects the direct call as requiring its signed
 * "vehicle command protocol" - every vehicle except pre-2021 Model S/X.
 * This lets the same client transparently support either kind of vehicle
 * without needing to know in advance which one a given VIN is.
 */
export class TeslaFleetClient {
  private accessToken: string | null = null;
  private readonly baseUrl: string;
  private readonly commandProxyUrl: string | null;
  // The proxy serves a self-signed cert we generated ourselves for this
  // local loopback connection - trusting it here is scoped to just these
  // requests, not a global TLS bypass.
  private readonly proxyAgent = new https.Agent({ rejectUnauthorized: false });

  private refreshToken: string;

  constructor(
    baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    refreshToken: string,
    private vehicleTag: string,
    commandProxyUrl?: string,
    private readonly refreshTokenPath?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.commandProxyUrl = commandProxyUrl ? commandProxyUrl.replace(/\/+$/, "") : null;
    // A previously-persisted rotated token (see refreshAccessToken) is
    // always fresher than whatever's baked into .env, since .env only gets
    // updated by hand.
    const persisted = this.readPersistedRefreshToken();
    this.refreshToken = persisted ?? refreshToken;
  }

  private readPersistedRefreshToken(): string | undefined {
    if (!this.refreshTokenPath) return undefined;
    try {
      const contents = fs.readFileSync(this.refreshTokenPath, "utf8").trim();
      return contents || undefined;
    } catch {
      return undefined;
    }
  }

  getVehicleTag(): string {
    return this.vehicleTag;
  }

  setVehicleTag(tag: string): void {
    this.vehicleTag = tag;
  }

  private async refreshAccessToken(): Promise<string> {
    log.debug("Refreshing Tesla access token");
    const res = await fetchWithTimeout(TESLA_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }),
    });

    if (!res.ok) {
      throw new Error(`Tesla token refresh failed: HTTP ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { access_token: string; refresh_token?: string };
    this.accessToken = body.access_token;

    // Tesla's token endpoint can return a rotated refresh_token on any
    // grant - if it's silently discarded (as this used to do), the token
    // stored in .env eventually becomes stale and every future refresh
    // fails with "The refresh_token is invalid", with no warning until it
    // happens. Persist any new one immediately so a restart always uses
    // the latest, not whatever was in .env at initial setup.
    if (body.refresh_token && body.refresh_token !== this.refreshToken) {
      this.refreshToken = body.refresh_token;
      if (this.refreshTokenPath) {
        try {
          fs.writeFileSync(this.refreshTokenPath, body.refresh_token, "utf8");
          log.info({ path: this.refreshTokenPath }, "Tesla rotated the refresh token - persisted the new one");
        } catch (err) {
          log.error(
            { err: String(err), path: this.refreshTokenPath },
            "Tesla rotated the refresh token but persisting it to disk failed - the next restart will use a stale token and fail"
          );
        }
      } else {
        log.warn(
          "Tesla rotated the refresh token but TESLA_REFRESH_TOKEN_PATH isn't set, so it can't be persisted - the next restart will use the stale .env value and fail"
        );
      }
    }

    return this.accessToken;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts?: { baseUrl?: string; agent?: https.Agent }
  ): Promise<T> {
    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const targetBaseUrl = opts?.baseUrl ?? this.baseUrl;

    const doRequest = async (token: string) =>
      fetchWithTimeout(`${targetBaseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
        body: body ? JSON.stringify(body) : undefined,
        agent: opts?.agent,
      });

    let res = await doRequest(this.accessToken!);
    if (res.status === 401) {
      const fresh = await this.refreshAccessToken();
      res = await doRequest(fresh);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      throw new TeslaApiError(`Tesla request ${method} ${path} failed: HTTP ${res.status} ${text}`, res.status);
    }

    return parsed as T;
  }

  private async command(name: string, body?: unknown): Promise<void> {
    const path = `/api/1/vehicles/${this.vehicleTag}/command/${name}`;
    try {
      await this.request("POST", path, body ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.commandProxyUrl && message.includes("Vehicle Command Protocol required")) {
        log.info("Direct command rejected - retrying via signed-command proxy");
        await this.request("POST", path, body ?? {}, {
          baseUrl: this.commandProxyUrl,
          agent: this.proxyAgent,
        });
        return;
      }
      throw err;
    }
  }

  async listVehicles(): Promise<VehicleSummary[]> {
    const res = await this.request<{ response: Record<string, unknown>[] }>(
      "GET",
      "/api/1/vehicles"
    );
    return (res.response ?? []).map((v) => ({
      id: String(v.id_s ?? v.id),
      vin: String(v.vin),
      displayName: String(v.display_name ?? ""),
      state: String(v.state ?? "unknown"),
    }));
  }

  async getChargeState(): Promise<VehicleChargeState> {
    const res = await this.request<{ response: Record<string, unknown> }>(
      "GET",
      `/api/1/vehicles/${this.vehicleTag}/vehicle_data?endpoints=charge_state`
    );
    const cs = (res.response?.charge_state ?? {}) as Record<string, unknown>;

    return {
      chargingState: String(cs.charging_state ?? "Unknown"),
      chargeAmps: Number(cs.charge_amps ?? cs.charge_current_request ?? 0),
      chargeLimitSoc: Number(cs.charge_limit_soc ?? 0),
      batteryLevel: Number(cs.battery_level ?? 0),
      chargerVoltage: Number(cs.charger_voltage ?? 0),
      chargerActualCurrent: Number(cs.charger_actual_current ?? 0),
      pluggedIn: cs.charge_port_latch === "Engaged" || Boolean(cs.charge_port_door_open),
      timestamp: new Date(),
    };
  }

  async startCharging(): Promise<void> {
    log.info("Sending charge_start");
    await this.command("charge_start");
  }

  async stopCharging(): Promise<void> {
    log.info("Sending charge_stop");
    await this.command("charge_stop");
  }

  async setChargeAmps(amps: number): Promise<void> {
    log.info({ amps }, "Sending set_charging_amps");
    await this.command("set_charging_amps", { charging_amps: Math.round(amps) });
  }

  /** Wakes the vehicle if it's asleep. Fleet commands fail silently otherwise. */
  async wakeUp(): Promise<void> {
    log.info("Sending wake_up");
    await this.request("POST", `/api/1/vehicles/${this.vehicleTag}/wake_up`);
  }
}

export function createTeslaClient(): TeslaFleetClient {
  return new TeslaFleetClient(
    config.tesla.baseUrl,
    config.tesla.clientId,
    config.tesla.clientSecret,
    config.tesla.refreshToken,
    config.tesla.vehicleTag,
    config.tesla.commandProxyUrl,
    config.tesla.refreshTokenPath
  );
}
