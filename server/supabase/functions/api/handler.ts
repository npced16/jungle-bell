import { type Db, getDb } from "../_shared/db.ts";
import { type Config, ConfigurationError, DESKTOP_ORIGINS, getConfig } from "../_shared/config.ts";
import { authenticate, authorize, checkRequestOrigin } from "../_shared/auth.ts";
import { handleAccount } from "../_shared/account.ts";
import { handlePairing } from "../_shared/pairing.ts";
import { handlePersonal } from "../_shared/personal.ts";
import { handleUsage, recordFeature } from "../_shared/usage.ts";
import { handlePublic } from "../_shared/public-data.ts";
import { handleNotifications } from "../_shared/notifications.ts";
import { ApiError, json, noContent, normalizePath } from "../_shared/http.ts";

export function createHandler(dependencies: { db?: Db; config?: Config } = {}) {
  return async (request: Request): Promise<Response> => {
    const providedId = request.headers.get("X-Request-ID") ?? "";
    const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(providedId)
      ? providedId
      : crypto.randomUUID();
    const path = normalizePath(new URL(request.url).pathname);
    let result: Response;
    let stage = "config";
    try {
      const config = dependencies.config ?? getConfig();
      stage = "request_validation";
      checkRequestOrigin(request, path, config);
      if (request.method === "OPTIONS") {
        const origin = request.headers.get("origin");
        if (!origin) throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
        const method = request.headers.get("access-control-request-method");
        if (!method || !["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method)) {
          throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
        }
        const allowedHeaders = ["authorization", "content-type", "accept", "cache-control", "x-request-id"];
        const askedHeaders = (request.headers.get("access-control-request-headers") ?? "").split(",").map((
          h,
        ) => h.trim().toLowerCase()).filter(Boolean);
        if (askedHeaders.some((h) => !allowedHeaders.includes(h))) {
          throw new ApiError("ORIGIN_NOT_ALLOWED", 403);
        }
        result = noContent({
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": allowedHeaders.join(", "),
          "Access-Control-Max-Age": "600",
        });
      } else {
        const req = request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
        stage = "database_initialization";
        const db = dependencies.db ?? getDb();
        stage = "authentication";
        const principal = await authenticate(req, db, path);
        authorize(req, path, principal);
        stage = "handler";
        const common = await handleUsage(req, path, db, config, principal) ??
          await handlePairing(req, path, db, config, principal) ??
          await handleAccount(req, path, db, config, principal);
        let response = common;
        if (!response && principal) response = await handlePersonal(req, path, db, config, principal);
        if (!response && principal) {
          response = await handleNotifications(req, path, db, config, principal);
          if (response?.ok && path === "/api/me/push/subscriptions" && req.method === "PUT") {
            await recordFeature(db, config, principal, "push_subscription_registered");
          }
          if (response?.ok && path.startsWith("/api/me/push/subscriptions/") && req.method === "DELETE") {
            await recordFeature(db, config, principal, "push_subscription_removed");
          }
        }
        response ??= await handlePublic(req, path, db, config);
        result = response ?? json({ error: "NOT_FOUND", issues: null }, 404);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        result = json({ error: error.code, issues: null }, error.status, error.headers);
      } else {
        // Do not log DB connection strings, query parameters, cookies, request bodies, or upstream URLs.
        console.error(
          JSON.stringify({
            requestId,
            event: "api_failure",
            stage,
            code: error instanceof ConfigurationError ? error.code : "UNEXPECTED_FAILURE",
            ...(error instanceof ConfigurationError
              ? { missing: error.missing, invalid: error.invalid }
              : {}),
          }),
        );
        result = json({ error: "INTERNAL_ERROR", issues: null }, 500);
      }
    }
    result.headers.set("X-Request-ID", requestId);
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Vary", [result.headers.get("Vary"), "Origin"].filter(Boolean).join(", "));
    const origin = request.headers.get("origin");
    if (
      origin && DESKTOP_ORIGINS.includes(origin) &&
      (path.startsWith("/api/me/") || path.startsWith("/api/public/"))
    ) {
      result.headers.set("Access-Control-Allow-Origin", origin);
      result.headers.set("Access-Control-Expose-Headers", "Cache-Control, Location, X-Request-ID");
    }
    // Private and cookie-bearing responses must never enter a shared CDN cache.
    if (
      !path.startsWith("/api/public/") || path.startsWith("/api/public/usage") || result.status >= 400 ||
      result.headers.has("Set-Cookie")
    ) {
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("CDN-Cache-Control", "no-store");
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: result.status, headers: result.headers });
    }
    return result;
  };
}
