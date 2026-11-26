import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../support/database.ts";
import { config } from "../support/config.ts";
import { collectLaundry, handlePublic, latestLaundry } from "../../functions/_shared/public-data.ts";
import { collectMeals } from "../../functions/_shared/meal-normalizer.ts";
import { createNotification, handleNotifications } from "../../functions/_shared/notifications.ts";
import { automate, housekeeping } from "../../functions/_shared/automation.ts";
import { push } from "../../functions/_shared/push.ts";
import { createECDH, randomBytes } from "node:crypto";
// @deno-types="npm:@types/web-push@3.6.4"
import webPush from "npm:web-push@3.6.7";
Deno.test("worker PostgreSQL SQL contracts, collectors, notification fanout and settlement", async (t) => {
  const { db, close } = await createTestDatabase(), originalFetch = globalThis.fetch;
  const user = crypto.randomUUID(),
    desktop = crypto.randomUUID(),
    mobile = crypto.randomUUID(),
    now = Date.now(),
    installation = "desktop-worker-test";
  const p = { userId: user, sessionId: desktop, installationId: installation, kind: "desktop" as const };
  try {
    await db`insert into jb.app_user(id,created_at_epoch_ms) values(${user},${now})`;
    await db`insert into jb.desktop_device(installation_id,user_id,created_at_epoch_ms,lms_session_state) values(${installation},${user},${now},'connected')`;
    for (const [id, kind, token] of [[desktop, "desktop", "a"], [mobile, "mobile", "b"]]) {
      await db`insert into jb.app_session(id,user_id,installation_id,kind,label,token_sha256,created_at_epoch_ms,expires_at_epoch_ms,last_seen_at_epoch_ms) values(${id},${user},${
        kind === "desktop" ? installation : "mobile-worker-test"
      },${kind},'Test',${token.repeat(64)},${now},${now + 86400000},${now})`;
    }
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const vapid = webPush.generateVAPIDKeys(),
      pushConfig = {
        ...config,
        vapidPublicKey: vapid.publicKey,
        vapidPrivateKey: vapid.privateKey,
        vapidSubject: "mailto:ops@example.com",
      };
    await db`insert into jb.push_subscription(id,user_id,session_id,endpoint,p256dh,auth,created_at_epoch_ms) values('push-test',${user},${mobile},'https://fcm.googleapis.com/fcm/send/test',${
      receiver.getPublicKey().toString("base64url")
    },${randomBytes(16).toString("base64url")},${now})`;
    await t.step("fanout is atomic and duplicate source events create no additional deliveries", async () => {
      const n = {
        id: crypto.randomUUID(),
        userId: user,
        sourceEventId: "test-fanout",
        kind: "test",
        title: "Title",
        body: "Body",
        path: "/#/notifications",
        payload: {},
        createdAtEpochMs: now,
        dueAtEpochMs: now,
        expiresAtEpochMs: now + 600000,
      };
      assert(await createNotification(db, n));
      assertEquals(await createNotification(db, { ...n, id: crypto.randomUUID() }), false);
      const [count] =
        await db`select count(*) count from jb.notification_delivery where notification_id=${n.id}`;
      assertEquals(Number(count.count), 2);
      const response = await handleNotifications(
        new Request("https://test/api/desktop/notifications"),
        "/api/desktop/notifications",
        db,
        config,
        p,
      );
      assertEquals((await response!.json()).notifications.length, 1);
      const ack = await handleNotifications(
        new Request("https://test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: "displayed", occurredAtEpochMs: now }),
        }),
        `/api/desktop/notifications/${n.id}/ack`,
        db,
        config,
        p,
      );
      assertEquals(ack?.status, 204);
    });
    await t.step(
      "source A-B-A keeps immutable A and updates current A, repeated hash preserves current observed time",
      async () => {
        let state = "RUNNING";
        globalThis.fetch = (() =>
          Promise.resolve(
            Response.json({
              "워시타워_1": { dryer: { runState: { currentState: state }, timer: { remainMinute: 10 } } },
            }),
          )) as typeof fetch;
        const cfg = {
          ...config,
          collectorsEnabled: true,
          laundrySourceUrl: "https://source.invalid/laundry",
        };
        await collectLaundry(db, cfg);
        const first = await latestLaundry(db);
        assert(first);
        state = "PAUSE";
        await collectLaundry(db, cfg);
        state = "RUNNING";
        await collectLaundry(db, cfg);
        const current = await latestLaundry(db);
        assertEquals(current?.sourceVersionSha, first.sourceVersionSha);
        const [immutable] =
          await db`select normalized from jb.laundry_version where sha=${first.sourceVersionSha}`;
        assertEquals(immutable.normalized, first);
        await collectLaundry(db, cfg);
        assertEquals((await latestLaundry(db))?.observedAt, current?.observedAt);
        const response = await handlePublic(
          new Request("https://test/api/public/laundry"),
          "/api/public/laundry",
          db,
          config,
        );
        assertEquals(response?.status, 200);
        assertEquals((await response!.json()).quality.collectorHealthy, true);
        globalThis.fetch = (() => Promise.resolve(Response.json({ "워시타워_1": null }))) as typeof fetch;
        await assertRejects(() => collectLaundry(db, cfg));
        assertEquals((await latestLaundry(db))?.sourceVersionSha, first.sourceVersionSha);
      },
    );
    await t.step("meal continuation pins source input and preserves full image bytes", async () => {
      const image = new Uint8Array(600000).fill(7);
      let sourceReads = 0;
      globalThis.fetch = ((url: RequestInfo | URL) => {
        if (String(url).includes("/image")) {
          return Promise.resolve(new Response(image, { headers: { "Content-Type": "image/png" } }));
        }
        sourceReads++;
        return Promise.resolve(
          Response.json({
            items: [{
              id: "week",
              title: "2026년 10월 3주차 식단표",
              pinned: true,
              media: [{ id: "m", url: "https://source.invalid/image", type: "image" }],
            }, {
              id: "daily",
              title: "10월 19일 중식 메뉴",
              published_at: now,
              contents: [{ t: "text", v: "메뉴" }],
            }],
          }),
        );
      }) as typeof fetch;
      const cfg = {
        ...config,
        collectorsEnabled: true,
        mealsPinnedSourceUrl: "https://source.invalid/meals",
      };
      await collectMeals(db, cfg);
      assertEquals(sourceReads, 1);
      await collectMeals(db, cfg);
      assertEquals(sourceReads, 1);
      const [asset] = await db`select byte_length,octet_length(content) actual from jb.meal_asset`;
      assertEquals(Number(asset.byte_length), 600000);
      assertEquals(Number(asset.actual), 600000);
      const r = await handlePublic(
          new Request("https://test/api/public/meals"),
          "/api/public/meals",
          db,
          config,
        ),
        body = await r!.json();
      assertEquals(body.data.dailyMenus[0].id, "daily");
      assertEquals(body.data.weeklyMenus[0].post.id, "week");
      const history = await handlePublic(
        new Request("https://test/api/public/meals/history?month=2026-10"),
        "/api/public/meals/history",
        db,
        config,
      );
      assertEquals(history?.status, 200);
      const fixtureOutput = Deno.env.get("JB_FIXTURE_OUTPUT");
      if (fixtureOutput) {
        const status = await handlePublic(
            new Request("https://test/api/public/status"),
            "/api/public/status",
            db,
            config,
          ),
          laundry = await handlePublic(
            new Request("https://test/api/public/laundry"),
            "/api/public/laundry",
            db,
            config,
          );
        await Deno.writeTextFile(
          fixtureOutput,
          JSON.stringify(
            { status: await status!.json(), laundry: await laundry!.json(), meals: body },
            null,
            2,
          ),
        );
      }
    });
    await t.step("poison meal snapshot retries are bounded and corrected upstream is refetched", async () => {
      let reads = 0, corrected = false;
      globalThis.fetch = ((url: RequestInfo | URL) => {
        if (String(url).includes("/broken-image")) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        reads++;
        return Promise.resolve(
          Response.json({
            items: [{
              id: "repaired",
              title: "복구",
              media: corrected
                ? []
                : [{ id: "bad", type: "image", url: "https://source.invalid/broken-image" }],
            }],
          }),
        );
      }) as typeof fetch;
      const cfg = {
        ...config,
        collectorsEnabled: true,
        mealsDefaultSourceUrl: "https://source.invalid/broken-meals",
      };
      await assertRejects(() => collectMeals(db, cfg));
      corrected = true;
      await assertRejects(() => collectMeals(db, cfg));
      await assertRejects(() => collectMeals(db, cfg));
      assertEquals(reads, 1);
      await collectMeals(db, cfg);
      assertEquals(reads, 2);
      const [state] = await db`select consecutive_failures from jb.source_state where source='meals-default'`;
      assertEquals(state.consecutive_failures, 0);
    });
    await t.step("inactive target is gone; HTTP410 revokes subscription and settles lease once", async () => {
      globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 410 }))) as typeof fetch;
      const result = await push(db, pushConfig);
      assertEquals(result.claimed, 1);
      const [delivery] =
        await db`select * from jb.notification_delivery where target_kind='push' and target_id='push-test'`;
      assertEquals(delivery.status, "gone");
      assertEquals(delivery.attempts, 1);
      assertEquals(delivery.lease_token, null);
      const [subscription] =
        await db`select revoked_at_epoch_ms from jb.push_subscription where id='push-test'`;
      assert(subscription.revoked_at_epoch_ms !== null);
      assertEquals((await push(db, pushConfig)).claimed, 0);
      await db`update jb.push_subscription set revoked_at_epoch_ms=null where id='push-test'`;
      const pendingId = crypto.randomUUID();
      await createNotification(db, {
        id: pendingId,
        userId: user,
        sourceEventId: "revoked-target",
        kind: "test",
        title: "t",
        body: "b",
        path: "/#/notifications",
        payload: {},
        createdAtEpochMs: now,
        dueAtEpochMs: now,
        expiresAtEpochMs: now + 600000,
      });
      await db`update jb.app_session set revoked_at_epoch_ms=${Date.now()} where id=${mobile}`;
      assertEquals((await push(db, pushConfig)).claimed, 0);
      const [inactive] =
        await db`select status,attempts from jb.notification_delivery where notification_id=${pendingId} and target_kind='push'`;
      assertEquals(inactive.status, "gone");
      assertEquals(inactive.attempts, 0);
    });
    await t.step("automation completes terminal watches and creates one durable notification", async () => {
      const v = await latestLaundry(db);
      assert(v);
      v.machines[0].dryer!.operationalStatus = "COMPLETED";
      v.machines[0].dryer!.state = { code: "END", raw: null, known: true };
      await db`update jb.laundry_current set normalized=${db.json(v as any)} where source='laundry'`;
      await db`insert into jb.laundry_watch(id,user_id,machine_id,appliance,session_id,notification_mode,notify_before_minutes,notify_when_available,status,created_at_epoch_ms,updated_at_epoch_ms) values('watch-test',${user},'워시타워_1','dryer',${
        v.machines[0].dryer!.sessionId
      },'confirmed-completion',0,true,'active',${now},${now})`;
      await automate(db);
      const [w] = await db`select status from jb.laundry_watch where id='watch-test'`;
      assertEquals(w.status, "completed");
      const [n] = await db`select count(*) count from jb.notification where kind='laundry-completed'`;
      assertEquals(Number(n.count), 1);
      await automate(db);
      const [again] = await db`select count(*) count from jb.notification where kind='laundry-completed'`;
      assertEquals(Number(again.count), 1);
      await housekeeping(db, now + 3600000);
    });
    await t.step(
      "later attendance pages use fresh clock, heartbeat and settings; independent stages restart each minute",
      async () => {
        const originalNow = Date.now, base = Date.parse("2026-08-20T08:30:00+09:00");
        let clock = base;
        Date.now = () => clock;
        const uid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
        try {
          await db`delete from jb.maintenance_state where name like 'automation:%'`;
          await db`insert into jb.app_user(id,created_at_epoch_ms) select ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,${base} from generate_series(1,151)i`;
          await db`insert into jb.attendance_preference(user_id,enabled,morning_enabled,evening_enabled,morning_start_hour,morning_interval_minutes,updated_at_epoch_ms) select id,true,true,false,8,1,${base} from jb.app_user where id::text like '00000000-%'`;
          await db`insert into jb.desktop_device(installation_id,user_id,created_at_epoch_ms,last_seen_at_epoch_ms,lms_session_state) select 'batch-'||id::text,id,${base},${base},'connected' from jb.app_user where id::text like '00000000-%'`;
          await db`insert into jb.attendance_snapshot(user_id,source_installation_id,attendance_date,cohort_status,morning_checked,evening_checked,collected_at_epoch_ms,received_at_epoch_ms) select id,'batch-'||id::text,'2026-08-20','active',false,false,${base},${base} from jb.app_user where id::text like '00000000-%'`;
          await automate(db);
          clock = base + 10000;
          await db`update jb.desktop_device set last_seen_at_epoch_ms=${clock} where user_id=${uid(26)}`;
          await db`update jb.attendance_snapshot set collected_at_epoch_ms=${clock} where user_id=${uid(26)}`;
          await db`update jb.attendance_preference set enabled=false,updated_at_epoch_ms=${clock} where user_id=${
            uid(27)
          }`;
          await automate(db);
          const [fresh] = await db`select payload from jb.notification where user_id=${uid(26)}`;
          assertEquals(fresh.payload.fallbackReason, null);
          for (let page = 2; page <= 6; page++) {
            clock = base + page * 10000;
            await automate(db);
          }
          const [late] = await db`select source_event_id from jb.notification where user_id=${uid(151)}`;
          assert(late);
          assert(late.source_event_id.endsWith(":0830"));
          const [disabled] = await db`select count(*) count from jb.notification where user_id=${uid(27)}`;
          assertEquals(Number(disabled.count), 0);
          // Seed a genuine continuation at the final user after a one-minute boundary.
          await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values('automation:attendance:cursor',${base},${
            JSON.stringify({ now: base, after: uid(150) })
          }) on conflict(name) do update set run_token=excluded.run_token`;
          clock = base + 70000;
          await automate(db);
          const [current] = await db`select count(*) count from jb.notification where user_id=${
            uid(151)
          } and source_event_id like '%:0831'`;
          assertEquals(Number(current.count), 1);
          await db`insert into jb.maintenance_state(name,last_run_at_epoch_ms,run_token) values('automation:meals:cursor',${clock},'{}') on conflict(name) do update set run_token=excluded.run_token`;
          clock = base + 120000;
          await automate(db);
          const [next] = await db`select count(*) count from jb.notification where user_id=${
            uid(1)
          } and source_event_id like '%:0832'`;
          assertEquals(Number(next.count), 1);
        } finally {
          Date.now = originalNow;
        }
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await close();
  }
});
