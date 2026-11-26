import { type Db, transaction } from "./db.ts";
import type { Config } from "./config.ts";
import { boundedFetch, iso, sha256, sourceFailure, sourceSuccess } from "./public-data.ts";
import type { Row } from "./laundry-normalizer.ts";
import { classifyMeal, mealHeading } from "./meal-classification.ts";
const safeTypes: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export function sourceWeekKey(title: string | null, reference: number): string | null {
  const m = title?.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})주차/);
  if (!m) return null;
  const month = Number(m[2]), week = Number(m[3]);
  if (month < 1 || month > 12 || week < 1 || week > 6) return null;
  const year = new Date(reference + 9 * 3600000).getUTCFullYear(),
    years = m[1] ? [Number(m[1])] : [year, year - 1, year + 1];
  return years.map((y) => {
    const d = new Date(Date.UTC(y, month - 1, 1));
    d.setUTCDate(1 + (8 - d.getUTCDay()) % 7 + (week - 1) * 7);
    return d;
  }).sort((a, b) => Math.abs(a.getTime() - reference) - Math.abs(b.getTime() - reference))[0].toISOString()
    .slice(0, 10);
}
async function normalizePost(db: Db, raw: Row, at: string, deadline: AbortSignal) {
  const id = String(raw.id ?? "");
  if (!id.trim()) throw new Error("MEAL_ID_MISSING");
  const title = raw.title == null ? null : String(raw.title),
    pinned = raw.pinned === true,
    text = Array.isArray(raw.contents)
      ? raw.contents.filter((c: Row) => c.t === "text").map((c: Row) => String(c.v ?? "")).join("\n")
      : "";
  const publishedAt = Number(raw.published_at) > 0 ? iso(Number(raw.published_at)) : null;
  const [retention] =
    await db`select jb.daily_menu_expired(${id},${title},${text},${publishedAt}::timestamptz,${at}::timestamptz) as expired`;
  if (retention.expired) return null; // Skip expired lunch and dinner before fetching their images.
  const media = Array.isArray(raw.media) ? raw.media : [];
  if (media.length > 20) throw new Error("MEAL_IMAGE_LIMIT");
  const images: Row[] = [];
  for (const item of media) {
    if (item.type && item.type !== "image") continue;
    const mediaId = String(item.id ?? ""),
      sourceUrl = String(item.xlarge_url ?? item.url ?? "").replace(/^http:\/\//, "https://");
    if (!sourceUrl) continue;
    const [cached] =
      await db`select i.*,a.sha,a.content_type,a.extension,a.byte_length from jb.meal_image i join jb.meal_asset a on a.sha=i.asset_sha where post_id=${id} and media_id=${mediaId}`;
    if (cached?.source_url === sourceUrl) {
      images.push({ ...cached, media_id: mediaId });
      continue;
    }
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("INVALID_IMAGE_URL");
    const { response, bytes } = await boundedFetch(sourceUrl, 10 * 1024 * 1024, deadline),
      contentType = (response.headers.get("content-type")?.split(";")[0] ?? item.mimetype ?? "")
        .toLowerCase(),
      extension = safeTypes[contentType];
    if (!extension) throw new Error("UNSUPPORTED_IMAGE_TYPE");
    const sha = sha256(bytes);
    await db`insert into jb.meal_asset(sha,content_type,extension,byte_length,content) values(${sha},${contentType},${extension},${bytes.length},${bytes}) on conflict(sha) do nothing`;
    images.push({
      media_id: mediaId,
      source_url: sourceUrl,
      declared_content_type: item.mimetype ?? null,
      filename: item.filename ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      sha,
      content_type: contentType,
      extension,
      byte_length: bytes.length,
    });
  }
  const contentSha = sha256((title ?? "") + "\0" + text + images.map((i) => "\0" + i.sha).join(""));
  const updatedAt = Number(raw.updated_at) > 0 ? iso(Number(raw.updated_at)) : null;
  const classification = classifyMeal(title, text, pinned, Date.parse(updatedAt ?? publishedAt ?? at));
  return {
    id,
    title,
    pinned,
    text,
    images,
    contentSha,
    publishedAt,
    updatedAt,
    permalink: raw.permalink ?? null,
    status: raw.status ?? null,
    kind: classification.kind,
    weekKey: classification.category === "WEEKLY_MENU"
      ? sourceWeekKey(mealHeading(title, text), Date.parse(updatedAt ?? at))
      : null,
  };
}
async function savePost(db: Db, p: NonNullable<Awaited<ReturnType<typeof normalizePost>>>, at: string) {
  // 두 source가 서로 다른 시점의 스냅샷을 순회하므로, 이미 저장된 것보다 오래된 수정본이
  // 나중에 처리되면 새 내용을 옛 내용으로 되돌리지 않도록 updated_at이 앞서지 않는 경우만 갱신한다.
  const saved =
    await db`insert into jb.meal_post(id,kind,content_sha,title,body,pinned,published_at,updated_at,permalink,status,first_seen_at,content_first_seen_at,last_seen_at) values(${p.id},${p.kind},${p.contentSha},${p.title},${p.text},${p.pinned},${p.publishedAt},${p.updatedAt},${p.permalink},${p.status},${at},${at},${at}) on conflict(id) do update set kind=excluded.kind,content_first_seen_at=case when jb.meal_post.content_sha<>excluded.content_sha then excluded.content_first_seen_at else jb.meal_post.content_first_seen_at end,content_sha=excluded.content_sha,title=excluded.title,body=excluded.body,pinned=excluded.pinned,published_at=excluded.published_at,updated_at=excluded.updated_at,permalink=excluded.permalink,status=excluded.status,last_seen_at=greatest(jb.meal_post.last_seen_at,excluded.last_seen_at) where excluded.updated_at is null or jb.meal_post.updated_at is null or excluded.updated_at>=jb.meal_post.updated_at returning id`;
  if (!saved.length) return;
  await db`delete from jb.meal_image where post_id=${p.id}`;
  for (let position = 0; position < p.images.length; position++) {
    const i = p.images[position];
    await db`insert into jb.meal_image(post_id,media_id,position,source_url,declared_content_type,filename,width,height,asset_sha) values(${p.id},${i.media_id},${position},${i.source_url},${i.declared_content_type},${i.filename},${i.width},${i.height},${i.sha})`;
  }
  if (p.weekKey) {
    await db`insert into jb.meal_weekly_menu(week_key,content_sha,post_id,updated_at,observed_at) values(${p.weekKey},${p.contentSha},${p.id},${p.updatedAt},${at}) on conflict(week_key) do update set content_sha=excluded.content_sha,post_id=excluded.post_id,updated_at=excluded.updated_at,observed_at=excluded.observed_at`;
  }
}
export async function collectMeals(db: Db, config: Config) {
  if (!config.collectorsEnabled) return { skipped: "collectors_disabled" };
  const failures: string[] = [], results: Row[] = [];
  for (
    const [source, url] of [["meals-include-pinned", config.mealsPinnedSourceUrl], [
      "meals-default",
      config.mealsDefaultSourceUrl,
    ]]
  ) {
    if (!url) continue;
    try {
      const name = `collector:${source}`, token = crypto.randomUUID(), now = Date.now();
      // Cursor and lease are durable; a crash can only replay a committed post.
      const [lease] = await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${
        name + ":lease"
      },${now},${token}) on conflict(name) do update set last_run_at_epoch_ms=excluded.last_run_at_epoch_ms,run_token=excluded.run_token where jb.maintenance_state.last_run_at_epoch_ms<=${
        now - 120000
      } returning run_token`;
      if (!lease) {
        results.push({ source, skipped: "leased" });
        continue;
      }
      try {
        const [cursor] = await db`select run_token from jb.maintenance_state where name=${name + ":cursor"}`;
        let saved: { sha: string; items: Row[]; index: number; at: string };
        if (cursor) saved = JSON.parse(cursor.run_token);
        else {
          const { bytes } = await boundedFetch(url, 2 * 1024 * 1024);
          const root = JSON.parse(new TextDecoder().decode(bytes));
          if (!Array.isArray(root.items) || root.items.length > 1000) throw new Error("INVALID_MEAL_ITEMS");
          saved = { sha: sha256(bytes), items: root.items, index: 0, at: new Date().toISOString() };
          // Persist the input snapshot as well as its offset, so a changing upstream
          // response cannot continually reset progress and starve older posts.
          await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${
            name + ":cursor"
          },${now},${
            JSON.stringify(saved)
          }) on conflict(name) do update set run_token=excluded.run_token,last_run_at_epoch_ms=excluded.last_run_at_epoch_ms`;
        }
        const start = saved.index, at = saved.at, sha = saved.sha, root = { items: saved.items };
        // 게시물마다 커밋하면서 시간 예산 안에서 최대한 처리한다. 예전처럼 호출당 1개만 처리하면
        // 피드 전체를 도는 동안 새 스냅샷을 못 찍어서 새로 올라온 식단 반영이 수 분씩 밀렸다.
        // 예산(25초)은 lease(120초)와 함수 타임아웃보다 충분히 짧다.
        const budgetEndsAt = Date.now() + 25_000;
        let end = start;
        for (let index = start; index < root.items.length; index++) {
          if (index > start && Date.now() >= budgetEndsAt) break;
          end = index + 1;
          await transaction(db, async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtext('jb-meal-assets'))`;
            const post = await normalizePost(tx, root.items[index], at, AbortSignal.timeout(40000));
            if (post) await savePost(tx, post, at);
            await tx`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values(${
              name + ":cursor"
            },${now},${
              JSON.stringify({ ...saved, index: index + 1, failures: 0 })
            }) on conflict(name) do update set run_token=excluded.run_token,last_run_at_epoch_ms=excluded.last_run_at_epoch_ms`;
          });
        }
        if (end === root.items.length) {
          await transaction(db, async (tx) => {
            await sourceSuccess(tx, source, sha, at);
            await tx`delete from jb.maintenance_state where name=${name + ":cursor"}`;
          });
        }
        results.push({ source, processed: end - start, remaining: root.items.length - end });
      } finally {
        await db`delete from jb.maintenance_state where name=${name + ":lease"} and run_token=${token}`;
      }
    } catch {
      // A poison publication must not pin an obsolete upstream snapshot forever.
      // Keep failures visible, but refetch after three failed attempts so upstream
      // corrections/deletions can recover without operator database edits.
      const cursorName = `collector:${source}:cursor`;
      const [cursor] = await db`select run_token from jb.maintenance_state where name=${cursorName}`;
      if (cursor) {
        const saved = JSON.parse(cursor.run_token);
        saved.failures = Number(saved.failures ?? 0) + 1;
        if (saved.failures >= 3) {
          await db`delete from jb.maintenance_state where name=${cursorName} and run_token=${cursor.run_token}`;
        } else {await db`update jb.maintenance_state set run_token=${
            JSON.stringify(saved)
          } where name=${cursorName} and run_token=${cursor.run_token}`;}
      }
      await sourceFailure(db, source, new Date().toISOString(), "MEAL_COLLECTION_FAILED");
      failures.push(source);
    }
  }
  if (failures.length) throw new Error("MEAL_COLLECTION_FAILED");
  return { sources: results };
}
