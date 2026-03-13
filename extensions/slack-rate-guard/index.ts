import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type RateGuardConfig = {
  maxRequests?: number;
  windowSeconds?: number;
  cooldownMessage?: string;
};

type UserBucket = {
  count: number;
  windowStart: number;
};

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as RateGuardConfig;
  const maxRequests = cfg.maxRequests ?? 10;
  const windowMs = (cfg.windowSeconds ?? 60) * 1000;
  const cooldownTemplate = cfg.cooldownMessage ?? "";

  // Per-user fixed-window rate limiter (in-memory, resets on gateway restart)
  const buckets = new Map<string, UserBucket>();

  // Clean up stale buckets every 5 minutes
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart > 10 * 60 * 1000) {
          buckets.delete(key);
        }
      }
    },
    5 * 60 * 1000,
  );

  function consume(userId: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    let bucket = buckets.get(userId);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(userId, bucket);
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSec = Math.ceil(Math.max(0, bucket.windowStart + windowMs - now) / 1000);
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterSec: 0, remaining: maxRequests - bucket.count };
  }

  api.on(
    "message_received",
    async (event, ctx) => {
      const senderId = event.from;
      if (!senderId) return;

      // Only rate-limit Slack messages
      if (ctx.channelId !== "slack") return;

      const result = consume(senderId);

      if (!result.allowed) {
        const msg =
          cooldownTemplate ||
          `You're sending messages too quickly. Please wait ${result.retryAfterSec} second${result.retryAfterSec === 1 ? "" : "s"}.`;

        api.logger.info?.(`rate-guard: blocked ${senderId} — retry in ${result.retryAfterSec}s`);

        return { cancel: true, reply: msg };
      }
    },
    { priority: 100 },
  );
}
