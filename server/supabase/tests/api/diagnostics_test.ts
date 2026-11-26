import { assertEquals, assertFalse } from "@std/assert";
import { createHandler } from "../../functions/api/handler.ts";
import type { Db } from "../../functions/_shared/db.ts";
import { config } from "../support/config.ts";

Deno.test("config diagnostics list names only and fail before database access", async () => {
  const names = ["PUBLIC_BASE_URL", "PAIRING_SECRET", "USAGE_HASH_SECRET", "JOB_SECRET"];
  const previous = names.map((name) => Deno.env.get(name));
  const logs: string[] = [];
  const original = console.error;
  let calls = 0;
  try {
    names.forEach((name) => Deno.env.delete(name));
    Deno.env.set("USAGE_HASH_SECRET", "sensitive-short-value");
    console.error = (value) => logs.push(String(value));
    const db = (() => {
      calls++;
      throw new Error("must not reach database");
    }) as unknown as Db;
    const response = await createHandler({ db })(new Request("https://example.com/api/public/status"));
    assertEquals(response.status, 500);
    assertEquals(await response.json(), { error: "INTERNAL_ERROR", issues: null });
    const event = JSON.parse(logs[0]);
    assertEquals(event.stage, "config");
    assertEquals(event.code, "INVALID_REQUIRED_SECRETS");
    assertEquals(event.missing, ["PAIRING_SECRET", "JOB_SECRET"]);
    assertEquals(event.invalid, ["USAGE_HASH_SECRET"]);
    assertFalse(logs.join().includes("sensitive-short-value"));
    assertEquals(calls, 0);
  } finally {
    console.error = original;
    names.forEach((name, i) =>
      previous[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, previous[i]!)
    );
  }
});

Deno.test("handler diagnostics never serialize raw database errors", async () => {
  const original = console.error, logs: string[] = [];
  try {
    console.error = (value) => logs.push(String(value));
    const db = (() => {
      throw new Error("postgres://private-password@private-host/session-token");
    }) as unknown as Db;
    const response = await createHandler({ db, config })(
      new Request("https://example.com/api/public/status"),
    );
    assertEquals(response.status, 500);
    const event = JSON.parse(logs[0]);
    assertEquals(event.stage, "handler");
    assertEquals(event.code, "UNEXPECTED_FAILURE");
    assertFalse(logs.join().includes("private-"));
    assertFalse(logs.join().includes("session-token"));
  } finally {
    console.error = original;
  }
});
