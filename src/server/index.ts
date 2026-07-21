import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { ChargeController, OverrideMode } from "../controller/index.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "server" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireOverrideToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const token = req.header("x-override-token");
  if (token !== config.overrideToken) {
    res.status(401).json({ error: "Invalid or missing x-override-token header" });
    return;
  }
  next();
}

export function createApp(controller: ChargeController) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../web/public")));

  app.get("/api/status", (_req, res) => {
    res.json(controller.getStatus());
  });

  app.post("/api/override", requireOverrideToken, (req, res) => {
    const { mode, amps } = req.body as { mode?: string; amps?: number };

    if (mode !== "auto" && mode !== "force_on" && mode !== "force_off") {
      res.status(400).json({ error: "mode must be one of auto | force_on | force_off" });
      return;
    }

    if (amps !== undefined && (typeof amps !== "number" || amps < 0 || amps > 48)) {
      res.status(400).json({ error: "amps must be a number between 0 and 48" });
      return;
    }

    controller.setOverride(mode as OverrideMode, amps ?? null, req.header("x-actor") ?? "dashboard");
    res.json(controller.getStatus());
  });

  return app;
}

export function startServer(controller: ChargeController) {
  const app = createApp(controller);
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcast = () => {
    const payload = JSON.stringify({ type: "status", data: controller.getStatus() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  controller.on("update", broadcast);

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "status", data: controller.getStatus() }));
  });

  httpServer.listen(config.port, () => {
    log.info({ port: config.port }, "Dashboard + API listening");
  });

  return httpServer;
}
