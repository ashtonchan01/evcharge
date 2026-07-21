import { config } from "./config.js";
import { createGoodweClient } from "./goodwe/client.js";
import { createTeslaClient } from "./tesla/client.js";
import { ChargeController } from "./controller/index.js";
import { startServer } from "./server/index.js";
import { logger } from "./util/logger.js";

const log = logger.child({ module: "main" });

const goodwe = createGoodweClient();
const tesla = createTeslaClient();
const controller = new ChargeController(goodwe, tesla);

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
