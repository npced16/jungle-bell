import { type Db, transaction } from "./db.ts";
import type { Config } from "./config.ts";
import type { Principal } from "./types.ts";
import { hmac, manualCode, mobileToken, normalizeManualCode, opaque, sessionHash, sha256 } from "./crypto.ts";
import {
  ApiError,
  body,
  check,
  clearCookies,
  cookie,
  id,
  iso,
  json,
  noContent,
  setCookie,
  string,
} from "./http.ts";
import { recordFeature } from "./usage.ts";
const TTL = 600000, MOBILE_TTL = 30 * 86400000;
type Pairing = Record<string, unknown>;
function pending(row: Pairing | undefined, now: number): asserts row is Pairing {
  check(row, "PAIRING_NOT_FOUND", 404);
  check(Number(row.expires_at_epoch_ms) > now, "PAIRING_EXPIRED", 410);
  check(row.status === "pending", "PAIRING_ALREADY_USED", 409);
}
function claimInput(b: Record<string, unknown>) {
  return {
    installation: string(b.installationId, 37, 37, /^jbmi_[a-f0-9]{32}$/),
    label: string(b.deviceLabel, 1, 80).trim(),
  };
}
export async function handlePairing(
  req: Request,
  path: string,
  db: Db,
  config: Config,
  p: Principal | null,
): Promise<Response | null> {
  const now = Date.now(), secure = config.publicBaseUrl.startsWith("https:"), headers = new Headers();
  if (path === "/api/me/pairings" && req.method === "POST" && p) {
    await body(req, []);
    const pairing = crypto.randomUUID(), challenge = opaque("jbpc_"), code = manualCode();
    const challengeHash = await sha256(challenge), codeHash = await hmac(config.pairingSecret, code);
    await transaction(db, async (tx) => {
      // The installation row exists and serializes two simultaneous replacement requests.
      const parents =
        await tx`SELECT installation_id FROM jb.desktop_device WHERE installation_id=${p.installationId} AND user_id=${p.userId} FOR UPDATE`;
      check(parents.length, "AUTHENTICATION_REQUIRED", 401);
      await tx`DELETE FROM jb.pairing_challenge WHERE user_id=${p.userId} AND desktop_installation_id=${p.installationId} AND status IN ('pending','claimed','approved')`;
      await tx`INSERT INTO jb.pairing_challenge(id,user_id,desktop_installation_id,pairing_secret_sha256,manual_code_hash,status,created_at_epoch_ms,expires_at_epoch_ms)
        VALUES (${pairing},${p.userId},${p.installationId},${challengeHash},${codeHash},'pending',${now},${
        now + TTL
      })`;
    });
    return json({
      pairingId: `jbp_${pairing}`,
      qrPayload: `${config.publicBaseUrl}/#pairing=jbp_${pairing}&challenge=${challenge}`,
      manualCode: code,
      expiresAt: iso(now + TTL),
    }, 201);
  }
  const personal = /^\/api\/me\/pairings\/([^/]+)(\/approve)?$/.exec(path);
  if (personal && p && ((req.method === "GET" && !personal[2]) || (req.method === "POST" && personal[2]))) {
    const pairing = id(personal[1], "jbp_");
    if (req.method === "GET") {
      const [row] =
        await db`SELECT * FROM jb.pairing_challenge WHERE id=${pairing} AND user_id=${p.userId} AND desktop_installation_id=${p.installationId}`;
      check(row, "PAIRING_NOT_FOUND", 404);
      const status = row.status === "consumed"
        ? "completed"
        : Number(row.expires_at_epoch_ms) <= now
        ? "expired"
        : row.status;
      return json({
        status,
        claim: status === "claimed"
          ? {
            claimId: `jbp_${row.id}`,
            deviceLabel: row.mobile_label ?? "모바일 기기",
            confirmationCode: String(row.mobile_installation_id ?? "0000").slice(-4).toUpperCase(),
          }
          : null,
      });
    }
    const b = await body(req, ["claimId"]);
    check(string(b.claimId, 40, 40, /^jbp_[0-9a-f-]{36}$/) === personal[1], "PAIRING_CLAIM_MISMATCH", 409);
    await transaction(db, async (tx) => {
      const [row] =
        await tx`SELECT * FROM jb.pairing_challenge WHERE id=${pairing} AND user_id=${p.userId} AND desktop_installation_id=${p.installationId} FOR UPDATE`;
      check(row, "PAIRING_NOT_FOUND", 404);
      check(Number(row.expires_at_epoch_ms) > now, "PAIRING_EXPIRED", 410);
      check(
        row.status === "claimed" && row.claim_receipt_sha256 && row.mobile_installation_id &&
          row.mobile_label != null,
        row.status === "pending" ? "PAIRING_NOT_CLAIMED" : "PAIRING_ALREADY_USED",
        409,
      );
      // Kotlin PairingService passes SHA256(receipt), not the raw receipt, to TokenCodec.mobileToken.
      const token = await mobileToken(config.pairingSecret, row.claim_receipt_sha256),
        hash = await sessionHash(token);
      await tx`UPDATE jb.pairing_challenge SET status='approved',approved_at_epoch_ms=${now} WHERE id=${pairing}`;
      await tx`INSERT INTO jb.app_session(id,user_id,installation_id,kind,label,token_sha256,created_at_epoch_ms,expires_at_epoch_ms,last_seen_at_epoch_ms,source_pairing_id)
        VALUES (${crypto.randomUUID()},${p.userId},${row.mobile_installation_id},'mobile',${row.mobile_label},${hash},${now},${
        now + MOBILE_TTL
      },${now},${pairing})`;
    });
    await recordFeature(db, config, p, "mobile_device_paired");
    return noContent();
  }
  const publicRoute = /^\/api\/pairings\/([^/]+)\/(claims|handoff|complete)$/.exec(path);
  if (req.method !== "POST") return null;
  if (publicRoute && publicRoute[1] !== "handoffs" && publicRoute[2] === "complete") {
    await body(req, []);
    const pairing = id(publicRoute[1], "jbp_"), receipt = cookie(req, "jb_pending_claim");
    check(receipt && /^jbcr_[a-f0-9]{64}$/.test(receipt), "PAIRING_RECEIPT_INVALID", 401);
    const hash = await sha256(receipt);
    const expiresAt = await transaction(db, async (tx) => {
      const [row] = await tx`SELECT * FROM jb.pairing_challenge WHERE id=${pairing} FOR UPDATE`;
      check(row && row.claim_receipt_sha256 === hash, "PAIRING_RECEIPT_INVALID", 401);
      check(Number(row.expires_at_epoch_ms) > now, "PAIRING_EXPIRED", 410);
      check(
        row.approved_at_epoch_ms != null && ["approved", "consumed"].includes(row.status),
        "PAIRING_NOT_APPROVED",
        409,
      );
      const expires = Number(row.approved_at_epoch_ms) + MOBILE_TTL;
      check(expires > now, "PAIRING_EXPIRED", 410);
      // A replay of a consumed receipt remains idempotent, but cannot resurrect a revoked mobile session.
      const sessions =
        await tx`SELECT id FROM jb.app_session WHERE source_pairing_id=${pairing} AND revoked_at_epoch_ms IS NULL AND expires_at_epoch_ms>${now}`;
      check(sessions.length, "PAIRING_EXPIRED", 410);
      await tx`UPDATE jb.pairing_challenge SET status='consumed' WHERE id=${pairing} AND status='approved'`;
      return expires;
    });
    clearCookies(headers, "jb_pending_claim", secure);
    setCookie(
      headers,
      "jb_device",
      await mobileToken(config.pairingSecret, hash),
      (expiresAt - now) / 1000,
      secure,
    );
    return noContent(headers);
  }
  if (publicRoute && publicRoute[1] !== "handoffs" && publicRoute[2] === "handoff") {
    const pairing = id(publicRoute[1], "jbp_"), b = await body(req, ["challenge"]);
    const challenge = string(b.challenge, 69, 69, /^jbpc_[a-f0-9]{64}$/), hash = await sha256(challenge);
    const [row] =
      await db`SELECT * FROM jb.pairing_challenge WHERE id=${pairing} AND pairing_secret_sha256=${hash}`;
    pending(row, now);
    clearCookies(headers, "jb_pending_claim", secure);
    setCookie(
      headers,
      "jb_pairing_handoff",
      challenge,
      (Number(row.expires_at_epoch_ms) - now) / 1000,
      secure,
    );
    return noContent(headers);
  }
  const manual = path === "/api/pairings/claims", handoff = path === "/api/pairings/handoffs/claims";
  const qr = publicRoute && publicRoute[1] !== "handoffs" && publicRoute[2] === "claims";
  if (!manual && !handoff && !qr) return null;
  const b = await body(
    req,
    manual
      ? ["manualCode", "installationId", "deviceLabel"]
      : qr
      ? ["challenge", "installationId", "deviceLabel"]
      : ["installationId", "deviceLabel"],
  );
  const input = claimInput(b);
  let hash: string, qrId: string | null = null;
  if (manual) {
    const code = normalizeManualCode(string(b.manualCode, 10, 32));
    check(code, "PAIRING_NOT_FOUND", 404);
    hash = await hmac(config.pairingSecret, code);
  } else {
    const challenge = handoff
      ? cookie(req, "jb_pairing_handoff")
      : string(b.challenge, 69, 69, /^jbpc_[a-f0-9]{64}$/);
    if (handoff && !challenge) return noContent();
    check(challenge && /^jbpc_[a-f0-9]{64}$/.test(challenge), "PAIRING_HANDOFF_INVALID", 401);
    hash = await sha256(challenge);
    if (qr) qrId = id(publicRoute![1], "jbp_");
  }
  const receipt = opaque("jbcr_"), receiptHash = await sha256(receipt);
  try {
    const result = await transaction(db, async (tx) => {
      const [row] = manual
        ? await tx`SELECT * FROM jb.pairing_challenge WHERE manual_code_hash=${hash} FOR UPDATE`
        : await tx`SELECT * FROM jb.pairing_challenge WHERE pairing_secret_sha256=${hash} FOR UPDATE`;
      if (handoff) check(row, "PAIRING_HANDOFF_INVALID", 401);
      if (qrId) check(row?.id === qrId, "PAIRING_NOT_FOUND", 404);
      pending(row, now);
      await tx`UPDATE jb.pairing_challenge SET status='claimed',claim_receipt_sha256=${receiptHash},mobile_installation_id=${input.installation},mobile_label=${input.label} WHERE id=${row
        .id as string}`;
      return row;
    });
    if (handoff) clearCookies(headers, "jb_pairing_handoff", secure);
    setCookie(
      headers,
      "jb_pending_claim",
      receipt,
      (Number(result.expires_at_epoch_ms) - now) / 1000,
      secure,
    );
    return json({ claimId: `jbp_${result.id}`, status: "awaiting-desktop-approval" }, 201, headers);
  } catch (error) {
    if (handoff && error instanceof ApiError) {
      clearCookies(headers, "jb_pairing_handoff", secure);
      error.headers = headers;
    }
    throw error;
  }
}
