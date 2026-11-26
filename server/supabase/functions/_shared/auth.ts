import type { Db } from "./db.ts";
import type { Principal } from "./types.ts";
import { type Config, DESKTOP_ORIGINS } from "./config.ts";
import { sessionHash, uiSessionHash } from "./crypto.ts";
import { ApiError, cookie } from "./http.ts";

export function requiresAuth(path: string, method: string): boolean {
  return !(path === "/api/desktop/installations" && method === "POST") &&
    (path.startsWith("/api/desktop/") || path.startsWith("/api/me/"));
}
export async function authenticate(
  req: Request,
  db: Db,
  path: string,
  now = Date.now(),
): Promise<Principal | null> {
  if (!requiresAuth(path, req.method)) return null;
  const header = req.headers.get("Authorization");
  let token: string | undefined;
  if (header !== null) {
    const match = /^Bearer (\S+)$/i.exec(header);
    if (!match) throw new ApiError("AUTHENTICATION_REQUIRED", 401);
    token = match[1];
  } else if (path.startsWith("/api/me/")) token = cookie(req, "jb_device");
  if (!token) throw new ApiError("AUTHENTICATION_REQUIRED", 401);
  if (/^jbui_[a-f0-9]{64}$/.test(token)) {
    const hash = await uiSessionHash(token);
    const [row] = await db`SELECT ui.parent_session_id AS id, ui.user_id, ui.installation_id, ui.origin
      FROM jb.desktop_ui_session ui JOIN jb.app_session p ON p.id=ui.parent_session_id
      JOIN jb.desktop_device d ON d.installation_id=ui.installation_id
      WHERE ui.token_sha256=${hash} AND ui.scope='desktop-ui-v1' AND ui.expires_at_epoch_ms>${now}
        AND p.revoked_at_epoch_ms IS NULL AND p.expires_at_epoch_ms>${now} AND p.kind='desktop'
        AND p.user_id=ui.user_id AND p.installation_id=ui.installation_id AND d.user_id=ui.user_id`;
    if (row) {
      return {
        sessionId: row.id,
        userId: row.user_id,
        installationId: row.installation_id,
        kind: "desktop-ui",
        origin: row.origin,
      };
    }
  } else if (/^jb[ds]_[a-f0-9]{64}$/.test(token)) {
    const hash = await sessionHash(token);
    const kind = token.startsWith("jbd_") ? "desktop" : "mobile";
    const [row] = await db`SELECT s.* FROM jb.app_session s WHERE s.token_sha256=${hash}
      AND s.kind=${kind} AND s.revoked_at_epoch_ms IS NULL AND s.expires_at_epoch_ms>${now}
      AND (s.kind<>'desktop' OR EXISTS (SELECT 1 FROM jb.desktop_device d WHERE d.installation_id=s.installation_id AND d.user_id=s.user_id))`;
    if (row) {
      if (Number(row.last_seen_at_epoch_ms) <= now - 60000) {
        await db`UPDATE jb.app_session SET last_seen_at_epoch_ms=${now} WHERE id=${row.id}
          AND revoked_at_epoch_ms IS NULL AND expires_at_epoch_ms>${now} AND last_seen_at_epoch_ms<=${
          now - 60000
        }`;
      }
      return { sessionId: row.id, userId: row.user_id, installationId: row.installation_id, kind };
    }
  }
  throw new ApiError("AUTHENTICATION_REQUIRED", 401);
}

export function authorize(req: Request, path: string, p: Principal | null): void {
  if (!requiresAuth(path, req.method)) return;
  if (!p) throw new ApiError("AUTHENTICATION_REQUIRED", 401);
  if (path.startsWith("/api/desktop/")) {
    if (p.kind !== "desktop") throw new ApiError("SESSION_KIND_DENIED", 403);
    return;
  }
  if (
    p.kind === "desktop-ui" &&
    (req.headers.get("origin") !== p.origin || !DESKTOP_ORIGINS.includes(p.origin!))
  ) {
    throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
  }
  if (path === "/api/me/usage/ui-opened" && req.method === "POST") {
    if (p.kind === "desktop-ui") throw new ApiError("SESSION_KIND_DENIED", 403);
    return;
  }
  if (path === "/api/me/usage-preference" && req.method === "PUT") {
    throw new ApiError("SESSION_KIND_DENIED", 403);
  }
  if (/^\/api\/me\/(mobile-sessions|pairings)(\/|$)/.test(path)) {
    if (p.kind === "mobile") throw new ApiError("DESKTOP_CAPABILITY_REQUIRED", 403);
    if (p.kind !== "desktop-ui") throw new ApiError("SESSION_KIND_DENIED", 403);
  } else if (p.kind === "desktop") throw new ApiError("SESSION_KIND_DENIED", 403);
}

/** Cookie writes are first party. Exact Origin prevents CSRF even on same-site sibling domains. */
export function checkRequestOrigin(req: Request, path: string, config: Config): void {
  const origin = req.headers.get("origin");
  const desktopCors = (path.startsWith("/api/me/") || path.startsWith("/api/public/")) &&
    origin !== null && DESKTOP_ORIGINS.includes(origin);
  if (origin && origin !== config.publicBaseUrl && !desktopCors) {
    throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
  }
  const writes = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const cookieWrite = writes && (path.startsWith("/api/pairings/") ||
    path.startsWith("/api/public/usage") ||
    (path.startsWith("/api/me/") && !req.headers.has("authorization")));
  if (cookieWrite && origin !== config.publicBaseUrl) throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
  if (cookieWrite && req.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
  }
}
