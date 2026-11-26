import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { authorize, checkRequestOrigin } from "../../functions/_shared/auth.ts";
import { validateAttendance } from "../../functions/_shared/account.ts";
import { validatePreferences, validateWatch } from "../../functions/_shared/personal.ts";
import { ApiError, normalizePath } from "../../functions/_shared/http.ts";
import { createHandler } from "../../functions/api/handler.ts";
import { optedOut, usageDay } from "../../functions/_shared/usage.ts";
import { normalizeManualCode } from "../../functions/_shared/crypto.ts";
import type { Db } from "../../functions/_shared/db.ts";
import type { Principal } from "../../functions/_shared/types.ts";
import { config } from "../support/config.ts";

const principal: Principal = {
  sessionId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  installationId: "test-desktop",
  kind: "desktop-ui",
  origin: "tauri://localhost",
};
Deno.test("route namespace and existing exact-origin authority boundary", () => {
  for (const path of ["/api/me/session", "/api/api/me/session", "/functions/v1/api/api/me/session"]) {
    assertEquals(normalizePath(path), "/api/me/session");
  }
  const req = new Request(config.publicBaseUrl + "/api/me/session", {
    headers: { Origin: "tauri://localhost" },
  });
  authorize(req, "/api/me/session", principal);
  assertThrows(
    () => authorize(new Request(req.url), "/api/me/session", principal),
    ApiError,
    "ORIGIN_NOT_ALLOWED",
  );
  assertThrows(() => authorize(req, "/api/desktop/heartbeat", principal), ApiError, "SESSION_KIND_DENIED");
  assertThrows(
    () => authorize(req, "/api/me/session", { ...principal, kind: "desktop" }),
    ApiError,
    "SESSION_KIND_DENIED",
  );
  assertThrows(
    () => authorize(req, "/api/me/pairings", { ...principal, kind: "mobile" }),
    ApiError,
    "DESKTOP_CAPABILITY_REQUIRED",
  );
});
Deno.test("cookie mutations require first-party origin including sibling-site CSRF", () => {
  for (const origin of ["https://evil.example", "https://other.sijun-yang.com", "null", ""]) {
    const req = new Request(config.publicBaseUrl + "/api/pairings/claims", {
      method: "POST",
      headers: origin ? { origin } : {},
    });
    assertThrows(
      () => checkRequestOrigin(req, "/api/pairings/claims", config),
      ApiError,
      "ORIGIN_NOT_ALLOWED",
    );
  }
});
Deno.test("unknown JSON keys, no authorization and OPTIONS execute the real handler without DB", async () => {
  const noDb = (() => {
    throw new Error("Unexpected SQL access");
  }) as unknown as Db;
  const handler = createHandler({ db: noDb, config });
  const unauthorized = await handler(new Request(config.publicBaseUrl + "/api/me/session"));
  assertEquals(unauthorized.status, 401);
  assertEquals(await unauthorized.json(), { error: "AUTHENTICATION_REQUIRED", issues: null });
  assertEquals(unauthorized.headers.get("cache-control"), "no-store");
  const invalid = await handler(
    new Request(config.publicBaseUrl + "/api/desktop/installations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "fixture.request" },
      body: JSON.stringify({ installationId: "fixture-desktop", extra: true }),
    }),
  );
  assertEquals(invalid.status, 400);
  assertEquals(invalid.headers.get("X-Request-ID"), "fixture.request");
  const preflight = await handler(
    new Request(config.publicBaseUrl + "/functions/v1/api/api/me/session", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("access-control-allow-origin"), "tauri://localhost");
  assertEquals(preflight.headers.get("access-control-allow-credentials"), null);
});
Deno.test("attendance coherent cohort, future timestamp and strict calendar validation", () => {
  const now = Date.parse("2026-10-19T00:00:00Z");
  const valid = {
    attendanceDate: "2026-10-19",
    cohortId: "cohort-1",
    cohortStatus: "active",
    cohortStartDate: "2026-10-01",
    cohortEndDate: "2026-12-31",
    morningChecked: true,
    eveningChecked: false,
    collectedAt: "2026-10-19T00:00:00Z",
  };
  assertEquals(validateAttendance(valid, now).collectedAt, now);
  assertThrows(() => validateAttendance({ ...valid, cohortStatus: "none" }, now), ApiError);
  assertThrows(() => validateAttendance({ ...valid, attendanceDate: "2026-02-30" }, now), ApiError);
  assertThrows(
    () => validateAttendance({ ...valid, collectedAt: "2026-10-19T00:03:00Z" }, now),
    ApiError,
    "ATTENDANCE_COLLECTION_TIME_INVALID",
  );
});
Deno.test("existing reminder interval and watch mode invariants", () => {
  assertThrows(
    () =>
      validatePreferences({
        enabled: true,
        morning: true,
        evening: true,
        morningStartHour: 9,
        eveningEndHour: 4,
        morningIntervalMinutes: 2,
        eveningIntervalMinutes: 15,
        skipSunday: false,
      }),
    ApiError,
  );
  assertThrows(
    () =>
      validateWatch({
        machineId: "washer-1",
        appliance: "washer",
        sessionId: "cycle-1",
        notificationMode: "confirmed-completion",
        notifyBeforeMinutes: 5,
      }),
    ApiError,
  );
  assertThrows(
    () =>
      validateWatch({
        machineId: "washer-1 ",
        appliance: "washer",
        sessionId: "cycle-1",
        notificationMode: "confirmed-completion",
        notifyBeforeMinutes: 0,
      }),
    ApiError,
  );
});
Deno.test("anonymous opt-out is presence based, KST midnight changes daily scope", () => {
  assertEquals(
    optedOut(new Request(config.publicBaseUrl, { headers: { cookie: "__Host-jb_usage_opt_out=" } })),
    true,
  );
  assertEquals(usageDay(Date.parse("2026-10-18T14:59:59Z")), "2026-10-18");
  assertEquals(usageDay(Date.parse("2026-10-18T15:00:00Z")), "2026-10-19");
  assertEquals(normalizeManualCode("o1-234 56789"), "0123456789");
});
