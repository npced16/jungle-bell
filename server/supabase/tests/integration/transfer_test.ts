import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../support/database.ts";
import { TABLES, transfer } from "../../operations/transfer-data.ts";
import { sha256 } from "../../functions/_shared/crypto.ts";

Deno.test("allowlist transfer preserves JSON/BYTEA and refuses an occupied destination", async () => {
  const source = await createTestDatabase(), destination = await createTestDatabase();
  try {
    // Only the dedicated local test database is touched. public clones are synthetic legacy fixtures.
    for (const table of TABLES) {
      await source.db.unsafe(`DROP TABLE IF EXISTS public.${table} CASCADE`);
      await source.db.unsafe(`CREATE TABLE public.${table} (LIKE jb.${table} INCLUDING ALL)`);
    }
    const user = "00000000-0000-0000-0000-000000000012", bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const hash = await sha256(bytes);
    await source.db`INSERT INTO public.app_user VALUES (${user},12345)`;
    await source.db`INSERT INTO public.meal_asset VALUES (${hash},'image/png','png',6,${bytes})`;
    await source.db`INSERT INTO public.laundry_version VALUES (${"a".repeat(64)},${
      source.db.json({ schemaVersion: 2, test: "fixture" })
    },now(),now())`;
    await source
      .db`INSERT INTO public.maintenance_state VALUES ('collector:meals-default:cursor',123,'ephemeral')`;
    const counts = await transfer(source.db, destination.db);
    assertEquals(Object.keys(counts).length, 28);
    assertEquals(counts.app_user, 1);
    assertEquals(counts.meal_asset, 1);
    assertEquals((await destination.db`SELECT normalized FROM jb.laundry_version`)[0].normalized, {
      schemaVersion: 2,
      test: "fixture",
    });
    assertEquals(await sha256((await destination.db`SELECT content FROM jb.meal_asset`)[0].content), hash);
    assertEquals(
      (await destination.db`SELECT 1 FROM jb.maintenance_state WHERE name LIKE '%:cursor'`).length,
      0,
    );
    await assertRejects(() => transfer(source.db, destination.db), Error, "Destination table must be empty");
    assertEquals((await destination.db`SELECT 1 FROM jb.app_user`).length, 1);
  } finally {
    await source.close();
    await destination.close();
  }
});
