import type { Db } from "./db.ts";
import type { Principal } from "./types.ts";
import type { Config } from "./config.ts";
import { opaque } from "./crypto.ts";
import { body, boolean, check, date, integer, json, noContent, string } from "./http.ts";
import { recordFeature } from "./usage.ts";

export function validatePreferences(b: Record<string, unknown>) {
  const v = {
    enabled: boolean(b.enabled),
    morning: boolean(b.morning),
    evening: boolean(b.evening),
    morningStartHour: integer(b.morningStartHour, 4, 9),
    eveningEndHour: integer(b.eveningEndHour, 0, 4),
    morningIntervalMinutes: integer(b.morningIntervalMinutes, 1, 30),
    eveningIntervalMinutes: integer(b.eveningIntervalMinutes, 1, 30),
    skipSunday: boolean(b.skipSunday),
    skipAttendanceDate: b.skipAttendanceDate == null ? null : date(b.skipAttendanceDate),
  };
  check(
    [1, 3, 5, 10, 15, 30].includes(v.morningIntervalMinutes) &&
      [1, 3, 5, 10, 15, 30].includes(v.eveningIntervalMinutes),
  );
  return v;
}
export function validateWatch(b: Record<string, unknown>) {
  const v = {
    machineId: string(b.machineId, 1, 128),
    appliance: string(b.appliance, 1, 10, /^(washer|dryer)$/),
    sessionId: string(b.sessionId, 1, 256),
    notificationMode: string(
      b.notificationMode,
      1,
      32,
      /^(before-completion|estimated-completion|confirmed-completion)$/,
    ),
    notifyBeforeMinutes: integer(b.notifyBeforeMinutes, 0, 180),
  };
  check(v.machineId.trim() === v.machineId && v.sessionId.trim() === v.sessionId);
  check(v.notificationMode === "before-completion" ? v.notifyBeforeMinutes > 0 : v.notifyBeforeMinutes === 0);
  return v;
}
// Row serializers are explicit so internal ownership and attention fields never leak into DTOs.
const watchRow = (r: Record<string, unknown>) => ({
  id: r.id,
  machineId: r.machine_id,
  appliance: r.appliance,
  sessionId: r.session_id,
  notificationMode: r.notification_mode,
  notifyBeforeMinutes: Number(r.notify_before_minutes),
  status: r.status,
  createdAtEpochMs: Number(r.created_at_epoch_ms),
  updatedAtEpochMs: Number(r.updated_at_epoch_ms),
});
export async function handlePersonal(
  req: Request,
  path: string,
  db: Db,
  config: Config,
  p: Principal,
): Promise<Response | null> {
  const now = Date.now();
  if (path === "/api/me/attendance/preferences") {
    if (req.method === "PUT") {
      const v = validatePreferences(
        await body(req, [
          "enabled",
          "morning",
          "evening",
          "morningStartHour",
          "eveningEndHour",
          "morningIntervalMinutes",
          "eveningIntervalMinutes",
          "skipSunday",
          "skipAttendanceDate",
        ]),
      );
      await db`INSERT INTO jb.attendance_preference VALUES (${p.userId},${v.enabled},${v.morning},${v.evening},${v.morningStartHour},${v.eveningEndHour},${v.morningIntervalMinutes},${v.eveningIntervalMinutes},${v.skipSunday},${v.skipAttendanceDate},${now})
        ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,morning_enabled=EXCLUDED.morning_enabled,evening_enabled=EXCLUDED.evening_enabled,
        morning_start_hour=EXCLUDED.morning_start_hour,evening_end_hour=EXCLUDED.evening_end_hour,morning_interval_minutes=EXCLUDED.morning_interval_minutes,
        evening_interval_minutes=EXCLUDED.evening_interval_minutes,skip_sunday=EXCLUDED.skip_sunday,skip_attendance_date=EXCLUDED.skip_attendance_date,updated_at_epoch_ms=EXCLUDED.updated_at_epoch_ms`;
      await recordFeature(db, config, p, "attendance_settings_changed");
      return json(v);
    }
    if (req.method === "GET") {
      const [r] =
        await db`SELECT *,skip_attendance_date::text AS skip_date FROM jb.attendance_preference WHERE user_id=${p.userId}`;
      check(r, "AUTHENTICATION_REQUIRED", 401);
      return json({
        enabled: r.enabled,
        morning: r.morning_enabled,
        evening: r.evening_enabled,
        morningStartHour: r.morning_start_hour,
        eveningEndHour: r.evening_end_hour,
        morningIntervalMinutes: r.morning_interval_minutes,
        eveningIntervalMinutes: r.evening_interval_minutes,
        skipSunday: r.skip_sunday,
        skipAttendanceDate: r.skip_date,
      });
    }
  }
  if (path === "/api/me/meal-preferences") {
    if (req.method === "PUT") {
      const b = await body(req, ["enabled", "lunch", "dinner"]),
        enabled = boolean(b.enabled),
        lunch = boolean(b.lunch),
        dinner = boolean(b.dinner);
      await db`INSERT INTO jb.meal_preference VALUES (${p.userId},${enabled},${lunch},${dinner},${now}) ON CONFLICT(user_id) DO UPDATE SET
        enabled=EXCLUDED.enabled,lunch=EXCLUDED.lunch,dinner=EXCLUDED.dinner,updated_at_epoch_ms=EXCLUDED.updated_at_epoch_ms`;
      await recordFeature(db, config, p, "meal_notification_settings_changed");
      return json({ enabled, lunch, dinner, updatedAtEpochMs: now });
    }
    if (req.method === "GET") {
      const [r] = await db`SELECT * FROM jb.meal_preference WHERE user_id=${p.userId}`;
      check(r, "AUTHENTICATION_REQUIRED", 401);
      return json({
        enabled: r.enabled,
        lunch: r.lunch,
        dinner: r.dinner,
        updatedAtEpochMs: Number(r.updated_at_epoch_ms),
      });
    }
  }
  if (path === "/api/me/laundry-watches") {
    if (req.method === "GET") {
      const rows =
        await db`SELECT * FROM jb.laundry_watch WHERE user_id=${p.userId} ORDER BY created_at_epoch_ms DESC,id`;
      return json({ watches: rows.map(watchRow) });
    }
    if (req.method === "POST") {
      const v = validateWatch(
        await body(req, ["machineId", "appliance", "sessionId", "notificationMode", "notifyBeforeMinutes"]),
      );
      const [r] =
        await db`INSERT INTO jb.laundry_watch(id,user_id,machine_id,appliance,session_id,notification_mode,notify_before_minutes,notify_when_available,status,created_at_epoch_ms,updated_at_epoch_ms)
        VALUES (${
          opaque("jbw_")
        },${p.userId},${v.machineId},${v.appliance},${v.sessionId},${v.notificationMode},${v.notifyBeforeMinutes},false,'active',${now},${now}) ON CONFLICT DO NOTHING RETURNING *`;
      check(r, "LAUNDRY_WATCH_ALREADY_ACTIVE", 409);
      await recordFeature(db, config, p, "laundry_watch_created");
      return json(watchRow(r), 201);
    }
  }
  const match = /^\/api\/me\/laundry-watches\/([^/]+)$/.exec(path);
  if (match && req.method === "DELETE") {
    const target = string(match[1], 68, 68, /^jbw_[a-f0-9]{64}$/);
    const rows =
      await db`UPDATE jb.laundry_watch SET status='cancelled',updated_at_epoch_ms=${now} WHERE id=${target} AND user_id=${p.userId} AND status='active' RETURNING id`;
    check(rows.length, "LAUNDRY_WATCH_NOT_FOUND", 404);
    await recordFeature(db, config, p, "laundry_watch_cancelled");
    return noContent();
  }
  return null;
}
