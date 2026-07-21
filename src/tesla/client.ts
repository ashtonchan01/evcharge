import fetch from "cross-fetch";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "tesla" });

const TESLA_AUTH_URL = "https://auth.tesla.com/oauth2/v3/token";

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
 * Calls Tesla's Fleet API directly. This is only safe for vehicles that
 * don't require the signed "vehicle command protocol" (pre-2021 cars on
 * older infotainment firmware) - those vehicles accept plain OAuth-token
 * authenticated commands with no virtual key pairing. Newer vehicles
 * require routing through a signed-command proxy instead.
 */
export class TeslaFleetClient {
  private accessToken: string | null = null;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly vehicleTag: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async refreshAccessToken(): Promise<string> {
    log.debug("Refreshing Tesla access token");
    const res = await fetch(TESLA_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

    const body = (await res.json()) as { access_token: string };
    this.accessToken = body.access_token;
    return this.accessToken;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const doRequest = async (token: string) =>
      fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
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
      throw new Error(`Tesla request ${method} ${path} failed: HTTP ${res.status} ${text}`);
    }

    return parsed as T;
  }

  private command(name: string, body?: unknown) {
    return this.request(
      "POST",
      `/api/1/vehicles/${this.vehicleTag}/command/${name}`,
      body ?? {}
    );
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
    config.tesla.vehicleTag
  );
}
