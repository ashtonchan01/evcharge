import fetch from "cross-fetch";
import fs from "node:fs";
import https from "node:https";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "tesla" });

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

/**
 * Talks only to a local/trusted instance of Tesla's open-source
 * `tesla-http-proxy`, which owns the vehicle command signing key and
 * forwards signed commands to the real Fleet API. This client never
 * touches Tesla's servers directly and never sees the signing key.
 */
export class TeslaFleetClient {
  private readonly agent?: https.Agent;

  constructor(
    private readonly proxyUrl: string,
    private readonly accessToken: string,
    private readonly vehicleTag: string,
    proxyCaPath?: string
  ) {
    this.proxyUrl = proxyUrl.replace(/\/+$/, "");
    if (proxyCaPath) {
      this.agent = new https.Agent({ ca: fs.readFileSync(proxyCaPath) });
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.proxyUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      // @ts-expect-error - node fetch accepts an agent for TLS trust
      agent: this.agent,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      throw new Error(
        `Tesla proxy request ${method} ${path} failed: HTTP ${res.status} ${text}`
      );
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
    config.tesla.proxyUrl,
    config.tesla.accessToken,
    config.tesla.vehicleTag,
    config.tesla.proxyCaPath
  );
}
