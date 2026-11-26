import { type Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { Principal } from "./types.ts";
import { ApiError, body, json, noContent } from "./http.ts";
import { sha256 } from "./public-data.ts";
import type { Row } from "./laundry-normalizer.ts";
export interface NotificationRecord {
  id: string;
  userId: string;
  sourceEventId: string;
  kind: string;
  title: string;
  body: string;
  path: string;
  payload: Row;
  createdAtEpochMs: number;
  dueAtEpochMs: number;
  expiresAtEpochMs: number;
}
export async function createNotification(db: Db, n: NotificationRecord): Promise<boolean> {
  const payload = {
    ...n.payload,
    notificationId: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    path: n.path,
    createdAtEpochMs: n.createdAtEpochMs,
    expiresAtEpochMs: n.expiresAtEpochMs,
  };
  const rows =
    await db`with created as(insert into jb.notification(id,user_id,source_event_id,kind,title,body,path,payload,created_at_epoch_ms,due_at_epoch_ms,expires_at_epoch_ms) values(${n.id},${n.userId},${n.sourceEventId},${n.kind},${n.title},${n.body},${n.path},${
      db.json(payload)
    },${n.createdAtEpochMs},${n.dueAtEpochMs},${n.expiresAtEpochMs}) on conflict(user_id,source_event_id) do nothing returning id,user_id,due_at_epoch_ms,created_at_epoch_ms),targets as(select c.id notification_id,'desktop'::text target_kind,d.installation_id target_id,c.due_at_epoch_ms next_attempt_at from created c join jb.desktop_device d on d.user_id=c.user_id join jb.app_session s on s.installation_id=d.installation_id and s.user_id=d.user_id and s.kind='desktop' and s.revoked_at_epoch_ms is null and s.expires_at_epoch_ms>c.created_at_epoch_ms union all select c.id,'push'::text,p.id,c.due_at_epoch_ms from created c join jb.push_subscription p on p.user_id=c.user_id and p.revoked_at_epoch_ms is null join jb.app_session s on s.id=p.session_id and s.revoked_at_epoch_ms is null and s.expires_at_epoch_ms>c.created_at_epoch_ms),deliveries as(insert into jb.notification_delivery(notification_id,target_kind,target_id,status,attempts,next_attempt_at_epoch_ms) select notification_id,target_kind,target_id,'pending',0,next_attempt_at from targets on conflict do nothing returning notification_id) select id from created`;
  return rows.length > 0;
}
const dto = (r: Row) => ({
  id: r.id,
  kind: ["attendance-morning", "attendance-evening"].includes(r.kind) ? "attendance-action-required" : r.kind,
  title: r.title,
  body: r.body,
  path: r.path,
  createdAtEpochMs: Number(r.created_at_epoch_ms),
  expiresAtEpochMs: Number(r.expires_at_epoch_ms),
  attempt: Number(r.attempts ?? 0),
});
async function acknowledge(db: Db, p: Principal, id: string, outcome: string, occurred: number) {
  return (await db`update jb.notification_delivery d set status=${
    outcome === "displayed" ? "delivered" : "failed"
  },attempts=attempts+1,delivered_at_epoch_ms=${outcome === "displayed" ? occurred : null},last_error=${
    outcome === "failed" ? "desktop-display-failed" : null
  } from jb.notification n where d.notification_id=n.id and n.id=${id} and n.user_id=${p.userId} and d.target_kind='desktop' and d.target_id=${p.installationId} and d.status in('pending','retry') returning d.notification_id`)
    .length > 0;
}
export async function handleNotifications(
  req: Request,
  path: string,
  db: Db,
  config: Config,
  p: Principal,
): Promise<Response | null> {
  const now = Date.now(), method = req.method;
  if (method === "GET" && ["/api/desktop/notifications", "/api/me/notifications"].includes(path)) {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ApiError("INVALID_REQUEST");
    const rows = path.startsWith("/api/desktop/")
      ? await db`select n.*,d.attempts from jb.notification_delivery d join jb.notification n on n.id=d.notification_id where n.user_id=${p.userId} and d.target_kind='desktop' and d.target_id=${p.installationId} and d.status in('pending','retry') and n.due_at_epoch_ms<=${now} and n.expires_at_epoch_ms>${now} order by n.created_at_epoch_ms limit ${limit}`
      : await db`select *,0 attempts from jb.notification where user_id=${p.userId} order by created_at_epoch_ms desc limit ${limit}`;
    return json({ notifications: rows.map(dto) });
  }
  if (method === "POST" && ["/api/desktop/notifications/test", "/api/me/notifications/test"].includes(path)) {
    const b = await body(req, path.startsWith("/api/desktop/") ? ["desktopDelivered"] : []);
    if (b.desktopDelivered != null && typeof b.desktopDelivered !== "boolean") {
      throw new ApiError("INVALID_REQUEST");
    }
    const [r] =
      await db`select count(*) count from jb.push_subscription p join jb.app_session s on s.id=p.session_id where p.user_id=${p.userId} and p.revoked_at_epoch_ms is null and s.revoked_at_epoch_ms is null and s.expires_at_epoch_ms>${now}`;
    const queued = Number(r.count);
    if (p.kind === "mobile" && !queued) throw new ApiError("PUSH_SUBSCRIPTION_REQUIRED", 409);
    const id = crypto.randomUUID(),
      created = await createNotification(db, {
        id,
        userId: p.userId,
        sourceEventId: `manual-test:${p.sessionId}:${Math.floor(now / 30000)}`,
        kind: "test",
        title: "Jungle Bell 테스트 알림",
        body: "알림이 정상적으로 연결되었습니다.",
        path: "/#/notifications",
        payload: { tag: `jungle-bell-test-${p.sessionId}` },
        createdAtEpochMs: now,
        dueAtEpochMs: now,
        expiresAtEpochMs: now + 600000,
      });
    if (!created) throw new ApiError("TEST_NOTIFICATION_RATE_LIMITED", 429);
    if (p.kind === "desktop" && b.desktopDelivered === true) await acknowledge(db, p, id, "displayed", now);
    return json({ notificationId: id, queued }, 202);
  }
  const ack = path.match(/^\/api\/desktop\/notifications\/([^/]+)\/ack$/);
  if (method === "POST" && ack) {
    if (!/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(ack[1])) {
      throw new ApiError("INVALID_REQUEST");
    }
    const b = await body(req, ["outcome", "occurredAtEpochMs"]);
    if (
      !["displayed", "failed"].includes(String(b.outcome)) || !Number.isSafeInteger(b.occurredAtEpochMs) ||
      Number(b.occurredAtEpochMs) < 0
    ) throw new ApiError("INVALID_REQUEST");
    if (Number(b.occurredAtEpochMs) > now + 120000) throw new ApiError("NOTIFICATION_ACK_TIME_INVALID");
    if (!await acknowledge(db, p, ack[1], String(b.outcome), Number(b.occurredAtEpochMs))) {
      throw new ApiError("NOTIFICATION_ACK_REJECTED", 409);
    }
    return noContent();
  }
  if (method === "GET" && path === "/api/me/push/vapid-public-key") {
    if (!config.vapidPublicKey) throw new ApiError("WEB_PUSH_NOT_CONFIGURED", 503);
    return json({ publicKey: config.vapidPublicKey });
  }
  if (method === "PUT" && path === "/api/me/push/subscriptions") {
    if (!config.vapidPublicKey) throw new ApiError("WEB_PUSH_NOT_CONFIGURED", 503);
    const b = await body(req, ["endpoint", "keys"]), keys = b.keys as Row;
    let url: URL;
    try {
      url = new URL(String(b.endpoint));
    } catch {
      throw new ApiError("INVALID_REQUEST");
    }
    if (
      typeof b.endpoint !== "string" || b.endpoint.length > 2048 || url.protocol !== "https:" ||
      url.username || url.password || url.hash || !keys || typeof keys !== "object" || Array.isArray(keys) ||
      Object.keys(keys).some((k) => !["p256dh", "auth"].includes(k)) || typeof keys.p256dh !== "string" ||
      keys.p256dh.length < 40 || keys.p256dh.length > 256 || typeof keys.auth !== "string" ||
      keys.auth.length < 16 || keys.auth.length > 128 || ![keys.p256dh, keys.auth].every((k) =>
        /^[A-Za-z0-9_-]+={0,2}$/.test(k)
      )
    ) throw new ApiError("INVALID_REQUEST");
    const id = `jbps_${sha256(b.endpoint)}`;
    await db`insert into jb.push_subscription(id,user_id,session_id,endpoint,p256dh,auth,created_at_epoch_ms,revoked_at_epoch_ms) values(${id},${p.userId},${p.sessionId},${b.endpoint},${keys.p256dh},${keys.auth},${now},null) on conflict(id) do update set user_id=excluded.user_id,session_id=excluded.session_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,created_at_epoch_ms=excluded.created_at_epoch_ms,revoked_at_epoch_ms=null`;
    return json({ subscriptionId: id }, 201);
  }
  const unsub = path.match(/^\/api\/me\/push\/subscriptions\/(.+)$/);
  if (method === "DELETE" && unsub) {
    if (!/^jbps_[a-f0-9]{64}$/.test(unsub[1])) throw new ApiError("INVALID_REQUEST");
    const rows = await db`update jb.push_subscription set revoked_at_epoch_ms=${now} where id=${
      unsub[1]
    } and user_id=${p.userId} and revoked_at_epoch_ms is null returning id`;
    if (!rows.length) throw new ApiError("PUSH_SUBSCRIPTION_NOT_FOUND", 404);
    return noContent();
  }
  return null;
}
