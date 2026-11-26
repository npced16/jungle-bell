import { type Db, transaction } from "./db.ts";
import type { Config } from "./config.ts";
import { ApiError, json } from "./http.ts";
import { type Appliance, type LaundryVersion, normalizeLaundry, type Row } from "./laundry-normalizer.ts";
import { createHash } from "node:crypto";
import { classifyMeal } from "./meal-classification.ts";

export const iso = (v: any): string | null => v == null ? null : new Date(v).toISOString();
export const sha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const sourceDto = (r: Row) => ({
  source: r.source,
  lastAttemptAt: iso(r.last_attempt_at),
  lastSuccessAt: iso(r.last_success_at),
  lastResponseSha: r.last_response_sha,
  versionFirstSeenAt: iso(r.version_first_seen_at),
  consecutiveFailures: r.consecutive_failures,
  lastError: r.last_error,
});
export async function latestLaundry(db: Db): Promise<LaundryVersion | null> {
  const rows =
    await db`select normalized from (select normalized,0 priority,last_seen_at from jb.laundry_current where source='laundry' union all select normalized,1 priority,last_seen_at from jb.laundry_version) v where exists(select 1 from jsonb_array_elements(normalized->'machines') m where jsonb_typeof(m->'washer')='object' or jsonb_typeof(m->'dryer')='object') order by priority,last_seen_at desc limit 1`;
  return rows[0]?.normalized ?? null;
}
export async function sourceSuccess(db: Db, source: string, sha: string, at: string) {
  await db`insert into jb.source_state(source,last_attempt_at,last_success_at,last_response_sha,version_first_seen_at,consecutive_failures,last_error) values(${source},${at},${at},${sha},${at},0,null) on conflict(source) do update set last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_response_sha=excluded.last_response_sha,version_first_seen_at=case when jb.source_state.last_response_sha=excluded.last_response_sha then jb.source_state.version_first_seen_at else excluded.version_first_seen_at end,consecutive_failures=0,last_error=null`;
}
export async function sourceFailure(db: Db, source: string, at: string, error: string) {
  await db`insert into jb.source_state(source,last_attempt_at,consecutive_failures,last_error) values(${source},${at},1,${
    error.slice(0, 2000)
  }) on conflict(source) do update set last_attempt_at=excluded.last_attempt_at,consecutive_failures=jb.source_state.consecutive_failures+1,last_error=excluded.last_error`;
}
export async function boundedFetch(
  url: string,
  maxBytes: number,
  deadline?: AbortSignal,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url, {
    redirect: "error",
    signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
  });
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("SOURCE_TOO_LARGE");
  }
  if (!response.body) throw new Error("SOURCE_EMPTY");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("SOURCE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { response, bytes };
}
function uuidName(value: string) {
  const b = createHash("md5").update(value).digest();
  b[6] = (b[6] & 15) | 48;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function collectLaundry(db: Db, config: Config) {
  if (!config.collectorsEnabled || !config.laundrySourceUrl) return { skipped: "source_not_configured" };
  const started = Date.now(),
    minute = Math.floor(started / 60000),
    scheduled = new Date(minute * 60000).toISOString();
  let status: number | null = null;
  try {
    const { response, bytes } = await boundedFetch(config.laundrySourceUrl, 1024 * 1024);
    status = response.status;
    const raw = JSON.parse(new TextDecoder().decode(bytes)),
      sha = sha256(bytes),
      at = new Date().toISOString();
    await transaction(db, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('jb-laundry-collection'))`;
      const previous = await latestLaundry(tx), version = normalizeLaundry(raw, sha, at, previous);
      const [state] = await tx`select * from jb.source_state where source='laundry'`;
      const changed = state?.last_response_sha !== sha,
        firstSeen = (!changed && state?.version_first_seen_at) ? iso(state.version_first_seen_at)! : at;
      await tx`insert into jb.laundry_version(sha,normalized,first_seen_at,last_seen_at) values(${sha},${
        tx.json(version as any)
      },${firstSeen},${at}) on conflict(sha) do update set last_seen_at=excluded.last_seen_at`;
      await tx`insert into jb.laundry_current(source,sha,normalized,first_seen_at,last_seen_at) select 'laundry',sha,case when ${changed} then ${
        tx.json(version as any)
      } else normalized end,case when ${changed} then ${firstSeen}::timestamptz else first_seen_at end,${at} from jb.laundry_version where sha=${sha} on conflict(source) do update set sha=case when ${changed} then excluded.sha else jb.laundry_current.sha end,normalized=case when ${changed} then excluded.normalized else jb.laundry_current.normalized end,first_seen_at=case when ${changed} then excluded.first_seen_at else jb.laundry_current.first_seen_at end,last_seen_at=excluded.last_seen_at`;
      if (changed) {
        for (const e of version.events) {
          await tx`insert into jb.laundry_event(id,machine_id,appliance,session_id,type,previous_observed_at,observed_at,eta_delta_minutes,previous_state,current_state,detail) values(${
            uuidName(e.id)
          },${e.machineId},${e.appliance},${e.sessionId},${e.type},${e.previousObservedAt},${e.observedAt},${e.etaDeltaMinutes},${e.previousState},${e.currentState},${
            tx.json(e.detail)
          }) on conflict(id) do nothing`;
        }
      }
      await sourceSuccess(tx, "laundry", sha, at);
      await tx`insert into jb.minute_observation(source,minute_epoch,scheduled_at,collected_at,status,version_sha,version_first_seen_at,changed,duration_ms,http_status,error) values('laundry',${minute},${scheduled},${at},'SUCCESS',${sha},${firstSeen},${changed},${
        Date.now() - started
      },${status},null) on conflict(source,minute_epoch) do update set collected_at=excluded.collected_at,status=excluded.status,version_sha=excluded.version_sha,version_first_seen_at=excluded.version_first_seen_at,changed=excluded.changed,duration_ms=excluded.duration_ms,http_status=excluded.http_status,error=null`;
    });
    return { collected: true };
  } catch (error) {
    const at = new Date().toISOString();
    await transaction(db, async (tx) => {
      await sourceFailure(tx, "laundry", at, "LAUNDRY_COLLECTION_FAILED");
      await tx`insert into jb.minute_observation(source,minute_epoch,scheduled_at,collected_at,status,changed,duration_ms,http_status,error) values('laundry',${minute},${scheduled},${at},'FAILED',false,${
        Date.now() - started
      },${status},'LAUNDRY_COLLECTION_FAILED') on conflict(source,minute_epoch) do update set collected_at=excluded.collected_at,status='FAILED',version_sha=null,version_first_seen_at=null,changed=false,duration_ms=excluded.duration_ms,http_status=excluded.http_status,error=excluded.error`;
    });
    throw error;
  }
}
export function projectLaundry(
  version: LaundryVersion,
  state: Row | null,
  asOf: number,
  final = false,
  risks: Row[] = [],
) {
  const age = Math.max(0, Math.floor((asOf - Date.parse(version.observedAt)) / 1000));
  const active = version.machines.some((m) =>
    [m.washer, m.dryer].some((a) => a?.operationalStatus === "RUNNING")
  );
  const healthy = !!state && state.consecutiveFailures === 0 && state.lastError === null &&
    state.lastSuccessAt !== null && asOf - Date.parse(state.lastSuccessAt) <= 120000;
  const freshness = !healthy
    ? "COLLECTION_GAP"
    : age <= 60
    ? "REFRESH_OBSERVED"
    : active && age > 360
    ? "REFRESH_OVERDUE"
    : active && age <= 300
    ? "WITHIN_REFRESH_WINDOW"
    : "UNVERIFIABLE_STABLE";
  const quality = {
    collectorHealthy: healthy,
    collection: healthy ? "SUCCESS" : "STALE",
    sourceFreshness: freshness,
    certainty: !healthy
      ? "UNAVAILABLE"
      : active && freshness !== "REFRESH_OBSERVED"
      ? "PROVISIONAL_DEVICE_STATE"
      : "OBSERVED_API_VALUE",
    basis: "HASH_CADENCE",
    lastCheckedAt: state?.lastSuccessAt ?? null,
    expectedRefreshIntervalSeconds: 300,
  };
  const project = (a: Appliance | null): Appliance | null => {
    if (!a) return null;
    let remaining: number | null = a.remainingMinutes, estimated = false, status = "UNKNOWN";
    if (a.operationalStatus === "RUNNING") {
      remaining = a.estimatedFinishAt
        ? Math.max(0, Math.ceil(Math.floor((Date.parse(a.estimatedFinishAt) - asOf) / 1000) / 60))
        : remaining;
      estimated = asOf > Date.parse(a.observedAt);
      status = remaining === 0 ? "AWAITING_COMPLETION_CONFIRMATION" : "ESTIMATED_RUNNING";
    } else if (a.operationalStatus === "COMPLETED") {
      remaining = 0;
      status = "CONFIRMED_COMPLETED";
    } else if (["PAUSED", "ERROR"].includes(a.operationalStatus)) status = a.operationalStatus;
    else if (["IDLE", "SCHEDULED"].includes(a.operationalStatus)) status = "IDLE";
    else remaining = null;
    const risk = risks.find((r) => r.machine_id === a.machineId && r.appliance === a.appliance),
      attempts = Number(risk?.attempts ?? 0),
      errors = Number(risk?.errors ?? 0),
      rate = attempts ? errors * 100 / attempts : 0;
    return {
      ...a,
      projection: { asOf: new Date(asOf).toISOString(), remainingMinutes: remaining, status, estimated },
      attempts,
      errors,
      rate,
      riskLevel: rate > 40 ? "caution" : rate > 10 ? "slight" : "safe",
    };
  };
  const machines = version.machines.map((m) => ({
    id: m.id,
    washer: project(m.washer),
    dryer: project(m.dryer),
  }));
  const number = (id: string) => Number(id.trim().match(/(?:워시타워[_\s-]*)?(\d+)$/)?.[1] ?? NaN);
  const available = (a: Appliance | null) =>
    a?.operationalStatus === "IDLE" && a?.projection?.status === "IDLE";
  const within = (a: Appliance | null) =>
    a && a.operationalStatus !== "ERROR" &&
    !["PAUSED", "AWAITING_COMPLETION_CONFIRMATION", "UNKNOWN"].includes(a.projection?.status) &&
    a.projection?.remainingMinutes != null && a.projection.remainingMinutes >= 0 &&
    a.projection.remainingMinutes <= 60 &&
    (a.operationalStatus === "RUNNING" || ["OBSERVED", "ESTIMATED_RUNNING"].includes(a.projection.status));
  const pending = (a: Appliance | null) => {
    if (!a || available(a) || a.operationalStatus === "ERROR" || !a.projection) return false;
    const p = a.projection;
    if (
      !["RUNNING", "COURSE_RUNNING", "PAUSED", "SCHEDULED"].includes(a.operationalStatus) &&
      !["OBSERVED", "ESTIMATED_RUNNING", "AWAITING_COMPLETION_CONFIRMATION", "PAUSED"].includes(p.status)
    ) return false;
    return ["PAUSED", "SCHEDULED"].includes(a.operationalStatus) ||
      ["PAUSED", "AWAITING_COMPLETION_CONFIRMATION"].includes(p.status) || p.remainingMinutes == null ||
      p.remainingMinutes <= 60;
  };
  const capacity = (access: string) => {
    const required = access === "men" ? [1, 2, 3, 4, 5, 6, 7] : [6, 7, 8, 9],
      selected = machines.filter((m) => required.includes(number(m.id)));
    const washerAvailable = selected.filter((m) => available(m.washer)).length,
      projectedDryerSupply = selected.filter((m) => available(m.dryer) || within(m.dryer)).length,
      pendingDryerLoads = selected.filter((m) => pending(m.washer)).length,
      dryerHeadroom = Math.max(0, projectedDryerSupply - pendingDryerLoads),
      reliable = healthy &&
        ["REFRESH_OBSERVED", "WITHIN_REFRESH_WINDOW", "UNVERIFIABLE_STABLE"].includes(freshness) &&
        required.every((n) => machines.some((m) => number(m.id) === n && m.washer && m.dryer));
    return {
      access,
      washerAvailable,
      projectedDryerSupply,
      pendingDryerLoads,
      dryerHeadroom,
      startableLoads: reliable ? Math.min(washerAvailable, dryerHeadroom) : null,
      reliable,
    };
  };
  return {
    schemaVersion: 1,
    sourceVersionSha: version.sourceVersionSha,
    asOf: new Date(asOf).toISOString(),
    final,
    quality,
    machines,
    events: version.events,
    unknownEnums: version.unknownEnums,
    capacity: { basis: "WASHER_AND_DRYER_HEADROOM_60_MIN", men: capacity("men"), women: capacity("women") },
  };
}
async function laundryRisks(db: Db, asOf: number) {
  return await db`with sessions as(select machine_id,appliance,session_id,bool_or(type='ERROR_ENTERED') errored from jb.laundry_event where observed_at>=${new Date(
    asOf - 7 * 86400000,
  )} and observed_at<=${new Date(
    asOf,
  )} and session_id is not null group by machine_id,appliance,session_id having bool_or(type='STARTED')) select machine_id,appliance,count(*) attempts,count(*) filter(where errored) errors from sessions group by machine_id,appliance`;
}
export async function mealPosts(
  db: Db,
  base: string,
  from: string | null = null,
  to: string | null = null,
  ids: string[] | null = null,
) {
  const rows =
    await db`select * from jb.meal_post where (${from}::timestamptz is null or published_at>=${from}::timestamptz) and (${to}::timestamptz is null or published_at<${to}::timestamptz) and (${
      ids === null
    } or id=any(${ids ?? []}::text[])) order by published_at desc nulls last,id limit ${
      from ? 500 : ids ? 100 : 100
    }`;
  const images = rows.length
    ? await db`select i.*,a.sha,a.content_type,a.extension,a.byte_length from jb.meal_image i join jb.meal_asset a on a.sha=i.asset_sha where i.post_id=any(${
      rows.map((r) => r.id)
    }::text[]) order by i.post_id,i.position`
    : [];
  return rows.map((r) => ({
    id: r.id,
    ...classifyMeal(
      r.title,
      r.body,
      r.pinned,
      Date.parse(iso(r.updated_at ?? r.published_at ?? r.first_seen_at)!),
    ),
    contentSha: r.content_sha,
    title: r.title,
    text: r.body,
    pinned: r.pinned,
    publishedAt: iso(r.published_at),
    updatedAt: iso(r.updated_at),
    permalink: r.permalink?.replace(/^http:\/\/pf\.kakao\.com\//, "https://pf.kakao.com/") ?? null,
    status: r.status,
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    images: images.filter((i) => i.post_id === r.id).map((i) => ({
      postId: r.id,
      mediaId: i.media_id,
      sourceUrl: i.source_url,
      declaredContentType: i.declared_content_type,
      filename: i.filename,
      width: i.width,
      height: i.height,
      sha: i.sha,
      url: `${base.replace(/\/$/, "")}/api/public/assets/${i.sha}.${i.extension}`,
      contentType: i.content_type,
      extension: i.extension,
      byteLength: Number(i.byte_length),
    })),
  }));
}
export const targetWeek = (now: number) => {
  const d = new Date(now + 9 * 3600000);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? 1 : 1 - day));
  return d.toISOString().slice(0, 10);
};
export async function handlePublic(
  req: Request,
  path: string,
  db: Db,
  config: Config,
): Promise<Response | null> {
  if (req.method !== "GET" || (!path.startsWith("/api/public/") && path !== "/api/health")) return null;
  const params = new URL(req.url).searchParams, now = Date.now(), asOf = Math.floor(now / 30000) * 30000;
  const latest = { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120" },
    immutable = { "Cache-Control": "public, max-age=31536000, immutable" };
  const states = async () => (await db`select * from jb.source_state order by source`).map(sourceDto);
  if (path === "/api/health") {
    const sources = await states(),
      bad = sources.length < 3 ||
        sources.some((s) =>
          !s.lastSuccessAt || s.consecutiveFailures > 0 || now - Date.parse(s.lastSuccessAt) > 900000
        );
    return json(
      { status: bad ? "DEGRADED" : "OK", checkedAt: new Date(now).toISOString(), sources },
      bad ? 503 : 200,
    );
  }
  if (path === "/api/public/status") {
    return json({ asOf: new Date(asOf).toISOString(), sources: await states() }, 200, latest);
  }
  if (path === "/api/public/laundry/head") {
    const s = (await states()).find((s) => s.source === "laundry");
    if (!s) throw new ApiError("NO_DATA", 503);
    return json(s, 200, latest);
  }
  if (path === "/api/public/laundry") {
    const v = await latestLaundry(db);
    if (!v) throw new ApiError("NO_DATA", 503);
    return json(
      projectLaundry(
        v,
        (await states()).find((s) => s.source === "laundry") ?? null,
        asOf,
        false,
        await laundryRisks(db, asOf),
      ),
      200,
      latest,
    );
  }
  if (path === "/api/public/laundry/at") {
    const time = Date.parse(params.get("time") ?? "");
    if (!Number.isFinite(time)) throw new ApiError("INVALID_REQUEST");
    const compact = new Date(time).toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
    return new Response(null, {
      status: 308,
      headers: { ...immutable, Location: `/api/public/laundry/minutes/${compact}` },
    });
  }
  let match = path.match(/^\/api\/public\/laundry\/versions\/([a-f0-9]{64})$/);
  if (path.startsWith("/api/public/laundry/versions/") && !match) throw new ApiError("INVALID_REQUEST");
  if (match) {
    const [v] = await db`select normalized from jb.laundry_version where sha=${match[1]}`;
    if (!v) throw new ApiError("VERSION_NOT_FOUND", 404);
    return json(v.normalized, 200, immutable);
  }
  match = path.match(/^\/api\/public\/laundry\/minutes\/(.+)$/);
  if (match) {
    const m = match[1], parts = m.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/);
    if (!parts) throw new ApiError("INVALID_MINUTE");
    const t = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z" !== m) {
      throw new ApiError("INVALID_MINUTE");
    }
    const [r] = await db`select * from jb.minute_observation where source='laundry' and minute_epoch=${
      t / 60000
    }`;
    if (!r) throw new ApiError("OBSERVATION_NOT_FOUND", 404);
    const o = {
      source: r.source,
      minuteEpoch: Number(r.minute_epoch),
      scheduledAt: iso(r.scheduled_at),
      collectedAt: iso(r.collected_at),
      status: r.status,
      versionSha: r.version_sha,
      versionFirstSeenAt: iso(r.version_first_seen_at),
      changed: r.changed,
      durationMs: Number(r.duration_ms),
      httpStatus: r.http_status,
      error: r.error,
    };
    const [v] = await db`select normalized from jb.laundry_version where sha=${r.version_sha}`;
    return json(
      {
        minute: m,
        observation: o,
        data: v
          ? projectLaundry(
            v.normalized,
            {
              consecutiveFailures: r.status === "SUCCESS" ? 0 : 1,
              lastError: r.error,
              lastSuccessAt: r.status === "SUCCESS" ? o.collectedAt : null,
            },
            t,
            true,
            await laundryRisks(db, t),
          )
          : null,
      },
      200,
      immutable,
    );
  }
  if (path === "/api/public/laundry/events") {
    const limit = Number(params.get("limit") ?? 100), since = params.get("since");
    if (
      !Number.isInteger(limit) || limit < 1 || limit > 500 || since && !Number.isFinite(Date.parse(since))
    ) throw new ApiError("INVALID_REQUEST");
    const rows =
      await db`select * from jb.laundry_event where (${since}::timestamptz is null or observed_at>${since}::timestamptz) order by observed_at,id limit ${limit}`;
    return json(
      {
        events: rows.map((r) => ({
          id: r.id,
          machineId: r.machine_id,
          appliance: r.appliance,
          sessionId: r.session_id,
          type: r.type,
          previousObservedAt: iso(r.previous_observed_at),
          observedAt: iso(r.observed_at),
          etaDeltaMinutes: r.eta_delta_minutes,
          previousState: r.previous_state,
          currentState: r.current_state,
          detail: r.detail,
        })),
      },
      200,
      latest,
    );
  }
  if (path === "/api/public/meals") {
    const state = (await states()).find((s) => s.source === "meals-include-pinned"),
      posts = await mealPosts(db, config.publicBaseUrl);
    if (!state || !posts.length) throw new ApiError("NO_DATA", 503);
    const weekly =
      await db`select week_key::text,content_sha,post_id from jb.meal_weekly_menu order by week_key desc limit 100`;
    const weeklyPosts = weekly.length
      ? await mealPosts(db, config.publicBaseUrl, null, null, weekly.map((w) => w.post_id))
      : [];
    const weeklyMenus = weekly.flatMap((w) => {
        const post = weeklyPosts.find((p) =>
          p.id === w.post_id && p.contentSha === w.content_sha && p.category === "WEEKLY_MENU"
        );
        return post ? [{ weekKey: w.week_key, contentSha: w.content_sha, post }] : [];
      }),
      target = targetWeek(now),
      current = weeklyMenus.find((w) => w.weekKey === target),
      dailyMenus = posts.filter((p) => p.kind === "DAILY_MENU");
    return json(
      {
        asOf: new Date(asOf).toISOString(),
        lastCheckedAt: state.lastSuccessAt,
        data: {
          schemaVersion: 2,
          dailyMenus,
          pinnedMenus: posts.filter((p) => p.kind === "PINNED_MENU"),
          recentMenus: dailyMenus.slice(0, 40),
          otherPosts: posts.filter((p) => p.category === "OTHER"),
          weeklyPosts: posts.filter((p) => p.category === "WEEKLY_MENU"),
          currentWeeklyMenu: {
            targetWeekKey: target,
            status: current ? "AVAILABLE" : "AWAITING_UPDATE",
            contentSha: current?.contentSha ?? null,
            post: current?.post ?? null,
          },
          weeklyMenus,
        },
      },
      200,
      latest,
    );
  }
  if (path === "/api/public/meals/history") {
    const month = params.get("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError("INVALID_REQUEST");
    const from = new Date(`${month}-01T00:00:00+09:00`), to = new Date(`${month}-01T00:00:00Z`);
    to.setUTCMonth(to.getUTCMonth() + 1);
    to.setUTCHours(-9);
    return json(
      { posts: await mealPosts(db, config.publicBaseUrl, from.toISOString(), to.toISOString()) },
      200,
      latest,
    );
  }
  match = path.match(/^\/api\/public\/assets\/([a-f0-9]{64})\.([a-z0-9]{1,8})$/);
  if (path.startsWith("/api/public/assets/") && !match) throw new ApiError("INVALID_REQUEST");
  if (match) {
    const [a] = await db`select * from jb.meal_asset where sha=${match[1]} and extension=${match[2]}`;
    if (!a) throw new ApiError("ASSET_NOT_FOUND", 404);
    return new Response(a.content, {
      headers: {
        ...immutable,
        "Content-Type": a.content_type,
        "Content-Length": String(a.byte_length),
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }
  return null;
}
