const encoder = new TextEncoder();
const hex = (data: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join("");
export function opaque(prefix: string, bytes = 32): string {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  return hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string" ? encoder.encode(value) : new Uint8Array(value),
    ),
  );
}
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
export const sessionHash = (token: string) => sha256(`jungle-bell:app-session:v3\0${token}`);
export const uiSessionHash = (token: string) => sha256(`jungle-bell:desktop-ui:v1\0${token}`);
export const mobileToken = async (secret: string, receiptHash: string) =>
  "jbs_" + await hmac(secret, `jungle-bell:mobile-session:v3\0${receiptHash}`);
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function manualCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => ALPHABET[b % 32]).join("");
}
export function normalizeManualCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return code.length === 10 && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}
export function constantTimeEqual(a: string, b: string): boolean {
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return result === 0;
}
