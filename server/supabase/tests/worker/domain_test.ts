import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { normalizeLaundry } from "../../functions/_shared/laundry-normalizer.ts";
import { boundedFetch, projectLaundry, targetWeek } from "../../functions/_shared/public-data.ts";
import { sourceWeekKey } from "../../functions/_shared/meal-normalizer.ts";
import {
  attendanceCopy,
  attendanceWindow,
  laundryDecision,
  mealNotificationPeriod,
  mealServiceDate,
} from "../../functions/_shared/automation.ts";
import { allowedEndpoint, pushSettlement, sendPush } from "../../functions/_shared/push.ts";
import { createECDH, randomBytes } from "node:crypto";
// @deno-types="npm:@types/web-push@3.6.4"
import webPush from "npm:web-push@3.6.7";
import type { Config } from "../../functions/_shared/config.ts";
import { handler } from "../../functions/collect-laundry/index.ts";
const at = "2026-08-20T04:45:00.000Z";
Deno.test("collector refuses redirect following and enforces streamed response size", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      assertEquals(init?.redirect, "error");
      assert(init?.signal);
      return Promise.resolve(new Response(new Uint8Array(5)));
    }) as typeof fetch;
    await assertRejects(() => boundedFetch("https://source.invalid", 4));
    const result = await boundedFetch("https://source.invalid", 5);
    assertEquals(result.bytes.length, 5);
  } finally {
    globalThis.fetch = original;
  }
});
const raw = (state: string, remaining = 49, error: string | null = null) => ({
  "워시타워_1": {
    dryer: {
      runState: { currentState: state },
      timer: { remainHour: 0, remainMinute: remaining, totalHour: 1, totalMinute: 0 },
      ...(error === null ? {} : { error }),
    },
  },
});
Deno.test("laundry rejects failed or malformed source without overwriting last good state", () => {
  for (
    const value of [{}, { 워시타워_1: null }, { 워시타워_1: { washer: null } }, {
      error: { message: "failed" },
    }]
  ) assertThrows(() => normalizeLaundry(value, "a", at, null));
});
Deno.test("dryer error and pause preserve cycle identity through power off", () => {
  const running = normalizeLaundry(raw("RUNNING"), "a", at, null),
    error = normalizeLaundry(
      raw("RUNNING", 49, "EMPTY_WATER_ALERT_ERROR"),
      "b",
      "2026-08-20T04:46:00.000Z",
      running,
    ),
    idle = normalizeLaundry(raw("POWER_OFF", 0), "c", "2026-08-20T04:47:00.000Z", error);
  assertEquals(error.events.find((e) => e.type === "ERROR_ENTERED")?.currentState, "RUNNING");
  assertEquals(idle.events.find((e) => e.type === "ERROR_CLEARED")?.currentState, "POWER_OFF");
  assertEquals(idle.machines[0].dryer?.sessionId, running.machines[0].dryer?.sessionId);
  const paused = normalizeLaundry(raw("PAUSE"), "d", "2026-08-20T04:46:00.000Z", running);
  assert(paused.events.some((e) => e.type === "PAUSED"));
});
Deno.test("unknown enum and missing state do not synthesize completion", () => {
  const v = normalizeLaundry(raw("FUTURE_STATE"), "a", at, null);
  assertEquals(v.unknownEnums.length, 1);
  assertEquals(v.machines[0].dryer?.operationalStatus, "UNKNOWN");
  const missing = normalizeLaundry({ "워시타워_1": { dryer: {} } }, "b", at, v);
  assertEquals(missing.events, []);
  assertEquals(missing.machines[0].dryer?.sessionId, v.machines[0].dryer?.sessionId);
});
Deno.test("freshness measures device hash age separately from collection success", () => {
  const v = normalizeLaundry(raw("RUNNING", 2), "a", at, null),
    now = Date.parse(at) + 7 * 60000,
    s = { consecutiveFailures: 0, lastError: null, lastSuccessAt: new Date(now).toISOString() };
  const projected = projectLaundry(v, s, now);
  assertEquals(projected.quality.sourceFreshness, "REFRESH_OVERDUE");
  assertEquals(projected.machines[0].dryer?.projection.status, "AWAITING_COMPLETION_CONFIRMATION");
  assertEquals(projected.capacity.men.startableLoads, null);
  assertEquals(
    projectLaundry(v, { ...s, lastError: "failure" }, now).quality.sourceFreshness,
    "COLLECTION_GAP",
  );
});
Deno.test("risk percentages and thresholds match Core", () => {
  const v = normalizeLaundry(raw("POWER_OFF", 0), "a", at, null);
  const p = projectLaundry(v, null, Date.parse(at), false, [{
    machine_id: "워시타워_1",
    appliance: "dryer",
    attempts: 5,
    errors: 2,
  }]);
  assertEquals(p.machines[0].dryer?.rate, 40);
  assertEquals(p.machines[0].dryer?.riskLevel, "slight");
});
const preference = {
  morning_enabled: true,
  evening_enabled: true,
  morning_start_hour: 8,
  evening_end_hour: 4,
  morning_interval_minutes: 15,
  evening_interval_minutes: 15,
};
Deno.test("attendance countdown ceil, morning grace and evening previous date", () => {
  const now = Date.parse("2026-08-20T08:30:00+09:00"), w = attendanceWindow(preference, "morning", now)!;
  assertEquals(attendanceCopy("morning", w, null, now).body, "10:00 마감까지 1시간 30분 남았습니다.");
  const grace = Date.parse("2026-08-20T10:00:01+09:00"), g = attendanceWindow(preference, "morning", grace)!;
  assertEquals(attendanceCopy("morning", g, null, grace).remainingMinutes, 10);
  assertEquals(attendanceWindow(preference, "morning", Date.parse("2026-08-20T10:10:00+09:00")), null);
  const evening = attendanceWindow(preference, "evening", Date.parse("2026-08-21T01:00:00+09:00"))!;
  assertEquals(evening.attendanceDate, "2026-08-20");
});
Deno.test("offline reminders are sparse and stop at one AM", () => {
  const now = Date.parse("2026-08-21T00:30:00+09:00"),
    w = attendanceWindow(preference, "evening", now, true)!;
  assertEquals(w.slot, "0000");
  assertEquals(attendanceWindow(preference, "evening", Date.parse("2026-08-21T01:00:00+09:00"), true), null);
  assertStringIncludes(attendanceCopy("evening", w, "desktop-offline", now).body, "PC가 연결되지 않아");
});
Deno.test("durable dryer incident beats apparent idle completion and replacement cycle", () => {
  const a = normalizeLaundry(raw("POWER_OFF", 0), "a", at, null).machines[0].dryer!;
  const w = {
    id: "w",
    user_id: "u",
    machine_id: "워시타워_1",
    appliance: "dryer",
    session_id: "old",
    notification_mode: "confirmed-completion",
    notify_before_minutes: 0,
    attention_unresolved: false,
    pending_attention_status: "ERROR",
    pending_attention_incident_id: "incident",
  };
  const d = laundryDecision(w, a, Date.parse(at))!;
  assertEquals(d.record.kind, "laundry-attention");
  assertEquals(d.complete, false);
  assertEquals(d.record.payload.remainingMinutes, null);
  assertEquals(laundryDecision({ ...w, attention_unresolved: true }, a, Date.parse(at)), null);
});
Deno.test("estimated completion does not complete a running watch", () => {
  const a = normalizeLaundry(raw("RUNNING", 0), "a", at, null).machines[0].dryer!,
    w = {
      id: "w",
      user_id: "u",
      machine_id: a.machineId,
      appliance: "dryer",
      session_id: a.sessionId,
      notification_mode: "estimated-completion",
      notify_before_minutes: 0,
    };
  const d = laundryDecision(w, a, Date.parse(at))!;
  assertEquals(d.record.kind, "laundry-completion-expected");
  assertEquals(d.complete, false);
});
Deno.test("meal week uses first Monday and Sunday targets upcoming week", () => {
  assertEquals(sourceWeekKey("2026년 8월 1주차", Date.parse(at)), "2026-08-03");
  assertEquals(sourceWeekKey("13월 1주차", Date.parse(at)), null);
  assertEquals(targetWeek(Date.parse("2026-08-23T12:00:00+09:00")), "2026-08-24");
  assertEquals(mealServiceDate({ title: "8월 20일 중식 메뉴", published_at: at }), "2026-08-20");
});
Deno.test("push endpoints reject redirects/private targets and retry is capped", () => {
  assert(allowedEndpoint("https://fcm.googleapis.com/fcm/send/a"));
  for (
    const url of [
      "http://fcm.googleapis.com/a",
      "https://localhost/a",
      "https://fcm.googleapis.com.evil.test/a",
      "https://user@fcm.googleapis.com/a",
      "https://fcm.googleapis.com:444/a",
    ]
  ) assertEquals(allowedEndpoint(url), false);
  assertEquals(pushSettlement("retry", 1, 999999, 0), { status: "retry", next: 30000 });
  assertEquals(pushSettlement("retry", 5, 999999, 0), { status: "failed", next: null });
  assertEquals(pushSettlement("gone", 1, 999999, 0), { status: "gone", next: null });
});
Deno.test("real AES128GCM encryption retains FCM endpoint, VAPID, TTL and maps gone/retry", async () => {
  const vapid = webPush.generateVAPIDKeys(), receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const config = {
    vapidPublicKey: vapid.publicKey,
    vapidPrivateKey: vapid.privateKey,
    vapidSubject: "mailto:ops@example.com",
  } as Config;
  const d = {
    endpoint: "https://fcm.googleapis.com/fcm/send/exact-original",
    p256dh: receiver.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    payload: { title: "검증", body: "암호화" },
    expires_at_epoch_ms: Date.now() + 60000,
  };
  for (const status of [201, 404, 410, 429, 503]) {
    let called = false;
    const result = await sendPush(
      d,
      config,
      Date.now(),
      ((url: RequestInfo | URL, init?: RequestInit) => {
        called = true;
        assertEquals(url, d.endpoint);
        const h = new Headers(init?.headers);
        assertEquals(h.get("content-encoding"), "aes128gcm");
        assertStringIncludes(h.get("authorization") ?? "", "vapid");
        assert(Number(h.get("ttl")) > 0);
        const bytes = init?.body as Uint8Array;
        assert(bytes.byteLength > JSON.stringify(d.payload).length);
        assertEquals(init?.redirect, "error");
        return Promise.resolve(new Response(null, { status }));
      }) as typeof fetch,
    );
    assert(called);
    assertEquals(
      result.status,
      status === 201 ? "delivered" : [404, 410].includes(status) ? "gone" : "retry",
    );
  }
});
Deno.test("job rejects wrong secret and wrong HTTP method before DB access", async () => {
  Deno.env.set("PAIRING_SECRET", "p".repeat(32));
  Deno.env.set("USAGE_HASH_SECRET", "u".repeat(32));
  Deno.env.set("JOB_SECRET", "j".repeat(32));
  assertEquals((await handler(new Request("https://test.invalid", { method: "GET" }))).status, 405);
  assertEquals(
    (await handler(
      new Request("https://test.invalid", { method: "POST", headers: { "x-job-secret": "wrong" } }),
    )).status,
    401,
  );
});
Deno.test("meal notifications only fire for today's KST daily menu", () => {
  const now = Date.parse("2026-11-26T09:30:00+09:00");
  const post = (title: string, publishedAt: string) => ({ title, body: "", published_at: publishedAt });
  assertEquals(
    mealNotificationPeriod(post("11월 26일(목) 석식 메뉴", "2026-11-26T07:50:00.000Z"), now),
    "dinner",
  );
  assertEquals(
    mealNotificationPeriod(post("11월 26일(목) 중식 메뉴", "2026-11-26T02:00:00.000Z"), now),
    "lunch",
  );
  // 어제 석식이 늦게 수집되거나 수정돼도 오늘 알림으로 나가지 않는다.
  assertEquals(
    mealNotificationPeriod(post("11월 25일(수) 석식 메뉴", "2026-11-25T08:00:00.000Z"), now),
    null,
  );
  // 제목에 날짜가 없으면 게시일(KST) 기준. 어제 저녁 게시물은 제외된다.
  assertEquals(mealNotificationPeriod(post("석식 메뉴", "2026-11-25T09:00:00.000Z"), now), null);
  assertEquals(mealNotificationPeriod(post("석식 메뉴", "2026-11-26T08:00:00.000Z"), now), "dinner");
  // KST 자정 직후: UTC로는 전날이지만 KST 기준 오늘 게시물이다.
  const afterMidnight = Date.parse("2026-11-26T00:10:00+09:00");
  assertEquals(
    mealNotificationPeriod(post("석식 메뉴", "2026-11-25T15:05:00.000Z"), afterMidnight),
    "dinner",
  );
  // 주간 식단표와 기타 게시물은 끼니 알림 대상이 아니다.
  assertEquals(
    mealNotificationPeriod(post("11월 4주차 주간 식단표 (중식/석식)", "2026-11-23T00:00:00.000Z"), now),
    null,
  );
  assertEquals(mealNotificationPeriod(post("오늘 저녁 운영 안내", "2026-11-26T05:00:00.000Z"), now), null);
});
Deno.test("meal service date picks the nearest year around new year", () => {
  assertEquals(
    mealServiceDate({ title: "12월 31일 석식 메뉴", published_at: "2027-01-01T00:00:00.000Z" }),
    "2026-12-31",
  );
  assertEquals(
    mealServiceDate({ title: "1월 1일 중식 메뉴", published_at: "2026-12-31T10:00:00.000Z" }),
    "2027-01-01",
  );
});
