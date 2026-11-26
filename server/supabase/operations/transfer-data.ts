/** One-time, explicitly invoked offline copy. Never runs from an Edge Function or migration. */
import postgres from "postgres";
import { sha256 } from "../functions/_shared/crypto.ts";

// Parent tables precede children. Only application tables are copied, never auth/storage/public metadata.
export const TABLES = [
  "maintenance_state",
  "source_state",
  "laundry_version",
  "laundry_current",
  "minute_observation",
  "laundry_event",
  "meal_post",
  "meal_asset",
  "meal_image",
  "meal_weekly_menu",
  "app_user",
  "desktop_enrollment_attempt",
  "desktop_device",
  "app_session",
  "desktop_ui_session",
  "pairing_challenge",
  "attendance_snapshot",
  "attendance_preference",
  "meal_preference",
  "usage_preference",
  "laundry_watch",
  "notification",
  "push_subscription",
  "notification_delivery",
  "usage_user_day",
  "usage_feature_day",
  "usage_anonymous_day",
  "usage_daily_summary",
] as const;

export function destinationTable(sql: postgres.TransactionSql, table: typeof TABLES[number]) {
  // One dotted argument is an Identifier; multiple string arguments create a Builder.
  return sql(`jb.${table}`);
}

export async function transfer(source: postgres.Sql, target: postgres.Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // Source writes must already be paused. This snapshot excludes any writes after BEGIN.
  await source.begin("isolation level repeatable read read only", async (read) => {
    await target.begin(async (write) => {
      // Never overwrite an already-used destination. Run the smoke tests against another project/database.
      for (const table of TABLES) {
        const [row] = await write.unsafe(`SELECT count(*) AS n FROM jb.${table}`);
        if (Number(row.n) !== 0) throw new Error(`Destination table must be empty: ${table}`);
      }
      for (const table of TABLES) {
        const columns = await read`SELECT column_name,udt_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`;
        const targetColumns = await write`SELECT column_name,udt_name FROM information_schema.columns
          WHERE table_schema='jb' AND table_name=${table} ORDER BY ordinal_position`;
        if (!columns.length || JSON.stringify(columns) !== JSON.stringify(targetColumns)) {
          throw new Error(`Source/destination schema differs: ${table}`);
        }
        const names = columns.map((c) => String(c.column_name));
        if (names.some((name) => !/^[a-z_][a-z0-9_]*$/.test(name))) throw new Error("Unexpected column name");
        const jsonColumns = new Set(
          columns.filter((c) => ["json", "jsonb"].includes(c.udt_name)).map((c) => c.column_name),
        );
        counts[table] = 0;
        // BYTEA images can reach 10 MiB, so copy asset rows one at a time.
        await read.unsafe(`SELECT * FROM public.${table}`).cursor(
          table === "meal_asset" ? 1 : 100,
          async (rows) => {
            for (const row of rows) {
              if (table === "meal_asset" && await sha256(row.content) !== row.sha) {
                throw new Error("Source image SHA mismatch");
              }
              const prepared = Object.fromEntries(
                names.map((name) => [name, jsonColumns.has(name) ? write.json(row[name]) : row[name]]),
              );
              await write`INSERT INTO ${destinationTable(write, table)} ${write(prepared, ...names)}`;
              counts[table]++;
            }
          },
        );
        const [result] = await write.unsafe(`SELECT count(*) AS n FROM jb.${table}`);
        if (Number(result.n) !== counts[table]) throw new Error(`Copy count mismatch: ${table}`);
      }
      // Lease/cursor state is ephemeral process state. Preserve historical success markers, release owners.
      await write`DELETE FROM jb.maintenance_state WHERE name LIKE '%:lease' OR name LIKE '%:cursor'
        OR name IN ('minute-automation','hourly-housekeeping','usage-daily-summary-v1')`;
      await write`UPDATE jb.notification_delivery SET lease_token=NULL,lease_expires_at_epoch_ms=NULL
        WHERE target_kind='push' AND status IN ('pending','retry')`;
    });
  });
  return counts;
}

if (import.meta.main) {
  if (!Deno.args.includes("--confirm-source-writers-paused")) {
    throw new Error("Pause old writers and pass --confirm-source-writers-paused");
  }
  const sourceUrl = Deno.env.get("JB_SOURCE_DATABASE_URL"),
    targetUrl = Deno.env.get("JB_TARGET_DATABASE_URL");
  if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) {
    throw new Error("Distinct source and target database environment variables are required");
  }
  const source = postgres(sourceUrl, { max: 1, prepare: false }),
    target = postgres(targetUrl, { max: 1, prepare: false });
  try {
    const counts = await transfer(source, target);
    console.log(
      JSON.stringify({
        status: "copied",
        sourceRows: counts,
        notice: "ephemeral leases/cursors were released; run independent destination checks before cutover",
      }),
    );
  } catch {
    // Driver errors may contain private row values or connection details. Keep raw errors out of terminals.
    console.error(
      "Data copy failed; destination transaction rolled back. Check private database diagnostics.",
    );
    Deno.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}
