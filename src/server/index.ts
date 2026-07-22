import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { ChargeController } from "../controller/index.js";
import { TeslaFleetClient } from "../tesla/client.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "server" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(controller: ChargeController, tesla: TeslaFleetClient) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../web/public")));

  app.get("/api/status", (_req, res) => {
    res.json(controller.getStatus());
  });

  app.get("/api/vehicles", async (_req, res) => {
    try {
      res.json(await tesla.listVehicles());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/enabled", (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };

    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    controller.setEnabled(enabled, req.header("x-actor") ?? "dashboard");
    res.json(controller.getStatus());
  });

  app.post("/api/buffer", (req, res) => {
    const { bufferW } = req.body as { bufferW?: number };

    if (typeof bufferW !== "number" || !Number.isFinite(bufferW) || bufferW < 0) {
      res.status(400).json({ error: "bufferW must be a non-negative number" });
      return;
    }

    controller.setGridImportBufferW(bufferW, req.header("x-actor") ?? "dashboard");
    res.json(controller.getStatus());
  });

  app.post("/api/vehicle", (req, res) => {
    const { tag } = req.body as { tag?: string };

    if (typeof tag !== "string" || !tag.trim()) {
      res.status(400).json({ error: "tag must be a non-empty vehicle id or VIN" });
      return;
    }

    controller.setVehicleTag(tag.trim(), req.header("x-actor") ?? "dashboard");
    res.json(controller.getStatus());
  });

  return app;
}

export function startServer(controller: ChargeController, tesla: TeslaFleetClient) {
  const app = createApp(controller, tesla);
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
