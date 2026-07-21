import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { GoodweSemsClient, SolarSnapshot } from "../goodwe/client.js";
import { TeslaFleetClient, VehicleChargeState } from "../tesla/client.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "controller" });

export type OverrideMode = "auto" | "force_on" | "force_off";

export interface OverrideState {
  mode: OverrideMode;
  /** Only used for force_on; null means "use max amps" */
  amps: number | null;
  setAt: Date | null;
  setBy: string | null;
}

export interface ControllerStatus {
  solar: SolarSnapshot | null;
  vehicle: VehicleChargeState | null;
  surplusW: number | null;
  targetAmps: number | null;
  decision: "charging" | "idle" | "waiting_for_stability" | "unavailable";
  override: OverrideState;
  lastError: string | null;
  lastPollAt: Date | null;
}

/**
 * Core control loop: poll solar production/consumption, poll the vehicle,
 * decide whether there's enough spare solar to charge from, and issue
 * amp/start/stop commands to the car - unless a manual override is active.
 */
export class ChargeController extends EventEmitter {
  private status: ControllerStatus = {
    solar: null,
    vehicle: null,
    surplusW: null,
    targetAmps: null,
    decision: "unavailable",
    override: { mode: "auto", amps: null, setAt: null, setBy: null },
    lastError: null,
    lastPollAt: null,
  };

  private timer: NodeJS.Timeout | null = null;
  private aboveStartThresholdCount = 0;
  private belowStopThresholdCount = 0;
  private isCurrentlyCharging = false;

  constructor(
    private readonly goodwe: GoodweSemsClient,
    private readonly tesla: TeslaFleetClient
  ) {
    super();
  }

  getStatus(): ControllerStatus {
    return this.status;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: config.pollIntervalMs }, "Starting control loop");
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setOverride(mode: OverrideMode, amps: number | null, setBy: string): void {
    this.status.override = { mode, amps, setAt: new Date(), setBy };
    log.info({ mode, amps, setBy }, "Manual override changed");
    // Reset stability counters so returning to auto re-evaluates cleanly.
    this.aboveStartThresholdCount = 0;
    this.belowStopThresholdCount = 0;
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.emit("update", this.status);
  }

  private async tick(): Promise<void> {
    try {
      const [solar, vehicle] = await Promise.all([
        this.goodwe.getSnapshot(),
        this.tesla.getChargeState().catch((err) => {
          log.warn({ err: String(err) }, "Vehicle unreachable this cycle");
          return null;
        }),
      ]);

      this.status.solar = solar;
      this.status.vehicle = vehicle;
      this.status.lastPollAt = new Date();
      this.status.lastError = null;

      const surplusW = solar.pvPowerW - solar.loadPowerW - config.gridImportBufferW;
      this.status.surplusW = surplusW;

      await this.decide(surplusW, vehicle);
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.status.decision = "unavailable";
      log.error({ err: this.status.lastError }, "Poll cycle failed");
    }

    this.emitUpdate();
  }

  private async decide(surplusW: number, vehicle: VehicleChargeState | null): Promise<void> {
    const { override } = this.status;

    if (override.mode === "force_off") {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      if (this.isCurrentlyCharging) {
        await this.tesla.stopCharging().catch((err) => log.warn({ err: String(err) }, "stop failed"));
        this.isCurrentlyCharging = false;
      }
      return;
    }

    if (override.mode === "force_on") {
      const amps = override.amps ?? config.maxChargeAmps;
      this.status.decision = "charging";
      this.status.targetAmps = amps;
      await this.applyCharge(amps, vehicle);
      return;
    }

    // --- auto mode ---
    if (!vehicle) {
      this.status.decision = "unavailable";
      return;
    }

    if (!vehicle.pluggedIn) {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      this.isCurrentlyCharging = false;
      this.aboveStartThresholdCount = 0;
      this.belowStopThresholdCount = 0;
      return;
    }

    const ampsAvailable = wattsToAmps(surplusW);

    if (!this.isCurrentlyCharging) {
      if (ampsAvailable >= config.minChargeAmps && surplusW >= config.minSurplusStartW) {
        this.aboveStartThresholdCount += 1;
      } else {
        this.aboveStartThresholdCount = 0;
      }

      if (this.aboveStartThresholdCount >= config.stableCyclesToStart) {
        const amps = clamp(ampsAvailable, config.minChargeAmps, config.maxChargeAmps);
        this.status.decision = "charging";
        this.status.targetAmps = amps;
        await this.applyCharge(amps, vehicle);
        this.isCurrentlyCharging = true;
        this.belowStopThresholdCount = 0;
      } else {
        this.status.decision = "waiting_for_stability";
        this.status.targetAmps = null;
      }
      return;
    }

    // Currently charging: decide whether to keep going, ramp, or stop.
    if (surplusW <= config.minSurplusStopW || ampsAvailable < config.minChargeAmps) {
      this.belowStopThresholdCount += 1;
    } else {
      this.belowStopThresholdCount = 0;
    }

    if (this.belowStopThresholdCount >= config.stableCyclesToStop) {
      this.status.decision = "idle";
      this.status.targetAmps = null;
      await this.tesla.stopCharging().catch((err) => log.warn({ err: String(err) }, "stop failed"));
      this.isCurrentlyCharging = false;
      this.aboveStartThresholdCount = 0;
      return;
    }

    const amps = clamp(ampsAvailable, config.minChargeAmps, config.maxChargeAmps);
    this.status.decision = "charging";
    this.status.targetAmps = amps;
    if (amps !== vehicle.chargeAmps) {
      await this.tesla.setChargeAmps(amps).catch((err) => log.warn({ err: String(err) }, "amps failed"));
    }
  }

  private async applyCharge(amps: number, vehicle: VehicleChargeState | null): Promise<void> {
    try {
      if (vehicle?.chargingState !== "Charging") {
        await this.tesla.startCharging();
      }
      await this.tesla.setChargeAmps(amps);
      this.isCurrentlyCharging = true;
    } catch (err) {
      log.warn({ err: String(err) }, "applyCharge failed");
    }
  }
}

function wattsToAmps(watts: number): number {
  if (watts <= 0) return 0;
  const volts = config.chargerVoltage * config.chargerPhases;
  return Math.floor(watts / volts);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
