import { assertEquals } from "@std/assert";
import { createTestDatabase } from "../support/database.ts";
import { config } from "../support/config.ts";
import { collectMeals } from "../../functions/_shared/meal-normalizer.ts";
import { handlePublic } from "../../functions/_shared/public-data.ts";

Deno.test("meal collection preserves all images and body, classifies headings and deduplicates repeats", async () => {
  const { db, close } = await createTestDatabase(), originalFetch = globalThis.fetch;
  const now = Date.parse("2026-10-19T09:00:00Z"), bytes = new Uint8Array([1, 2, 3, 4]);
  const posts = [
    { id: "weekly", title: "주간 식단표", pinned: false, contents: [] },
    { id: "lunch", title: null, pinned: false, contents: [{ t: "text", v: "10월 19일 중식 메뉴\n밥, 국" }] },
    { id: "dinner", title: "10월 19일 석식 메뉴", pinned: false, contents: [{ t: "text", v: "카레" }] },
    {
      id: "notice",
      title: "굿즈 판매 공지",
      pinned: true,
      contents: [{ t: "text", v: "중식 메뉴와 무관한 공지" }],
    },
  ].map((post) => ({
    ...post,
    published_at: now,
    permalink: `http://pf.kakao.com/_xhzNjn/${post.id}`,
    media: [1, 2].map((i) => ({ id: String(i), type: "image", url: `https://source.invalid/image-${i}` })),
  }));
  let imageReads = 0;
  try {
    globalThis.fetch = ((url: RequestInfo | URL) => {
      if (String(url).includes("/image-")) {
        imageReads++;
        return Promise.resolve(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
      }
      return Promise.resolve(Response.json({ items: posts }));
    }) as typeof fetch;
    const cfg = {
      ...config,
      collectorsEnabled: true,
      mealsPinnedSourceUrl: "https://source.invalid/posts",
      mealsDefaultSourceUrl: "",
    };
    for (let i = 0; i < 8; i++) await collectMeals(db, cfg);
    assertEquals(imageReads, 8); // Second collection reuses every cached image.
    const [counts] =
      await db`select (select count(*)::int from jb.meal_post) posts,(select count(*)::int from jb.meal_image) images,(select count(*)::int from jb.meal_asset) assets`;
    assertEquals(counts, { posts: 4, images: 8, assets: 1 });
    const response = await handlePublic(
      new Request("https://test/api/public/meals"),
      "/api/public/meals",
      db,
      cfg,
    );
    const { data } = await response!.json();
    assertEquals(data.weeklyPosts.map((p: { id: string }) => p.id), ["weekly"]);
    assertEquals(data.otherPosts.map((p: { id: string }) => p.id), ["notice"]);
    assertEquals(data.pinnedMenus.length, 0);
    const lunch = data.dailyMenus.find((p: { id: string }) => p.id === "lunch");
    assertEquals(lunch.title, null);
    assertEquals(lunch.text, "10월 19일 중식 메뉴\n밥, 국");
    assertEquals(lunch.mealDate, "2026-10-19");
    assertEquals(lunch.mealPeriod, "LUNCH");
    assertEquals(lunch.permalink, "https://pf.kakao.com/_xhzNjn/lunch");
    for (const post of [...data.dailyMenus, ...data.weeklyPosts, ...data.otherPosts]) {
      assertEquals(post.images.length, 2);
      for (const image of post.images) {
        const path = new URL(image.url).pathname;
        const asset = await handlePublic(new Request(image.url), path, db, cfg);
        assertEquals(asset!.status, 200);
        assertEquals(new Uint8Array(await asset!.arrayBuffer()), bytes);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    await close();
  }
});
