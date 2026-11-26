import { type Db, transaction } from "./db.ts";
import { type Appliance, type Row } from "./laundry-normalizer.ts";
import { iso, latestLaundry } from "./public-data.ts";
import { createNotification, type NotificationRecord } from "./notifications.ts";
import { classifyMeal } from "./meal-classification.ts";
const MIN = 60000, DAY = 86400000;
const date = (n: number) => new Date(n + 9 * 3600000).toISOString().slice(0, 10);
const hour = (n: number) => new Date(n + 9 * 3600000).getUTCHours();
const at = (d: string, h: number) => Date.parse(d + "T00:00:00+09:00") + h * 3600000;
const time = (n: number) => new Date(n + 9 * 3600000).toISOString().slice(11, 16);
export function attendanceWindow(c: Row, phase: string, now: number, fallback = false): Row | null {
  if (!c[phase + "_enabled"]) return null;
  const attendanceDate = phase === "morning" || hour(now) >= 23 ? date(now) : date(now - DAY);
  const start = at(attendanceDate, phase === "morning" ? c.morning_start_hour : 23),
    deadline = phase === "morning" ? at(attendanceDate, 10) : at(attendanceDate, 24 + c.evening_end_hour),
    grace = deadline + 10 * MIN;
  if (now < start || now >= grace) return null;
  const deadlineSlot = now >= deadline, interval = c[phase + "_interval_minutes"] * MIN;
  let due = deadlineSlot ? deadline : start + Math.floor((now - start) / interval) * interval,
    ends = deadlineSlot ? grace : Math.min(due + interval, deadline);
  if (fallback) {
    if (phase === "morning") {
      const follow = start + 2 * 3600000;
      if (deadlineSlot) {
        due = deadline;
        ends = grace;
      } else if (follow < deadline && now >= follow) {
        due = follow;
        ends = deadline;
      } else {
        due = start;
        ends = Math.min(follow, deadline);
      }
    } else {
      const midnight = at(attendanceDate, 24), end = Math.min(midnight + 3600000, grace);
      if (now >= end) return null;
      due = now < midnight ? start : midnight;
      ends = now < midnight ? midnight : end;
    }
  }
  return {
    attendanceDate,
    phase,
    slot: time(due).replace(":", ""),
    deadline: deadlineSlot,
    deadlineAtEpochMs: deadline,
    dueAtEpochMs: due,
    endsAtEpochMs: ends,
  };
}
export function attendanceCopy(phase: string, window: Row, reason: string | null, now: number) {
  const label = phase === "morning" ? "학습 시작" : "학습 종료",
    target = !window.deadline ? window.deadlineAtEpochMs : phase === "morning" ? window.endsAtEpochMs : null,
    remaining = target !== null && target > now ? Math.ceil((target - now) / MIN) : null,
    morningGrace = phase === "morning" && window.deadline && remaining !== null;
  const title = reason
    ? `${label} 상태를 확인할 수 없습니다`
    : morningGrace
    ? "학습 시작 체크 지각 임박"
    : window.deadline
    ? `${label} 체크 마감`
    : `${label} 체크가 필요합니다`;
  const remainingLabel = remaining === null
    ? ""
    : remaining < 60
    ? `${remaining}분`
    : remaining % 60 === 0
    ? `${remaining / 60}시간`
    : `${Math.floor(remaining / 60)}시간 ${remaining % 60}분`;
  let text = target !== null && remaining !== null
    ? `${time(target)} ${morningGrace ? "최종 마감" : "마감"}까지 ${remainingLabel} 남았습니다.`
    : window.deadline
    ? `${time(window.deadlineAtEpochMs)} 마감 시각이 지났습니다.`
    : `${label} 여부를 LMS에서 확인해 주세요.`;
  const guidance = reason === "desktop-offline"
    ? "PC가 연결되지 않아 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
    : reason === "login-required"
    ? "PC의 LMS 로그인이 만료되어 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
    : reason === "status-unknown"
    ? "PC에서 최신 출석 상태를 확인하지 못했습니다. LMS에서 직접 확인해 주세요."
    : window.deadline && remaining === null
    ? "지금 LMS에서 확인해 주세요."
    : null;
  if (guidance) text += " " + guidance;
  return {
    kind: "attendance-action-required",
    title,
    body: text,
    deadlineAtEpochMs: window.deadlineAtEpochMs,
    countdownTargetEpochMs: target,
    remainingMinutes: remaining,
  };
}
export function laundryDecision(
  w: Row,
  a: Appliance,
  now: number,
): { record: NotificationRecord; complete: boolean } | null {
  const terminal = ["COMPLETED", "IDLE"].includes(a.operationalStatus) ||
    a.projection?.status === "CONFIRMED_COMPLETED";
  let transition: string | null = null;
  if (
    w.appliance === "dryer" && !w.attention_unresolved && w.session_id &&
    ["ERROR", "PAUSED"].includes(w.pending_attention_status)
  ) {
    if (
      a.sessionId && a.sessionId !== w.session_id || ["ERROR", "PAUSED"].includes(a.operationalStatus) ||
      a.operationalStatus === "IDLE" && ["POWER_OFF", "INITIAL"].includes(a.state.raw ?? a.state.code)
    ) transition = w.pending_attention_status;
  }
  const durable = w.appliance === "dryer" && transition !== null,
    snapshotMatch = w.session_id != null && w.session_id === a.sessionId,
    mismatch = durable && !snapshotMatch;
  if (!(snapshotMatch || w.session_id == null && terminal || durable)) return null;
  if (w.attention_unresolved && ["ERROR", "PAUSED", "IDLE"].includes(a.operationalStatus)) return null;
  const remaining = a.estimatedFinishAt
    ? Math.max(0, Math.ceil(Math.floor((Date.parse(a.estimatedFinishAt) - now) / 1000) / 60))
    : a.projection?.remainingMinutes ?? a.remainingMinutes;
  const expected = a.projection?.status === "AWAITING_COMPLETION_CONFIRMATION" ||
    a.operationalStatus === "RUNNING" && remaining === 0 || terminal;
  const machine = w.machine_id.match(/\d+$/)?.[0] ? `${w.machine_id.match(/\d+$/)[0]}번` : w.machine_id,
    device = w.appliance === "washer" ? "세탁기" : "건조기",
    action = w.appliance === "washer" ? "세탁" : "건조";
  const attention = w.appliance !== "dryer"
      ? null
      : mismatch
      ? transition
      : a.operationalStatus === "ERROR" || transition === "ERROR"
      ? "ERROR"
      : a.operationalStatus === "PAUSED" || transition === "PAUSED"
      ? "PAUSED"
      : null,
    error = mismatch ? null : a.errorCode;
  let kind: string, title: string, text: string;
  if (attention) {
    kind = "laundry-attention";
    title = attention === "PAUSED" ? "건조기가 일시 정지됐습니다" : "건조기가 멈췄습니다";
    text = attention === "PAUSED"
      ? `${machine} 건조기 상태를 확인해 주세요.`
      : error === "EMPTY_WATER_ALERT_ERROR"
      ? `${machine} 건조기 물통을 비우고 건조 상태를 확인해 주세요.`
      : error === "DOOR_OPEN_ERROR"
      ? `${machine} 건조기 문을 닫고 건조 상태를 확인해 주세요.`
      : `${machine} 건조기에 오류가 발생했습니다. 건조 상태를 확인해 주세요.`;
  } else if (
    w.notification_mode === "before-completion" && a.operationalStatus === "RUNNING" && remaining >= 1 &&
    remaining <= w.notify_before_minutes
  ) {
    kind = "laundry-finishing";
    title = `${action} 종료 ${w.notify_before_minutes}분 전`;
    text = `${machine} ${device}가 곧 끝납니다.`;
  } else if (w.notification_mode === "estimated-completion" && expected) {
    kind = "laundry-completion-expected";
    title = `${action} 완료 예상`;
    text = `${machine} ${device}의 예상 종료 시각입니다. 실제 상태를 확인해 주세요.`;
  } else if (w.notification_mode === "confirmed-completion" && terminal) {
    kind = "laundry-completed";
    title = `${action} 완료 확정`;
    text = `${machine} ${device}가 끝났습니다. 세탁물을 꺼내 주세요.`;
  } else return null;
  const incident = w.pending_attention_incident_id ?? `snapshot:${a.observedAt}`,
    expires = now + (["laundry-completed", "laundry-attention"].includes(kind) ? 6 : 2) * 3600000;
  return {
    complete: kind === "laundry-completed" || kind === "laundry-completion-expected" && terminal,
    record: {
      id: crypto.randomUUID(),
      userId: w.user_id,
      sourceEventId: kind === "laundry-attention"
        ? `laundry-attention:${w.id}:${w.session_id ?? "none"}:${incident}`
        : `${kind}:${w.id}:${w.session_id ?? "none"}:${w.notification_mode}`,
      kind,
      title,
      body: text,
      path: "/#/laundry",
      createdAtEpochMs: now,
      dueAtEpochMs: now,
      expiresAtEpochMs: expires,
      payload: {
        machineId: w.machine_id,
        appliance: w.appliance,
        sessionId: w.session_id,
        notificationMode: w.notification_mode,
        attentionStatus: attention,
        attentionIncidentId: attention ? incident : null,
        errorCode: error,
        remainingMinutes: mismatch ? null : remaining,
      },
    },
  };
}
async function acquire(db: Db, name: string, now: number, duration: number, token: string) {
  return (await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${name},${now},${token}) on conflict(name) do update set last_run_at_epoch_ms=excluded.last_run_at_epoch_ms,run_token=excluded.run_token where jb.maintenance_state.last_run_at_epoch_ms<=${
    now - duration
  } returning run_token`).length > 0;
}
async function cursor(db: Db, name: string, now: number) {
  const [r] = await db`select run_token from jb.maintenance_state where name=${name}`;
  return r ? JSON.parse(r.run_token) : { now, after: "" };
}
async function saveCursor(db: Db, name: string, c: Row) {
  await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${name},${Date.now()},${
    JSON.stringify(c)
  }) on conflict(name) do update set last_run_at_epoch_ms=excluded.last_run_at_epoch_ms,run_token=excluded.run_token`;
}
async function planAttendance(db: Db, now: number) {
  const name = "automation:attendance:cursor", c = await cursor(db, name, now);
  const rows =
    await db`select p.*,p.skip_attendance_date::text,s.attendance_date::text,s.cohort_status,s.morning_checked,s.evening_checked,s.collected_at_epoch_ms from jb.attendance_preference p left join jb.attendance_snapshot s on s.user_id=p.user_id where p.enabled and p.user_id::text>${c.after} order by p.user_id limit 25`;
  const devices = rows.length
    ? await db`select * from jb.desktop_device where user_id=any(${rows.map((r) => r.user_id)}::uuid[])`
    : [];
  for (const r of rows) {
    for (const phase of ["morning", "evening"]) {
      let w = attendanceWindow(r, phase, now);
      if (
        !w || r.skip_attendance_date && String(r.skip_attendance_date).slice(0, 10) === w.attendanceDate ||
        r.skip_sunday && new Date(w.attendanceDate).getUTCDay() === 0
      ) continue;
      const fresh = r.attendance_date === w.attendanceDate && r.collected_at_epoch_ms !== null &&
        now - Number(r.collected_at_epoch_ms) >= 0 && now - Number(r.collected_at_epoch_ms) <= 15 * MIN;
      if (
        r.attendance_date === w.attendanceDate &&
        (r[phase + "_checked"] === true || fresh && ["upcoming", "ended", "none"].includes(r.cohort_status))
      ) continue;
      const recent = devices.filter((d) =>
        d.user_id === r.user_id && d.last_seen_at_epoch_ms !== null &&
        now - Number(d.last_seen_at_epoch_ms) >= 0 && now - Number(d.last_seen_at_epoch_ms) <= 10 * MIN
      );
      const connected = recent.some((d) => d.lms_session_state === "connected"),
        reason = !recent.length
          ? "desktop-offline"
          : !connected && recent.some((d) => d.lms_session_state === "login-required")
          ? "login-required"
          : !connected || !fresh
          ? "status-unknown"
          : null;
      if (reason) w = attendanceWindow(r, phase, now, true);
      if (!w || w.endsAtEpochMs <= Date.now()) continue;
      const copy = attendanceCopy(phase, w, reason, now);
      await createNotification(db, {
        id: crypto.randomUUID(),
        userId: r.user_id,
        sourceEventId: `attendance:${w.attendanceDate}:${phase}:${w.slot}`,
        kind: copy.kind,
        title: copy.title,
        body: copy.body,
        path: "/#/attendance",
        payload: {
          attendanceDate: w.attendanceDate,
          phase,
          fallbackReason: reason,
          deadlineAtEpochMs: copy.deadlineAtEpochMs,
          countdownTargetEpochMs: copy.countdownTargetEpochMs,
          remainingMinutes: copy.remainingMinutes,
        },
        createdAtEpochMs: now,
        dueAtEpochMs: w.dueAtEpochMs,
        expiresAtEpochMs: w.endsAtEpochMs,
      });
    }
    await saveCursor(db, name, { now: now, after: r.user_id });
  }
  if (rows.length < 25) await db`delete from jb.maintenance_state where name=${name}`;
  return rows.length === 25;
}
/** 서버 응답(classifyMeal)과 같은 규칙으로 식단 날짜를 정한다. 제목에 날짜가 없으면 게시일(KST)을 쓴다. */
export function mealServiceDate(post: Row) {
  const referenceAt = Date.parse(iso(post.updated_at ?? post.published_at ?? post.first_seen_at)!),
    classified = classifyMeal(post.title ?? null, post.body ?? "", post.pinned === true, referenceAt);
  if (classified.mealDate) return classified.mealDate;
  return date(Date.parse(iso(post.published_at ?? post.updated_at ?? post.first_seen_at)!));
}
/** 오늘(KST) 날짜의 중식/석식 단일 식단 게시물일 때만 알림 대상 끼니를 돌려준다. */
export function mealNotificationPeriod(post: Row, now: number): "lunch" | "dinner" | null {
  const referenceAt = Date.parse(iso(post.updated_at ?? post.published_at ?? post.first_seen_at)!),
    classified = classifyMeal(post.title ?? null, post.body ?? "", post.pinned === true, referenceAt);
  if (classified.category !== "DAILY_MENU" || !classified.mealPeriod) return null;
  // 제목 날짜가 없으면 게시일 기준으로 본다. 어제 게시물이 늦게 수집되거나 수정되어도
  // "오늘 석식" 알림으로 나가지 않도록 반드시 오늘 날짜와 비교한다.
  if (mealServiceDate(post) !== date(now)) return null;
  return classified.mealPeriod === "LUNCH" ? "lunch" : "dinner";
}
async function publishMeals(db: Db, now: number) {
  const posts = await db`select * from jb.meal_post where content_first_seen_at>=${new Date(
    now - 12 * 3600000,
  )} order by content_first_seen_at,id limit 200`;
  let remaining = false, budget = 25;
  for (const p of posts) {
    const period = mealNotificationPeriod(p, now);
    if (!period) continue;
    const serviceDate = mealServiceDate(p),
      source = `meal:${serviceDate}:${period}:${p.content_sha}`,
      expires = Date.parse(iso(p.content_first_seen_at)!) + 12 * 3600000;
    if (expires <= now) continue;
    const users =
      await db`select user_id from jb.meal_preference pref where enabled and (case when ${period}='lunch' then lunch else dinner end) and not exists(select 1 from jb.notification n where n.user_id=pref.user_id and n.source_event_id=${source}) order by user_id limit ${
        budget + 1
      }`;
    for (const u of users.slice(0, budget)) {
      let preview = p.body.replace(/\s+/g, " ").trim();
      preview = preview.length <= 160 ? preview : preview.slice(0, 157) + "...";
      await createNotification(db, {
        id: crypto.randomUUID(),
        userId: u.user_id,
        sourceEventId: source,
        kind: "meal-published",
        title: `오늘 ${period === "lunch" ? "중식" : "석식"}이 올라왔어요`,
        body: preview || "메뉴 내용을 확인해 주세요.",
        path: "/#/meals",
        payload: { meal: period, serviceDate, contentSha: p.content_sha },
        createdAtEpochMs: now,
        dueAtEpochMs: now,
        expiresAtEpochMs: expires,
      });
    }
    if (users.length > budget) {
      remaining = true;
      break;
    }
    budget -= users.length;
    if (budget === 0) {
      remaining = true;
      break;
    }
  }
  if (remaining) await saveCursor(db, "automation:meals:cursor", { now });
  else await db`delete from jb.maintenance_state where name='automation:meals:cursor'`;
  return remaining;
}
async function laundryWatches(db: Db, now: number) {
  const version = await latestLaundry(db);
  if (!version) return false;
  const name = "automation:laundry:cursor", c = await cursor(db, name, now);
  const rows =
    await db`select w.*,i.id::text pending_attention_incident_id,case i.type when 'ERROR_ENTERED' then 'ERROR' when 'PAUSED' then 'PAUSED' end pending_attention_status,exists(select 1 from jb.laundry_event e where e.machine_id=w.machine_id and e.appliance=w.appliance and e.session_id=w.session_id and e.type in('STARTED','COMPLETED') and e.observed_at>=to_timestamp(w.attention_unresolved_at_epoch_ms/1000.0)) attention_recovered from jb.laundry_watch w left join lateral(select incident.id,incident.type from jb.laundry_event incident where w.appliance='dryer' and incident.machine_id=w.machine_id and incident.appliance=w.appliance and incident.session_id=w.session_id and incident.observed_at>=to_timestamp(w.created_at_epoch_ms/1000.0) and incident.type in('ERROR_ENTERED','PAUSED') and not exists(select 1 from jb.laundry_event recovery where recovery.machine_id=incident.machine_id and recovery.appliance=incident.appliance and recovery.session_id=incident.session_id and recovery.type in('STARTED','COMPLETED') and recovery.observed_at>=incident.observed_at) order by case incident.type when 'ERROR_ENTERED' then 2 else 1 end desc,incident.observed_at desc,incident.id desc limit 1)i on true where w.status='active' and w.id>${c.after} order by w.id limit 25`;
  for (const watch of rows) {
    const machine = version.machines.find((m) => m.id === watch.machine_id),
      a = watch.appliance === "washer" ? machine?.washer : machine?.dryer;
    if (a) {
      await transaction(db, async (tx) => {
        const [locked] =
          await tx`select * from jb.laundry_watch where id=${watch.id} and status='active' for update`;
        if (!locked) return;
        const w = { ...watch, ...locked };
        if (
          w.attention_unresolved &&
          (w.attention_recovered || w.session_id === a.sessionId && a.operationalStatus === "RUNNING")
        ) {
          await tx`update jb.laundry_watch set attention_unresolved=false,attention_unresolved_at_epoch_ms=null,updated_at_epoch_ms=${now} where id=${w.id}`;
          w.attention_unresolved = false;
        }
        const d = laundryDecision(w, a, now);
        let complete = false;
        if (d) {
          await createNotification(tx, d.record);
          if (
            d.record.kind === "laundry-attention"
          ) {
            await tx`update jb.laundry_watch set attention_unresolved=true,attention_unresolved_at_epoch_ms=${now},updated_at_epoch_ms=${now} where id=${w.id} and not attention_unresolved`;
          } else complete = d.complete;
        } else {complete = !!(w.session_id && a.sessionId && w.session_id !== a.sessionId) ||
            ["COMPLETED", "IDLE"].includes(a.operationalStatus) ||
            a.projection?.status === "CONFIRMED_COMPLETED";}
        if (
          complete
        ) {
          await tx`update jb.laundry_watch set status='completed',attention_unresolved=false,attention_unresolved_at_epoch_ms=null,updated_at_epoch_ms=${now} where id=${w.id}`;
        }
      });
    }
    await saveCursor(db, name, { now: now, after: watch.id });
  }
  if (rows.length < 25) await db`delete from jb.maintenance_state where name=${name}`;
  return rows.length === 25;
}
export async function housekeeping(db: Db, now: number) {
  return await transaction(db, async (tx) => {
    if (!await acquire(tx, "hourly-housekeeping", now, 55 * MIN, crypto.randomUUID())) return false;
    await tx`delete from jb.desktop_ui_session where expires_at_epoch_ms<=${now}`;
    await tx`delete from jb.pairing_challenge where expires_at_epoch_ms<=${now - DAY}`;
    await tx`delete from jb.desktop_enrollment_attempt where window_started_at_epoch_ms<=${now - DAY}`;
    await tx`delete from jb.notification where expires_at_epoch_ms<=${now - 30 * DAY}`;
    // Do not race a publication whose assets are being downloaded in a transaction.
    const [lock] = await tx`select pg_try_advisory_xact_lock(hashtext('jb-meal-assets')) acquired`;
    if (lock.acquired) {
      await tx`delete from jb.meal_asset a where not exists(select 1 from jb.meal_image where asset_sha=a.sha)`;
    }
    return true;
  });
}
export async function automate(db: Db) {
  const now = Date.now(), token = crypto.randomUUID();
  if (!await acquire(db, "minute-automation:lease", now, 50000, token)) return { skipped: "leased" };
  try {
    const errors: string[] = [], remaining: boolean[] = [];
    for (
      const [name, fn] of [["attendance", planAttendance], ["meals", publishMeals], [
        "laundry",
        laundryWatches,
      ]] as const
    ) {
      try {
        const marker = `automation:${name}:completed`, cursorName = `automation:${name}:cursor`;
        const [completed] =
          await db`select last_run_at_epoch_ms from jb.maintenance_state where name=${marker}`;
        const [pending] = await db`select name from jb.maintenance_state where name=${cursorName}`;
        if (
          !pending && completed &&
          Math.floor(Number(completed.last_run_at_epoch_ms) / MIN) === Math.floor(now / MIN)
        ) continue;
        const more = await fn(db, Date.now());
        remaining.push(more);
        if (!more) {
          await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${marker},${now},${token}) on conflict(name) do update set last_run_at_epoch_ms=excluded.last_run_at_epoch_ms,run_token=excluded.run_token`;
        }
      } catch {
        errors.push(name);
      }
    }
    await housekeeping(db, now);
    if (errors.length) throw new Error("AUTOMATION_STAGE_FAILED:" + errors.join(","));
    return { remaining: remaining.some(Boolean) };
  } finally {
    await db`delete from jb.maintenance_state where name='minute-automation:lease' and run_token=${token}`;
  }
}
