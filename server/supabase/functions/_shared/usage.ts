import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Principal } from "./types.ts";
import { hmac, opaque } from "./crypto.ts";
import { body, boolean, clearCookies, cookie, cookies, json, noContent, setCookie, string } from "./http.ts";

export const usageDay = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
const clientFor = (p: Principal) => p.kind === "mobile" ? "pwa" : "desktop";
export const FEATURES = [
  "attendance_settings_changed",
  "meal_notification_settings_changed",
  "laundry_watch_created",
  "laundry_watch_cancelled",
  "mobile_device_paired",
  "mobile_device_revoked",
  "push_subscription_registered",
  "push_subscription_removed",
] as const;
export async function recordFeature(
  db: Db,
  config: Config,
  p: Principal,
  feature: typeof FEATURES[number],
): Promise<void> {
  if (!config.usageEnabled) return;
  try {
    await db`INSERT INTO jb.usage_feature_day AS d(usage_date,user_id,client,feature_code,use_count)
      SELECT ${usageDay()},user_id,${
      clientFor(p)
    },${feature},1 FROM jb.usage_preference WHERE user_id=${p.userId} AND enabled
      ON CONFLICT(usage_date,user_id,client,feature_code) DO UPDATE SET use_count=d.use_count+1`;
  } catch {
    console.warn("Usage feature recording failed", feature);
  }
}
export function optedOut(req: Request): boolean {
  const values = cookies(req);
  return values.has("jb_usage_opt_out") || values.has("__Host-jb_usage_opt_out");
}
export function retryableDatabaseFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? "";
  return /^(08|40|53|57P)/.test(code) ||
    [
      "CONNECTION_CLOSED",
      "CONNECT_TIMEOUT",
      "CONNECTION_ENDED",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EPIPE",
    ].includes(code);
}
export async function handleUsage(
  req: Request,
  path: string,
  db: Db,
  config: Config,
  p: Principal | null,
): Promise<Response | null> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const secure = config.publicBaseUrl.startsWith("https:");
  if (path === "/api/public/usage-preference") {
    if (req.method === "GET") return json({ enabled: !optedOut(req) }, 200, headers);
    if (req.method === "PUT") {
      const enabled = boolean((await body(req, ["enabled"])).enabled);
      if (enabled) clearCookies(headers, "jb_usage_opt_out", secure);
      else {
        setCookie(headers, "jb_usage_opt_out", "1", 365 * 86400, secure);
        clearCookies(headers, "jb_usage", secure);
      }
      return json({ enabled }, 200, headers);
    }
  }
  if (["/api/me/usage-preference", "/api/desktop/usage-preference"].includes(path) && p) {
    if (req.method === "GET") {
      const [row] = await db`SELECT enabled FROM jb.usage_preference WHERE user_id=${p.userId}`;
      return json({ enabled: row?.enabled ?? null }, 200, headers);
    }
    if (path.startsWith("/api/desktop/") && req.method === "PUT") {
      const enabled = boolean((await body(req, ["enabled"])).enabled);
      await db`INSERT INTO jb.usage_preference(user_id,enabled,updated_at_epoch_ms) SELECT id,${enabled},${Date.now()} FROM jb.app_user WHERE id=${p.userId}
        ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at_epoch_ms=EXCLUDED.updated_at_epoch_ms`;
      return json({ enabled }, 200, headers);
    }
  }
  if (req.method !== "POST") return null;
  if (path === "/api/me/usage/ui-opened" && p) {
    if (!config.usageEnabled) return noContent(headers);
    try {
      await db`INSERT INTO jb.usage_user_day(usage_date,user_id,client,activity)
        SELECT ${usageDay()},user_id,${
        clientFor(p)
      },'ui_opened' FROM jb.usage_preference WHERE user_id=${p.userId} AND enabled ON CONFLICT DO NOTHING`;
    } catch (error) {
      if (!retryableDatabaseFailure(error)) throw error;
      headers.set("Retry-After", "1");
      return json({ error: "USAGE_METRICS_UNAVAILABLE", issues: null }, 503, headers);
    }
    return noContent(headers);
  }
  if (path === "/api/public/usage/ui-opened") {
    const client = string((await body(req, ["client"])).client, 3, 3, /^(web|pwa)$/);
    if (optedOut(req) || !config.usageEnabled) return noContent(headers);
    const existing = cookie(req, "jb_usage"),
      token = existing && /^jbv_[a-f0-9]{64}$/.test(existing) ? existing : opaque("jbv_");
    if (token !== existing) setCookie(headers, "jb_usage", token, 86400, secure);
    const day = usageDay(),
      hash = await hmac(config.usageHashSecret, `jungle-bell:anonymous-usage:v1\0${day}\0${token}`);
    try {
      await db`INSERT INTO jb.usage_anonymous_day VALUES (${day},${hash},${client},'ui_opened') ON CONFLICT DO NOTHING`;
    } catch (error) {
      if (!retryableDatabaseFailure(error)) throw error;
      headers.set("Retry-After", "1");
      return json({ error: "USAGE_METRICS_UNAVAILABLE", issues: null }, 503, headers);
    }
    return noContent(headers);
  }
  return null;
}
