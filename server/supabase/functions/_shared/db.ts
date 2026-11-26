import postgres from "postgres";

export type Db = postgres.Sql;
let db: Db | undefined;

/** All queries qualify jb tables: transaction poolers cannot preserve session search_path. */
export function getDb(): Db {
  const url = Deno.env.get("JB_DATABASE_URL") || Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("A server database connection is required");
  return db ??= postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
}

export async function transaction<T>(sql: Db, operation: (tx: Db) => Promise<T>): Promise<T> {
  return await sql.begin((tx) => operation(tx as unknown as Db)) as T;
}
