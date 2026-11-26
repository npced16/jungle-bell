import postgres from "postgres";
import type { Db } from "../../functions/_shared/db.ts";

/** Actual PostgreSQL SQL execution; PGlite is opt-in and is not multi-connection race evidence. */
export async function createTestDatabase(): Promise<{ db: Db; close(): Promise<void> }> {
  const url = Deno.env.get("JB_TEST_DATABASE_URL");
  const migrations = [];
  for await (const file of Deno.readDir(new URL("../../migrations/", import.meta.url))) {
    if (file.name.endsWith(".sql")) migrations.push(file.name);
  }
  migrations.sort();
  const ddl = await Promise.all(
    migrations.map((name) => Deno.readTextFile(new URL(`../../migrations/${name}`, import.meta.url))),
  );
  const roles =
    "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;";
  if (url) {
    const parsed = new URL(url);
    if (
      parsed.pathname !== "/jungle_bell_test" ||
      !["localhost", "127.0.0.1", "postgres"].includes(parsed.hostname)
    ) {
      throw new Error("Integration tests require a dedicated local jungle_bell_test database");
    }
    const db = postgres(url, { max: 5, prepare: false, idle_timeout: 1 });
    await db.unsafe("DROP SCHEMA IF EXISTS jb CASCADE");
    await db.unsafe(roles).simple();
    for (const migration of ddl) await db.unsafe(migration).simple();
    return { db, close: () => db.end({ timeout: 1 }) };
  }
  if (Deno.env.get("JB_TEST_PGLITE") !== "true") {
    throw new Error(
      "Set JB_TEST_DATABASE_URL for PostgreSQL integration, or explicitly JB_TEST_PGLITE=true for WASM SQL verification",
    );
  }
  const { PGlite } = await import("npm:@electric-sql/pglite@0.5.10");
  const pg = await PGlite.create();
  await pg.exec(roles);
  for (const migration of ddl) await pg.exec(migration);
  type Executor = Pick<typeof pg, "query"> & { transaction?: typeof pg.transaction };
  type Fragment = { sql: string; params: unknown[] };
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  function adapter(executor: Executor): Db {
    const tagged = (parts: TemplateStringsArray | string | Record<string, unknown>, ...values: unknown[]) => {
      if (typeof parts === "string") {
        if (values.length) {
          throw new Error("Unsupported Postgres.js Builder: string with additional arguments");
        }
        return { sql: parts.split(".").map(quote).join("."), params: [] };
      }
      if (!Array.isArray(parts) || !("raw" in parts)) {
        const row = parts as Record<string, unknown>, names = values as string[];
        return {
          sql: `(${names.map(quote).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
          params: names.map((name) => row[name]),
        };
      }
      let sql = parts[0];
      const params: unknown[] = [];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value && typeof value === "object" && "sql" in value && "params" in value) {
          const fragment = value as Fragment, offset = params.length;
          sql += fragment.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
          params.push(...fragment.params);
        } else {
          params.push(value);
          sql += `$${params.length}`;
        }
        sql += parts[i + 1];
      }
      return executor.query(sql, params).then((result) =>
        Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length })
      );
    };
    return Object.assign(tagged, {
      begin: <T>(
        optionsOrOperation: string | ((tx: Db) => Promise<T>),
        callback?: (tx: Db) => Promise<T>,
      ) => {
        if (!executor.transaction) throw new Error("Nested test transaction is unsupported");
        const operation = typeof optionsOrOperation === "string" ? callback! : optionsOrOperation;
        return executor.transaction((tx) => operation(adapter(tx)));
      },
      json: (value: unknown) => JSON.stringify(value),
      array: (value: unknown) => value,
      unsafe: (sql: string, values: unknown[] = []) => {
        const result = executor.query(sql, values).then((r) => r.rows);
        return Object.assign(result, {
          cursor: async (size: number, callback: (rows: unknown[]) => Promise<void>) => {
            const rows = await result;
            for (let i = 0; i < rows.length; i += size) await callback(rows.slice(i, i + size));
          },
        });
      },
    }) as unknown as Db;
  }
  return { db: adapter(pg), close: () => pg.close() };
}
