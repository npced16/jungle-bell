import { type Db, transaction } from "./db.ts";
import type { Principal } from "./types.ts";
import { type Config, DESKTOP_ORIGINS } from "./config.ts";
import { opaque, sessionHash, sha256, uiSessionHash } from "./crypto.ts";
import {
  body,
  boolean,
  check,
  clearCookies,
  date,
  id,
  instant,
  iso,
  json,
  noContent,
  string,
} from "./http.ts";
import { recordFeature } from "./usage.ts";
const DAY = 86400000;
const nullableString = (v: unknown, max = 128) => v == null ? null : string(v, 1, max);
const nullableDate = (v: unknown) => v == null ? null : date(v);

export function validateAttendance(b: Record<string, unknown>, now: number) {
  const attendanceDate = date(b.attendanceDate), cohortId = nullableString(b.cohortId);
  const cohortStatus = string(b.cohortStatus, 1, 16, /^(active|upcoming|ended|none|unknown)$/);
  const cohortStartDate = nullableDate(b.cohortStartDate), cohortEndDate = nullableDate(b.cohortEndDate);
  const morningChecked = boolean(b.morningChecked), eveningChecked = boolean(b.eveningChecked);
  const collectedAt = instant(b.collectedAt);
  check(!cohortStartDate || !cohortEndDate || cohortStartDate <= cohortEndDate);
  if (cohortStatus === "active") check(cohortId !== null);
  if (["upcoming", "ended"].includes(cohortStatus)) {
    check(cohortId === null && !morningChecked && !eveningChecked);
  }
  if (cohortStatus === "none") {
    check(
      cohortId === null && cohortStartDate === null && cohortEndDate === null && !morningChecked &&
        !eveningChecked,
    );
  }
  if (cohortStatus === "unknown") check(cohortId === null);
  check(collectedAt <= now + 120000, "ATTENDANCE_COLLECTION_TIME_INVALID");
  return {
    attendanceDate,
    cohortId,
    cohortStatus,
    cohortStartDate,
    cohortEndDate,
    morningChecked,
    eveningChecked,
    collectedAt,
  };
}
export async function attendance(db: Db, userId: string, now = Date.now()) {
  const [s] =
    await db`SELECT *,attendance_date::text AS date_text,cohort_start_date::text AS start_text,cohort_end_date::text AS end_text FROM jb.attendance_snapshot WHERE user_id=${userId}`;
  if (!s) return { attendance: null, freshness: "missing" };
  return {
    attendance: {
      attendanceDate: s.date_text,
      cohortId: s.cohort_id,
      cohortStatus: s.cohort_status,
      cohortStartDate: s.start_text,
      cohortEndDate: s.end_text,
      morningChecked: s.morning_checked,
      eveningChecked: s.evening_checked,
      collectedAt: iso(s.collected_at_epoch_ms),
    },
    freshness: now - Number(s.collected_at_epoch_ms) <= 900000 ? "fresh" : "stale",
  };
}
export async function handleAccount(
  req: Request,
  path: string,
  db: Db,
  config: Config,
  p: Principal | null,
): Promise<Response | null> {
  const now = Date.now(), method = req.method;
  if (path === "/api/desktop/installations" && method === "POST") {
    const b = await body(req, ["installationId", "usageAnalyticsEnabled"]);
    const installation = string(b.installationId, 8, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
    const enabled = b.usageAnalyticsEnabled == null ? null : boolean(b.usageAnalyticsEnabled);
    const token = opaque("jbd_"), hash = await sessionHash(token), expires = now + 90 * DAY;
    // Only the trusted platform's header may supply an address. Untrusted CF/XFF are never accepted.
    const address = req.headers.get("x-real-ip")?.slice(0, 64) || "unknown";
    const rateKeys = [
      await sha256(`desktop-enrollment:ip:${address}`),
      await sha256(`desktop-enrollment:installation:${installation}`),
    ];
    await transaction(db, async (tx) => {
      for (let i = 0; i < rateKeys.length; i++) {
        const rows =
          await tx`INSERT INTO jb.desktop_enrollment_attempt AS a(rate_key,window_started_at_epoch_ms,attempt_count)
          VALUES (${rateKeys[i]},${now},1) ON CONFLICT(rate_key) DO UPDATE SET
          window_started_at_epoch_ms=CASE WHEN ${now}-a.window_started_at_epoch_ms>=600000 THEN ${now} ELSE a.window_started_at_epoch_ms END,
          attempt_count=CASE WHEN ${now}-a.window_started_at_epoch_ms>=600000 THEN 1 ELSE a.attempt_count+1 END
          WHERE ${now}-a.window_started_at_epoch_ms>=600000 OR a.attempt_count<${
            i === 0 ? 240 : 10
          } RETURNING rate_key`;
        check(rows.length, "DESKTOP_ENROLLMENT_RATE_LIMITED", 429);
      }
      // Serialize registrations of the same identity, including the first registration.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${installation},0))`;
      const existing = await tx`SELECT 1 FROM jb.desktop_device WHERE installation_id=${installation}`;
      check(!existing.length, "DESKTOP_ALREADY_ENROLLED", 409);
      const user = crypto.randomUUID();
      await tx`INSERT INTO jb.app_user VALUES (${user},${now})`;
      await tx`INSERT INTO jb.desktop_device(installation_id,user_id,created_at_epoch_ms,activated_at_epoch_ms,last_seen_at_epoch_ms,lms_session_state)
        VALUES (${installation},${user},${now},${now},${now},'unknown')`;
      await tx`INSERT INTO jb.app_session(id,user_id,installation_id,kind,token_sha256,created_at_epoch_ms,expires_at_epoch_ms,last_seen_at_epoch_ms)
        VALUES (${crypto.randomUUID()},${user},${installation},'desktop',${hash},${now},${expires},${now})`;
      await tx`INSERT INTO jb.attendance_preference(user_id,updated_at_epoch_ms) VALUES (${user},${now})`;
      await tx`INSERT INTO jb.meal_preference VALUES (${user},true,true,true,${now})`;
      if (enabled !== null) await tx`INSERT INTO jb.usage_preference VALUES (${user},${enabled},${now})`;
    });
    return json({ accessToken: token, expiresAt: iso(expires) }, 201);
  }
  if (!p) return null;
  if (path === "/api/desktop/installations/rotate" && method === "POST") {
    await body(req, []);
    const token = opaque("jbd_"), hash = await sessionHash(token), expires = now + 90 * DAY;
    await transaction(db, async (tx) => {
      const rows =
        await tx`UPDATE jb.app_session SET revoked_at_epoch_ms=${now} WHERE id=${p.sessionId} AND user_id=${p.userId}
        AND installation_id=${p.installationId} AND kind='desktop' AND revoked_at_epoch_ms IS NULL AND expires_at_epoch_ms>${now} RETURNING id`;
      check(rows.length, "DESKTOP_SESSION_ROTATION_REJECTED", 409);
      await tx`DELETE FROM jb.desktop_ui_session WHERE parent_session_id=${p.sessionId}`;
      await tx`INSERT INTO jb.app_session(id,user_id,installation_id,kind,token_sha256,created_at_epoch_ms,expires_at_epoch_ms,last_seen_at_epoch_ms)
        VALUES (${crypto.randomUUID()},${p.userId},${p.installationId},'desktop',${hash},${now},${expires},${now})`;
    });
    return json({ accessToken: token, expiresAt: iso(expires) });
  }
  if (path === "/api/desktop/installations/current" && method === "DELETE") {
    const rows =
      await db`DELETE FROM jb.app_user u USING jb.app_session s WHERE u.id=${p.userId} AND s.id=${p.sessionId}
      AND s.user_id=u.id AND s.installation_id=${p.installationId} AND s.kind='desktop' AND s.revoked_at_epoch_ms IS NULL RETURNING u.id`;
    check(rows.length, "DESKTOP_IDENTITY_DELETION_REJECTED", 409);
    return noContent();
  }
  if (
    (path === "/api/desktop/webview-sessions" && method === "POST") ||
    (path === "/api/desktop/webview-sessions/current" && method === "DELETE")
  ) {
    const b = await body(req, ["origin"]), origin = string(b.origin);
    check(DESKTOP_ORIGINS.includes(origin), "ORIGIN_NOT_ALLOWED", 403);
    if (method === "DELETE") {
      await db`DELETE FROM jb.desktop_ui_session WHERE parent_session_id=${p.sessionId} AND user_id=${p.userId} AND installation_id=${p.installationId} AND origin=${origin}`;
      return noContent();
    }
    const token = opaque("jbui_"), hash = await uiSessionHash(token), expires = now + 420000;
    await transaction(db, async (tx) => {
      const parents =
        await tx`SELECT id FROM jb.app_session WHERE id=${p.sessionId} AND revoked_at_epoch_ms IS NULL AND expires_at_epoch_ms>${now} FOR UPDATE`;
      check(parents.length, "AUTHENTICATION_REQUIRED", 401);
      await tx`INSERT INTO jb.desktop_ui_session(id,parent_session_id,user_id,installation_id,token_sha256,origin,scope,created_at_epoch_ms,expires_at_epoch_ms)
        VALUES (${crypto.randomUUID()},${p.sessionId},${p.userId},${p.installationId},${hash},${origin},'desktop-ui-v1',${now},${expires})
        ON CONFLICT(parent_session_id) DO UPDATE SET id=EXCLUDED.id,token_sha256=EXCLUDED.token_sha256,origin=EXCLUDED.origin,
        created_at_epoch_ms=EXCLUDED.created_at_epoch_ms,expires_at_epoch_ms=EXCLUDED.expires_at_epoch_ms`;
    });
    return json({ accessToken: token, expiresAt: iso(expires) }, 201);
  }
  if (path === "/api/desktop/heartbeat" && method === "POST") {
    const b = await body(req, ["lmsSessionState", "appVersion"]);
    const state = string(b.lmsSessionState, 1, 20, /^(connected|login-required|unknown)$/),
      version = nullableString(b.appVersion, 64);
    const rows =
      await db`UPDATE jb.desktop_device SET last_seen_at_epoch_ms=${now},lms_session_state=${state},app_version=COALESCE(${version},app_version)
      WHERE installation_id=${p.installationId} AND user_id=${p.userId} RETURNING installation_id`;
    check(rows.length, "DESKTOP_NOT_REGISTERED", 409);
    return json({ receivedAt: iso(now) });
  }
  if (path === "/api/desktop/attendance" && method === "PUT") {
    const b = await body(req, [
      "attendanceDate",
      "cohortId",
      "cohortStatus",
      "cohortStartDate",
      "cohortEndDate",
      "morningChecked",
      "eveningChecked",
      "collectedAt",
    ]);
    const a = validateAttendance(b, now);
    await transaction(db, async (tx) => {
      const d =
        await tx`UPDATE jb.desktop_device SET last_seen_at_epoch_ms=${now},lms_session_state='connected' WHERE installation_id=${p.installationId} AND user_id=${p.userId} RETURNING installation_id`;
      check(d.length, "DESKTOP_NOT_REGISTERED", 409);
      await tx`INSERT INTO jb.attendance_snapshot AS s(user_id,source_installation_id,attendance_date,cohort_id,cohort_status,cohort_start_date,cohort_end_date,morning_checked,evening_checked,collected_at_epoch_ms,received_at_epoch_ms)
        VALUES (${p.userId},${p.installationId},${a.attendanceDate},${a.cohortId},${a.cohortStatus},${a.cohortStartDate},${a.cohortEndDate},${a.morningChecked},${a.eveningChecked},${a.collectedAt},${now})
        ON CONFLICT(user_id) DO UPDATE SET source_installation_id=EXCLUDED.source_installation_id,attendance_date=EXCLUDED.attendance_date,
        cohort_id=EXCLUDED.cohort_id,cohort_status=EXCLUDED.cohort_status,cohort_start_date=EXCLUDED.cohort_start_date,cohort_end_date=EXCLUDED.cohort_end_date,
        morning_checked=EXCLUDED.morning_checked,evening_checked=EXCLUDED.evening_checked,collected_at_epoch_ms=EXCLUDED.collected_at_epoch_ms,
        received_at_epoch_ms=EXCLUDED.received_at_epoch_ms WHERE s.collected_at_epoch_ms<=EXCLUDED.collected_at_epoch_ms`;
    });
    return json(await attendance(db, p.userId, now));
  }
  if ((path === "/api/desktop/attendance" || path === "/api/me/attendance") && method === "GET") {
    const envelope = await attendance(db, p.userId, now);
    if (path.includes("/desktop/")) return json(envelope);
    const devices =
      await db`SELECT * FROM jb.desktop_device WHERE user_id=${p.userId} ORDER BY installation_id`;
    return json({
      ...envelope,
      devices: devices.map((d) => ({
        id: d.installation_id,
        deviceLabel: "PC 앱",
        lastSeenAt: d.last_seen_at_epoch_ms == null ? null : iso(d.last_seen_at_epoch_ms),
        lmsSessionState: d.lms_session_state,
        health: d.last_seen_at_epoch_ms != null && now - Number(d.last_seen_at_epoch_ms) <= 180000
          ? "online"
          : "offline",
        appVersion: d.app_version,
      })),
    });
  }
  if (path === "/api/me/mobile-sessions" && method === "GET") {
    const rows =
      await db`SELECT s.*,EXISTS(SELECT 1 FROM jb.push_subscription push WHERE push.session_id=s.id AND push.revoked_at_epoch_ms IS NULL) AS push_enabled
      FROM jb.app_session s WHERE s.user_id=${p.userId} AND s.kind='mobile' ORDER BY s.created_at_epoch_ms DESC`;
    return json({
      devices: rows.map((s) => ({
        deviceId: `jbsi_${s.id}`,
        deviceLabel: s.label ?? "모바일 기기",
        installationId: s.installation_id,
        createdAt: iso(s.created_at_epoch_ms),
        expiresAt: iso(s.expires_at_epoch_ms),
        lastSeenAt: iso(s.last_seen_at_epoch_ms),
        pushEnabled: s.push_enabled,
        status: s.revoked_at_epoch_ms != null
          ? "revoked"
          : Number(s.expires_at_epoch_ms) <= now
          ? "expired"
          : "active",
      })),
    });
  }
  const revoke = /^\/api\/me\/mobile-sessions\/([^/]+)$/.exec(path);
  if (revoke && method === "DELETE") {
    const session = id(revoke[1], "jbsi_");
    const rows =
      await db`UPDATE jb.app_session SET revoked_at_epoch_ms=${now} WHERE id=${session} AND user_id=${p.userId} AND kind='mobile' AND revoked_at_epoch_ms IS NULL RETURNING id`;
    check(rows.length, "DEVICE_NOT_FOUND", 404);
    await recordFeature(db, config, p, "mobile_device_revoked");
    return noContent();
  }
  if (path === "/api/me/session" && method === "GET") {
    const [s] =
      await db`SELECT expires_at_epoch_ms FROM jb.app_session WHERE id=${p.sessionId} AND revoked_at_epoch_ms IS NULL`;
    check(s, "AUTHENTICATION_REQUIRED", 401);
    return json({ authenticated: true, expiresAt: iso(s.expires_at_epoch_ms) });
  }
  if (path === "/api/me/session" && method === "DELETE") {
    await db`UPDATE jb.app_session SET revoked_at_epoch_ms=${now} WHERE id=${p.sessionId} AND user_id=${p.userId} AND revoked_at_epoch_ms IS NULL`;
    const headers = new Headers();
    clearCookies(headers, "jb_device", config.publicBaseUrl.startsWith("https:"));
    return noContent(headers);
  }
  return null;
}
