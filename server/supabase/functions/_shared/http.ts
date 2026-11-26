export class ApiError extends Error {
  constructor(public code: string, public status = 400, public headers?: Headers) {
    super(code);
  }
}
export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: h });
}
export function noContent(headers?: HeadersInit): Response {
  return new Response(null, { status: 204, headers });
}
export function check(condition: unknown, code = "INVALID_REQUEST", status = 400): asserts condition {
  if (!condition) throw new ApiError(code, status);
}
export async function body(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  check(
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json",
    "INVALID_REQUEST",
    415,
  );
  // Read a bounded stream, even when Content-Length is absent or dishonest.
  const reader = req.body?.getReader();
  check(reader);
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new ApiError("INVALID_REQUEST", 413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  let result;
  try {
    result = JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new ApiError("INVALID_REQUEST");
  }
  check(result && typeof result === "object" && !Array.isArray(result));
  check(Object.keys(result).every((key) => keys.includes(key)));
  return result;
}
export function string(value: unknown, min = 1, max = 256, pattern?: RegExp): string {
  check(
    typeof value === "string" && value.length >= min && value.length <= max &&
      (!pattern || pattern.test(value)),
  );
  return value;
}
export function boolean(value: unknown): boolean {
  check(typeof value === "boolean");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  check(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
  return value;
}
export function date(value: unknown): string {
  const v = string(value, 10, 10, /^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(v + "T00:00:00.000Z");
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v);
  return v;
}
export function instant(value: unknown): number {
  const v = string(value, 20, 35, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
  date(v.slice(0, 10));
  const ms = Date.parse(v);
  check(Number.isFinite(ms));
  return ms;
}
export function id(value: string, prefix: string): string {
  check(value.startsWith(prefix));
  return string(
    value.slice(prefix.length),
    36,
    36,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
}
export const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
export function cookies(req: Request): Map<string, string> {
  return new Map(
    (req.headers.get("cookie") ?? "").split(";").map((part) => {
      const pos = part.indexOf("=");
      return [pos < 0 ? "" : part.slice(0, pos).trim(), part.slice(pos + 1).trim()] as [string, string];
    }).filter(([name]) => name),
  );
}
export function cookie(req: Request, name: string): string | undefined {
  const c = cookies(req);
  return c.get(`__Host-${name}`) ?? c.get(name);
}
export function setCookie(
  headers: Headers,
  name: string,
  value: string,
  seconds: number,
  secure = true,
): void {
  headers.append(
    "Set-Cookie",
    `${secure ? "__Host-" : ""}${name}=${value}; Path=/; Max-Age=${
      Math.max(0, Math.floor(seconds))
    }; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
  );
}
export function clearCookies(headers: Headers, name: string, secure = true): void {
  setCookie(headers, name, "", 0, false);
  if (secure) setCookie(headers, name, "", 0, true);
}
/** Gateway keeps the function name in its path; the canonical route always begins /api/. */
export function normalizePath(path: string): string {
  if (path.startsWith("/functions/v1/api/")) return path.slice("/functions/v1/api".length);
  if (path.startsWith("/api/api/")) return path.slice("/api".length);
  return path;
}
