import { getDb } from "../_shared/db.ts";
import { getConfig } from "../_shared/config.ts";
import { push } from "../_shared/push.ts";
import { timingSafeEqual } from "node:crypto";
export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const config = getConfig(),
      expected = new TextEncoder().encode(config.jobSecret),
      actual = new TextEncoder().encode(req.headers.get("x-job-secret") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return new Response(null, { status: 401 });
    }
    const result = await push(getDb(), config);
    return Response.json(result);
  } catch {
    return Response.json({ error: "JOB_FAILED" }, { status: 500 });
  }
}
if (import.meta.main) Deno.serve(handler);
