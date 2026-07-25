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

  POLL_INTERVAL_MS: numeric().default("30000"),
  MIN_SURPLUS_START_W: numeric().default("1200"),
  CHARGER_VOLTAGE: numeric().default("240"),
  CHARGER_PHASES: numeric().default("1"),
  MIN_CHARGE_AMPS: numeric().default("5"),
  MAX_CHARGE_AMPS: numeric().default("32"),
  STABLE_CYCLES_TO_START: numeric().default("2"),
  STABLE_CYCLES_TO_STOP: numeric().default("2"),

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
  // Optional: path to the fleet-telemetry server's logger-dispatcher output
  // (see README's Fleet Telemetry section). When set, the controller uses
  // pushed state instead of polling vehicle_data every cycle. Leave unset
  // to keep the old always-poll behavior.
  TESLA_TELEMETRY_LOG_PATH: z.string().optional(),
  // Optional second log source, tailed the same way - fleet-telemetry's
  // actual record_payload activity data has been observed landing on its
  // pm2 *error* log rather than the "out" log pointed to above. Set this
  // to that error log path (see README) so ingest isn't dependent on
  // guessing which stream carries the real data.
  TESLA_TELEMETRY_ERROR_LOG_PATH: z.string().optional(),
  // How long a telemetry hint is trusted before it's considered stale and
  // the controller falls back to a direct poll.
  TESLA_TELEMETRY_STALE_MS: numeric().default("600000"),
  // Minimum gap between direct recovery polls while telemetry is stale, so
  // a vehicle that's offline/deep-asleep doesn't get polled every cycle.
  TESLA_TELEMETRY_RECOVERY_POLL_MS: numeric().default("300000"),
  // How long to stop calling Tesla entirely (reads, commands, wake_up -
  // everything) after a 403/429 response, since Tesla's own account-level
  // rate limit doesn't clear by retrying sooner and every retry just adds
  // to whatever got it disabled in the first place.
  TESLA_RATE_LIMIT_COOLDOWN_MS: numeric().default("1800000"),
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

  pollIntervalMs: env.POLL_INTERVAL_MS!,
  minSurplusStartW: env.MIN_SURPLUS_START_W!,
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
    telemetryLogPath: env.TESLA_TELEMETRY_LOG_PATH || undefined,
    telemetryErrorLogPath: env.TESLA_TELEMETRY_ERROR_LOG_PATH || undefined,
    telemetryStaleMs: env.TESLA_TELEMETRY_STALE_MS!,
    telemetryRecoveryPollMs: env.TESLA_TELEMETRY_RECOVERY_POLL_MS!,
    rateLimitCooldownMs: env.TESLA_RATE_LIMIT_COOLDOWN_MS!,
  },
};
