import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHandler } from "../../functions/api/handler.ts";
import { createTestDatabase } from "../support/database.ts";
import { config } from "../support/config.ts";
import { transaction } from "../../functions/_shared/db.ts";

Deno.test("HTTP API + original migration SQL integration", async (t) => {
  const store = await createTestDatabase(), db = store.db;
  const handler = createHandler({ db, config });
  const call = (
    path: string,
    method = "GET",
    data?: unknown,
    token?: string,
    cookie?: string,
    origin?: string,
  ) => {
    const headers = new Headers();
    if (data !== undefined) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (cookie) headers.set("Cookie", cookie);
    if (origin) headers.set("Origin", origin);
    return handler(
      new Request(config.publicBaseUrl + path, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
    );
  };
  const data = async (response: Response, status = 200) => {
    assertEquals(response.status, status, response.status === status ? undefined : await response.text());
    return response.json();
  };
  const cookieValue = (res: Response, name: string) => {
    const header = res.headers.getSetCookie().find((v) => v.startsWith(name + "="));
    assert(header);
    return header.split(";")[0];
  };
  let desktop = "", other = "", ui = "", otherUi = "", mobileCookie = "", pairingId = "";
  try {
    await t.step("28 tables isolated from anon/authenticated and transactional rollback", async () => {
      const [count] =
        await db`SELECT count(*)::integer n FROM information_schema.tables WHERE table_schema='jb' AND table_type='BASE TABLE'`;
      assertEquals(count.n, 28);
      for (const role of ["anon", "authenticated"]) {
        const [permissions] =
          await db`SELECT has_schema_privilege(${role},'jb','USAGE') AS usage,has_table_privilege(${role},'jb.app_session','SELECT') AS read`;
        assertEquals(permissions, { usage: false, read: false });
      }
      await assertRejects(() =>
        transaction(db, async (tx) => {
          await tx`INSERT INTO jb.app_user VALUES ('00000000-0000-0000-0000-000000000099',0)`;
          throw new Error("rollback fixture");
        })
      );
      assertEquals((await db`SELECT 1 FROM jb.app_user`).length, 0);
    });
    await t.step("enroll defaults pending/OFF, duplicate identity and exact UI token DTO", async () => {
      const a = await data(
        await call("/api/desktop/installations", "POST", { installationId: "fixture-desktop-a" }),
        201,
      );
      desktop = a.accessToken;
      assert(/^jbd_[a-f0-9]{64}$/.test(desktop));
      assertEquals(Object.keys(a).sort(), ["accessToken", "expiresAt"]);
      assertEquals(new Date(a.expiresAt).toISOString(), a.expiresAt);
      const conflict = await call("/api/desktop/installations", "POST", {
        installationId: "fixture-desktop-a",
      });
      assertEquals(conflict.status, 409);
      other = (await data(
        await call("/api/desktop/installations", "POST", {
          installationId: "fixture-desktop-b",
          usageAnalyticsEnabled: true,
        }),
        201,
      )).accessToken;
      const issued = await data(
        await call("/api/desktop/webview-sessions", "POST", { origin: "tauri://localhost" }, desktop),
        201,
      );
      ui = issued.accessToken;
      assert(/^jbui_[a-f0-9]{64}$/.test(ui));
      assert(Date.parse(issued.expiresAt) - Date.now() > 400000);
      otherUi = (await data(
        await call("/api/desktop/webview-sessions", "POST", { origin: "tauri://localhost" }, other),
        201,
      )).accessToken;
      assertEquals(
        (await data(await call("/api/desktop/usage-preference", "GET", undefined, desktop))).enabled,
        null,
      );
    });
    await t.step("desktop UI namespace denial and replacement invalidates previous UI", async () => {
      assertEquals((await call("/api/me/attendance", "GET", undefined, desktop)).status, 403);
      assertEquals((await call("/api/me/attendance", "GET", undefined, ui)).status, 403);
      assertEquals(
        (await call("/api/desktop/attendance", "GET", undefined, ui, undefined, "tauri://localhost")).status,
        403,
      );
      const old = ui;
      ui = (await data(
        await call("/api/desktop/webview-sessions", "POST", { origin: "tauri://localhost" }, desktop),
        201,
      )).accessToken;
      assertEquals(
        (await call("/api/me/session", "GET", undefined, old, undefined, "tauri://localhost")).status,
        401,
      );
    });
    await t.step("attendance snapshot keeps newest observation and remains account isolated", async () => {
      const now = Date.now(),
        snapshot = {
          attendanceDate: "2026-10-19",
          cohortId: "cohort-a",
          cohortStatus: "active",
          cohortStartDate: null,
          cohortEndDate: null,
          morningChecked: true,
          eveningChecked: false,
          collectedAt: new Date(now).toISOString(),
        };
      await data(await call("/api/desktop/attendance", "PUT", snapshot, desktop));
      const older = await data(
        await call("/api/desktop/attendance", "PUT", {
          ...snapshot,
          morningChecked: false,
          collectedAt: new Date(now - 10000).toISOString(),
        }, desktop),
      );
      assertEquals(older.attendance.morningChecked, true);
      const isolated = await data(
        await call("/api/me/attendance", "GET", undefined, otherUi, undefined, "tauri://localhost"),
      );
      assertEquals(isolated.attendance, null);
    });
    await t.step("pairing handoff retains two cookies, claim and approval are single-use", async () => {
      const pairing = await data(
        await call("/api/me/pairings", "POST", {}, ui, undefined, "tauri://localhost"),
        201,
      );
      pairingId = pairing.pairingId;
      const challenge = new URLSearchParams(new URL(pairing.qrPayload).hash.slice(1)).get("challenge");
      const handoff = await call(
        `/api/pairings/${pairingId}/handoff`,
        "POST",
        { challenge },
        undefined,
        undefined,
        config.publicBaseUrl,
      );
      assertEquals(handoff.status, 204);
      assert(handoff.headers.getSetCookie().length >= 2);
      const handoffCookie = cookieValue(handoff, "__Host-jb_pairing_handoff");
      const input = { installationId: "jbmi_" + "a".repeat(32), deviceLabel: "Fixture phone" };
      const claimed = await call(
        "/api/pairings/handoffs/claims",
        "POST",
        input,
        undefined,
        handoffCookie,
        config.publicBaseUrl,
      );
      await data(claimed, 201);
      const receipt = cookieValue(claimed, "__Host-jb_pending_claim");
      const repeated = await call(
        "/api/pairings/claims",
        "POST",
        { ...input, manualCode: pairing.manualCode },
        undefined,
        undefined,
        config.publicBaseUrl,
      );
      assertEquals(repeated.status, 409);
      assertEquals(
        (await call(
          `/api/me/pairings/${pairingId}`,
          "GET",
          undefined,
          otherUi,
          undefined,
          "tauri://localhost",
        )).status,
        404,
      );
      const approvals = await Promise.all(
        [0, 1].map(() =>
          call(
            `/api/me/pairings/${pairingId}/approve`,
            "POST",
            { claimId: pairingId },
            ui,
            undefined,
            "tauri://localhost",
          )
        ),
      );
      assertEquals(approvals.map((r) => r.status).sort(), [204, 409]);
      assertEquals(Number((await db`SELECT count(*) n FROM jb.app_session WHERE kind='mobile'`)[0].n), 1);
      const complete = await call(
        `/api/pairings/${pairingId}/complete`,
        "POST",
        {},
        undefined,
        receipt,
        config.publicBaseUrl,
      );
      assertEquals(complete.status, 204);
      mobileCookie = cookieValue(complete, "__Host-jb_device");
      assertEquals((await call("/api/me/session", "GET", undefined, undefined, mobileCookie)).status, 200);
      assertEquals(
        (await call("/api/me/mobile-sessions", "GET", undefined, undefined, mobileCookie)).status,
        403,
      );
      assertEquals(
        (await call(
          `/api/pairings/${pairingId}/complete`,
          "POST",
          {},
          undefined,
          "__Host-jb_pending_claim=jbcr_" + "b".repeat(64),
          config.publicBaseUrl,
        )).status,
        401,
      );
    });
    await t.step("personal preferences and laundry watch ownership", async () => {
      const prefs = {
        enabled: true,
        morning: false,
        evening: true,
        morningStartHour: 8,
        eveningEndHour: 3,
        morningIntervalMinutes: 10,
        eveningIntervalMinutes: 5,
        skipSunday: true,
        skipAttendanceDate: "2026-10-20",
      };
      assertEquals(
        await data(
          await call("/api/me/attendance/preferences", "PUT", prefs, ui, undefined, "tauri://localhost"),
        ),
        prefs,
      );
      assertEquals(
        await data(await call("/api/me/attendance/preferences", "GET", undefined, undefined, mobileCookie)),
        prefs,
      );
      const watch = await data(
        await call(
          "/api/me/laundry-watches",
          "POST",
          {
            machineId: "machine-a",
            appliance: "washer",
            sessionId: "session-a",
            notificationMode: "confirmed-completion",
            notifyBeforeMinutes: 0,
          },
          ui,
          undefined,
          "tauri://localhost",
        ),
        201,
      );
      assertEquals(
        (await call(
          `/api/me/laundry-watches/${watch.id}`,
          "DELETE",
          undefined,
          otherUi,
          undefined,
          "tauri://localhost",
        )).status,
        404,
      );
      assertEquals(
        (await call(
          `/api/me/laundry-watches/${watch.id}`,
          "DELETE",
          undefined,
          ui,
          undefined,
          "tauri://localhost",
        )).status,
        204,
      );
    });
    await t.step("usage gate, duplicate daily event, opt-out, aggregate and retention", async () => {
      assertEquals((await call("/api/me/usage/ui-opened", "POST", undefined, desktop)).status, 204);
      assertEquals((await db`SELECT 1 FROM jb.usage_user_day`).length, 0);
      await data(await call("/api/desktop/usage-preference", "PUT", { enabled: true }, desktop));
      for (let i = 0; i < 2; i++) {
        assertEquals((await call("/api/me/usage/ui-opened", "POST", undefined, desktop)).status, 204);
      }
      assertEquals((await db`SELECT 1 FROM jb.usage_user_day`).length, 1);
      const anon = await call(
        "/api/public/usage/ui-opened",
        "POST",
        { client: "web" },
        undefined,
        "__Host-jb_usage_opt_out=1",
        config.publicBaseUrl,
      );
      assertEquals(anon.status, 204);
      assertEquals(anon.headers.getSetCookie().length, 0);
      assertEquals((await db`SELECT 1 FROM jb.usage_anonymous_day`).length, 0);
      const opted = await call(
        "/api/public/usage-preference",
        "PUT",
        { enabled: false },
        undefined,
        undefined,
        config.publicBaseUrl,
      );
      assertEquals(opted.status, 200);
      assert(opted.headers.getSetCookie().length >= 2);
      await db`SELECT jb.aggregate_usage(true)`;
      assertEquals(
        Number(
          (await db`SELECT unique_subjects FROM jb.usage_daily_summary WHERE client='all' AND audience='authenticated' AND metric_kind='activity'`)[
            0
          ].unique_subjects,
        ),
        1,
      );
      await db`INSERT INTO jb.usage_anonymous_day VALUES ('2000-01-01',${"a".repeat(64)},'web','ui_opened')`;
      await db`DELETE FROM jb.maintenance_state WHERE name='usage-daily-summary-v1:lease'`;
      await db`SELECT jb.aggregate_usage(false)`;
      assertEquals((await db`SELECT 1 FROM jb.usage_anonymous_day WHERE usage_date='2000-01-01'`).length, 0);
    });
    await t.step("rotate invalidates UI and desktop credentials, revoke and expiry deny mobile", async () => {
      const old = desktop;
      desktop =
        (await data(await call("/api/desktop/installations/rotate", "POST", {}, desktop))).accessToken;
      assertEquals((await call("/api/desktop/attendance", "GET", undefined, old)).status, 401);
      assertEquals(
        (await call("/api/me/session", "GET", undefined, ui, undefined, "tauri://localhost")).status,
        401,
      );
      ui = (await data(
        await call("/api/desktop/webview-sessions", "POST", { origin: "tauri://localhost" }, desktop),
        201,
      )).accessToken;
      const sessions = await data(
        await call("/api/me/mobile-sessions", "GET", undefined, ui, undefined, "tauri://localhost"),
      );
      assertEquals(
        (await call(
          `/api/me/mobile-sessions/${sessions.devices[0].deviceId}`,
          "DELETE",
          undefined,
          ui,
          undefined,
          "tauri://localhost",
        )).status,
        204,
      );
      assertEquals((await call("/api/me/session", "GET", undefined, undefined, mobileCookie)).status, 401);
      const expired = await data(
        await call("/api/me/pairings", "POST", {}, ui, undefined, "tauri://localhost"),
        201,
      );
      await db`UPDATE jb.pairing_challenge SET created_at_epoch_ms=${
        Date.now() - 120000
      },expires_at_epoch_ms=${Date.now() - 60000} WHERE id=${expired.pairingId.slice(4)}`;
      assertEquals(
        (await call(
          "/api/pairings/claims",
          "POST",
          {
            manualCode: expired.manualCode,
            installationId: "jbmi_" + "c".repeat(32),
            deviceLabel: "Expired",
          },
          undefined,
          undefined,
          config.publicBaseUrl,
        )).status,
        410,
      );
    });
    await t.step("account deletion cascades credentials and personal state only for owner", async () => {
      assertEquals(
        (await call("/api/desktop/installations/current", "DELETE", undefined, desktop)).status,
        204,
      );
      assertEquals((await call("/api/desktop/attendance", "GET", undefined, desktop)).status, 401);
      assertEquals((await call("/api/desktop/attendance", "GET", undefined, other)).status, 200);
      assertEquals((await db`SELECT 1 FROM jb.app_user`).length, 1);
      assertEquals((await db`SELECT 1 FROM jb.attendance_snapshot`).length, 0);
      assertEquals((await db`SELECT 1 FROM jb.laundry_watch`).length, 0);
    });
  } finally {
    await store.close();
  }
});
