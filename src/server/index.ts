import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChargeLimitPercent } from "../chargeLimit.js";
import { config } from "../config.js";
import { ChargeController } from "../controller/index.js";
import { TeslaApiError, TeslaFleetClient, VehicleSummary } from "../tesla/client.js";
import { PushService } from "../push/index.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "server" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VEHICLE_LIST_CACHE_MS = 10 * 60 * 1000;

function publicTeslaError(err: unknown): string {
  if (err instanceof TeslaApiError && (err.status === 403 || err.status === 429)) {
    return err.status === 429 ? "Tesla rate limited the account" : "Tesla rejected the request (403)";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/billing|payment required|quota exceeded|spending limit/i.test(message)) return "Tesla billing limit";
  return message.replace(/\s+/g, " ").slice(0, 180);
}

export function createApp(controller: ChargeController, tesla: TeslaFleetClient, push: PushService) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../web/public")));

  let vehicleCache: { vehicles: VehicleSummary[]; cachedAt: number } | null = null;

  app.get("/api/status", (_req, res) => {
    res.json(controller.getStatus());
  });

  app.get("/api/vehicles", async (_req, res) => {
    const status = controller.getStatus();
    const rateLimited = status.rateLimitedUntil !== null && new Date(status.rateLimitedUntil).getTime() > Date.now();
    const cachedBody = () => ({
      vehicles: vehicleCache?.vehicles ?? [],
      stale: true,
      cachedAt: vehicleCache ? new Date(vehicleCache.cachedAt).toISOString() : null,
    });

    // A phone refresh must not spend a Fleet API call during a hold, and a
    // warm cache answers repeat loads without listing vehicles again.
    if (rateLimited || status.apiBudgetActive) {
      res.status(rateLimited ? 429 : 200).json({
        ...cachedBody(),
        error: rateLimited ? "Tesla rate limit cooldown" : "Tesla paid calls paused",
        rateLimitedUntil: status.rateLimitedUntil,
      });
      return;
    }
    if (vehicleCache && Date.now() - vehicleCache.cachedAt < VEHICLE_LIST_CACHE_MS) {
      res.json({
        vehicles: vehicleCache.vehicles,
        stale: false,
        cachedAt: new Date(vehicleCache.cachedAt).toISOString(),
      });
      return;
    }

    try {
      const vehicles = await tesla.listVehicles();
      vehicleCache = { vehicles, cachedAt: Date.now() };
      res.json({
        vehicles,
        stale: false,
        cachedAt: new Date(vehicleCache.cachedAt).toISOString(),
      });
    } catch (err) {
      controller.observeTeslaError("list vehicles", err);
      const body = {
        ...cachedBody(),
        error: publicTeslaError(err),
        rateLimitedUntil: controller.getStatus().rateLimitedUntil,
      };
      if (vehicleCache) {
        res.json(body);
        return;
      }
      res.status(502).json(body);
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

  app.get("/api/push/public-key", (_req, res) => {
    res.json({ publicKey: push.getPublicKey(), enabled: push.isEnabled() });
  });

  app.post("/api/push/subscribe", (req, res) => {
    const sub = req.body;
    if (!sub || typeof sub.endpoint !== "string") {
      res.status(400).json({ error: "invalid push subscription" });
      return;
    }
    push.addSubscription(sub);
    res.json({ ok: true });
  });

  app.post("/api/push/unsubscribe", (req, res) => {
    const { endpoint } = req.body as { endpoint?: string };
    if (typeof endpoint !== "string") {
      res.status(400).json({ error: "endpoint must be a string" });
      return;
    }
    push.removeSubscription(endpoint);
    res.json({ ok: true });
  });

  app.post("/api/charge-limit", async (req, res) => {
    const parsed = parseChargeLimitPercent((req.body as { percent?: unknown } | undefined)?.percent);

    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const held = controller.getStatus();
    const rateLimited = held.rateLimitedUntil !== null && new Date(held.rateLimitedUntil).getTime() > Date.now();
    if (rateLimited || held.apiBudgetActive) {
      res.status(429).json({
        error: rateLimited
          ? "Tesla rate limit cooldown — charge limit not sent"
          : "Tesla billing limit — charge limit not sent",
        rateLimitedUntil: held.rateLimitedUntil,
      });
      return;
    }

    try {
      await tesla.setChargeLimit(parsed.percent);
    } catch (err) {
      controller.observeTeslaError("set_charge_limit", err);
      res.status(502).json({ error: publicTeslaError(err) });
      return;
    }

    // getStatus() still holds the previous chargeLimitSoc until the next
    // telemetry push (ChargeLimitSoc is on a long interval). Patch it so
    // the response and the websocket broadcast show the value just set.
    controller.noteChargeLimit(parsed.percent);
    res.json(controller.getStatus());
  });

  return app;
}

export function startServer(controller: ChargeController, tesla: TeslaFleetClient, push: PushService) {
  const app = createApp(controller, tesla, push);
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcast = () => {
    const payload = JSON.stringify({ type: "status", data: controller.getStatus() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  controller.on("update", broadcast);
  controller.on("notify", (payload) => {
    void push.notify(payload);
  });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "status", data: controller.getStatus() }));
  });

  httpServer.listen(config.port, () => {
    log.info({ port: config.port }, "Dashboard + API listening");
  });

  return httpServer;
}
