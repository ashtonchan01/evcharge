import { config } from "./config.js";
import { createGoodweClient } from "./goodwe/client.js";
import { createTeslaClient } from "./tesla/client.js";
import { createTelemetryIngest } from "./tesla/telemetry.js";
import { ChargeController } from "./controller/index.js";
import { startServer } from "./server/index.js";
import { logger } from "./util/logger.js";

const log = logger.child({ module: "main" });

const goodwe = createGoodweClient();
const tesla = createTeslaClient();
const telemetry = createTelemetryIngest();
if (!telemetry) {
  log.warn(
    "TESLA_TELEMETRY_LOG_PATH not set - falling back to polling vehicle_data every cycle. See README's Fleet Telemetry section to stop paying for idle-time Tesla API usage."
  );
}
const controller = new ChargeController(goodwe, tesla, telemetry);

controller.start();
startServer(controller, tesla);

process.on("SIGINT", () => {
  log.info("Shutting down");
  controller.stop();
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  log.error({ err }, "Unhandled rejection");
});

log.info(
  { pollIntervalMs: config.pollIntervalMs },
  "evcharge controller started"
);
