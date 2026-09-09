import fs from "node:fs";
import webpush, { PushSubscription, WebPushError } from "web-push";
import { config } from "../config.js";
import { logger } from "../util/logger.js";

const log = logger.child({ module: "push" });

export interface NotificationPayload {
  title: string;
  body: string;
}

/**
 * Subscriptions are persisted to a single JSON file rather than a database -
 * this is a single-user personal app, and the whole list realistically holds
 * a handful of browser/device entries at most.
 */
export class PushService {
  private subscriptions: PushSubscription[] = [];
  private readonly enabled: boolean;

  constructor(private readonly storePath: string) {
    this.enabled = Boolean(config.push.publicKey && config.push.privateKey);
    if (!this.enabled) {
      log.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - push notifications disabled");
      return;
    }

    webpush.setVapidDetails(config.push.subject, config.push.publicKey!, config.push.privateKey!);
    this.subscriptions = this.load();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicKey(): string | null {
    return config.push.publicKey ?? null;
  }

  private load(): PushSubscription[] {
    try {
      return JSON.parse(fs.readFileSync(this.storePath, "utf8"));
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.subscriptions, null, 2));
  }

  addSubscription(sub: PushSubscription): void {
    if (this.subscriptions.some((s) => s.endpoint === sub.endpoint)) return;
    this.subscriptions.push(sub);
    this.save();
    log.info({ count: this.subscriptions.length }, "Push subscription added");
  }

  removeSubscription(endpoint: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) this.save();
  }

  /**
   * Fans a notification out to every registered device. A 404/410 means the
   * browser/OS has permanently discarded that subscription (uninstall,
   * permission revoked, etc.) - prune it instead of retrying forever.
   */
  async notify(payload: NotificationPayload): Promise<void> {
    if (!this.enabled || this.subscriptions.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      this.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body);
        } catch (err) {
          if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            this.removeSubscription(sub.endpoint);
            return;
          }
          log.warn({ err: String(err) }, "Failed to send push notification");
        }
      })
    );
  }
}

export function createPushService(): PushService {
  return new PushService(config.push.subscriptionsPath);
}
