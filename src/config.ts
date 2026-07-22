import "dotenv/config";
import { z } from "zod";

const numeric = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : Number(v)));

const schema = z.object({
  PORT: numeric().default("3000"),
  LOG_LEVEL: z.string().default("info"),
  OVERRIDE_TOKEN: z.string().min(1, "OVERRIDE_TOKEN must be set"),

  POLL_INTERVAL_MS: numeric().default("30000"),
  MIN_SURPLUS_START_W: numeric().default("1400"),
  MIN_SURPLUS_STOP_W: numeric().default("200"),
  GRID_IMPORT_BUFFER_W: numeric().default("150"),
  CHARGER_VOLTAGE: numeric().default("240"),
  CHARGER_PHASES: numeric().default("1"),
  MIN_CHARGE_AMPS: numeric().default("5"),
  MAX_CHARGE_AMPS: numeric().default("32"),
  STABLE_CYCLES_TO_START: numeric().default("2"),
  STABLE_CYCLES_TO_STOP: numeric().default("3"),

  GOODWE_SEMS_ACCOUNT: z.string().min(1),
  GOODWE_SEMS_PASSWORD: z.string().min(1),
  GOODWE_STATION_ID: z.string().min(1),
  GOODWE_SEMS_BASE_URL: z.string().default("https://www.semsportal.com/api"),

  TESLA_FLEET_API_BASE_URL: z.string().default("https://fleet-api.prd.na.vehicle-command.psf.tesla.com"),
  TESLA_CLIENT_ID: z.string().min(1),
  TESLA_CLIENT_SECRET: z.string().min(1),
  TESLA_REFRESH_TOKEN: z.string().min(1),
  TESLA_VEHICLE_TAG: z.string().min(1),
  // Optional: local tesla-http-proxy URL for vehicles that require Tesla's
  // signed Vehicle Command Protocol (anything except pre-2021 Model S/X).
  // When set, command calls (start/stop charging, set amps) route through
  // it instead of hitting the Fleet API directly; reads still go direct.
  TESLA_COMMAND_PROXY_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid configuration:\n", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT!,
  logLevel: env.LOG_LEVEL,
  overrideToken: env.OVERRIDE_TOKEN,

  pollIntervalMs: env.POLL_INTERVAL_MS!,
  minSurplusStartW: env.MIN_SURPLUS_START_W!,
  minSurplusStopW: env.MIN_SURPLUS_STOP_W!,
  gridImportBufferW: env.GRID_IMPORT_BUFFER_W!,
  chargerVoltage: env.CHARGER_VOLTAGE!,
  chargerPhases: env.CHARGER_PHASES!,
  minChargeAmps: env.MIN_CHARGE_AMPS!,
  maxChargeAmps: env.MAX_CHARGE_AMPS!,
  stableCyclesToStart: env.STABLE_CYCLES_TO_START!,
  stableCyclesToStop: env.STABLE_CYCLES_TO_STOP!,

  goodwe: {
    account: env.GOODWE_SEMS_ACCOUNT,
    password: env.GOODWE_SEMS_PASSWORD,
    stationId: env.GOODWE_STATION_ID,
    baseUrl: env.GOODWE_SEMS_BASE_URL,
  },

  tesla: {
    baseUrl: env.TESLA_FLEET_API_BASE_URL,
    clientId: env.TESLA_CLIENT_ID,
    clientSecret: env.TESLA_CLIENT_SECRET,
    refreshToken: env.TESLA_REFRESH_TOKEN,
    vehicleTag: env.TESLA_VEHICLE_TAG,
    commandProxyUrl: env.TESLA_COMMAND_PROXY_URL || undefined,
  },
};
