// @deno-types="npm:@types/web-push@3.6.4"
import webPush from "npm:web-push@3.6.7";
import { type Db, transaction } from "./db.ts";
import type { Config } from "./config.ts";
import type { Row } from "./laundry-normalizer.ts";
export function allowedEndpoint(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
      (!u.port || u.port === "443") &&
      [
        "fcm.googleapis.com",
        "push.services.mozilla.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
      ].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
export function pushSettlement(result: string, attempts: number, expires: number, now: number) {
  const next = result === "retry" && attempts < 5 && expires > now
    ? now + Math.min(15 * 60000, 30000 * 2 ** Math.min(attempts - 1, 5))
    : null;
  return {
    status: result === "delivered"
      ? "delivered"
      : result === "gone"
      ? "gone"
      : next !== null
      ? "retry"
      : "failed",
    next,
  };
}
export async function sendPush(delivery: Row, config: Config, now: number, transport: typeof fetch = fetch) {
  if (!allowedEndpoint(delivery.endpoint)) return { status: "gone", error: "INVALID_PUSH_ENDPOINT" };
  try {
    const details = webPush.generateRequestDetails(
      { endpoint: delivery.endpoint, keys: { p256dh: delivery.p256dh, auth: delivery.auth } },
      typeof delivery.payload === "string" ? delivery.payload : JSON.stringify(delivery.payload),
      {
        vapidDetails: {
          subject: config.vapidSubject,
          publicKey: config.vapidPublicKey,
          privateKey: config.vapidPrivateKey,
        },
        TTL: Math.min(86400, Math.max(0, Math.ceil((Number(delivery.expires_at_epoch_ms) - now) / 1000))),
        contentEncoding: "aes128gcm",
      },
    );
    const response = await transport(delivery.endpoint, {
      method: "POST",
      headers: details.headers as HeadersInit,
      body: details.body as BodyInit,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    return response.ok
      ? { status: "delivered", error: null }
      : [404, 410].includes(response.status)
      ? { status: "gone", error: `HTTP_${response.status}` }
      : { status: "retry", error: `HTTP_${response.status}` };
  } catch {
    return { status: "retry", error: "WEB_PUSH_NETWORK_ERROR" };
  }
}
export async function push(db: Db, config: Config) {
  if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) {
    return { skipped: "web_push_not_configured" };
  }
  const now = Date.now(), token = crypto.randomUUID();
  const deliveries = await transaction(db, async (tx) => {
    await tx`with inactive as(select d.notification_id,d.target_id from jb.notification_delivery d join jb.notification n on n.id=d.notification_id where d.target_kind='push' and d.status in('pending','retry') and d.next_attempt_at_epoch_ms<=${now} and (d.lease_expires_at_epoch_ms is null or d.lease_expires_at_epoch_ms<=${now}) and (n.expires_at_epoch_ms<=${now} or not exists(select 1 from jb.push_subscription p join jb.app_session s on s.id=p.session_id where p.id=d.target_id and p.revoked_at_epoch_ms is null and s.revoked_at_epoch_ms is null and s.expires_at_epoch_ms>${now})) order by d.next_attempt_at_epoch_ms for update of d skip locked limit 100) update jb.notification_delivery d set status='gone',next_attempt_at_epoch_ms=null,last_error='inactive-push-target',lease_token=null,lease_expires_at_epoch_ms=null from inactive i where d.notification_id=i.notification_id and d.target_kind='push' and d.target_id=i.target_id`;
    return await tx`with candidates as(select d.notification_id,d.target_id from jb.notification_delivery d join jb.notification n on n.id=d.notification_id join jb.push_subscription p on p.id=d.target_id and p.revoked_at_epoch_ms is null join jb.app_session s on s.id=p.session_id and s.revoked_at_epoch_ms is null and s.expires_at_epoch_ms>${now} where d.target_kind='push' and d.status in('pending','retry') and d.next_attempt_at_epoch_ms<=${now} and n.expires_at_epoch_ms>${now} and (d.lease_expires_at_epoch_ms is null or d.lease_expires_at_epoch_ms<=${now}) order by d.next_attempt_at_epoch_ms,n.created_at_epoch_ms for update of d skip locked limit 5),leased as(update jb.notification_delivery d set lease_token=${token},lease_expires_at_epoch_ms=${
      now + 60000
    } from candidates c where d.notification_id=c.notification_id and d.target_kind='push' and d.target_id=c.target_id returning d.notification_id,d.target_id,d.attempts) select l.*,n.payload,n.expires_at_epoch_ms,p.endpoint,p.p256dh,p.auth from leased l join jb.notification n on n.id=l.notification_id join jb.push_subscription p on p.id=l.target_id order by n.created_at_epoch_ms`;
  });
  let delivered = 0;
  // At most five bounded requests run concurrently, within the 60 second claim lease.
  await Promise.all(deliveries.map(async (d) => {
    const sentAt = Date.now(),
      result = await sendPush(d, config, sentAt),
      settledAt = Date.now(),
      settlement = pushSettlement(
        result.status,
        Number(d.attempts) + 1,
        Number(d.expires_at_epoch_ms),
        settledAt,
      );
    const rows =
      await db`with settled as(update jb.notification_delivery set status=${settlement.status},attempts=attempts+1,next_attempt_at_epoch_ms=${settlement.next},last_error=${result.error},delivered_at_epoch_ms=case when ${settlement.status}='delivered' then ${settledAt} else delivered_at_epoch_ms end,lease_token=null,lease_expires_at_epoch_ms=null where notification_id=${d.notification_id} and target_kind='push' and target_id=${d.target_id} and lease_token=${token} returning target_id),revoked as(update jb.push_subscription p set revoked_at_epoch_ms=${settledAt} from settled where ${settlement.status}='gone' and p.id=settled.target_id and p.revoked_at_epoch_ms is null returning p.id) select target_id from settled`;
    if (rows.length && settlement.status === "delivered") delivered++;
  }));
  return { claimed: deliveries.length, delivered };
}
