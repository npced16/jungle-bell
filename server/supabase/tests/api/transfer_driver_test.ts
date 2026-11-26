import { assertEquals, assertThrows } from "@std/assert";
import postgres from "postgres";
import { destinationTable, TABLES } from "../../operations/transfer-data.ts";

Deno.test("transfer uses actual postgres.js identifiers and INSERT builder serialization", async () => {
  const sql = postgres(); // Lazy driver: no database connection or query execution.
  type Builder = { build(prefix: string, parameters: unknown[], types: unknown[], options: unknown): string };
  try {
    for (const table of TABLES) {
      const identifier = destinationTable(sql as unknown as postgres.TransactionSql, table);
      assertEquals((identifier as unknown as { value: string }).value, `"jb"."${table}"`);
    }
    const prefix = `INSERT INTO ${
      (destinationTable(sql as unknown as postgres.TransactionSql, "app_user") as unknown as {
        value: string;
      }).value
    } `;
    const parameters: unknown[] = [];
    const builder = sql({ id: "synthetic-user" }, "id") as unknown as Builder;
    assertEquals(
      prefix + builder.build(prefix, parameters, [], sql.options),
      'INSERT INTO "jb"."app_user" ("id")values($1)',
    );
    assertEquals(parameters, ["synthetic-user"]);
    // The previously accepted adapter call is invalid in the real pinned driver.
    assertThrows(() =>
      (sql("jb", "app_user") as unknown as Builder).build("INSERT INTO ", [], [], sql.options)
    );
  } finally {
    await sql.end();
  }
});
