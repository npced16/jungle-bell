export const DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:5173"];
export class ConfigurationError extends Error {
  constructor(
    readonly code: "INVALID_PUBLIC_ORIGIN" | "INVALID_REQUIRED_SECRETS" | "SECRETS_NOT_DISTINCT",
    readonly missing: string[] = [],
    readonly invalid: string[] = [],
  ) {
    super(code);
  }
}
export interface Config {
  publicBaseUrl: string;
  pairingSecret: string;
  usageHashSecret: string;
  usageEnabled: boolean;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  laundrySourceUrl: string;
  mealsDefaultSourceUrl: string;
  mealsPinnedSourceUrl: string;
  collectorsEnabled: boolean;
  jobSecret: string;
}
export function getConfig(): Config {
  const env = (name: string) => Deno.env.get(name)?.trim() ?? "";
  const publicBaseUrl = env("PUBLIC_BASE_URL") || "https://jungle-bell.sijun-yang.com";
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new ConfigurationError("INVALID_PUBLIC_ORIGIN");
  }
  if (parsed.origin !== publicBaseUrl || (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1")) {
    throw new ConfigurationError("INVALID_PUBLIC_ORIGIN");
  }
  const pairingSecret = env("PAIRING_SECRET");
  const usageHashSecret = env("USAGE_HASH_SECRET");
  const jobSecret = env("JOB_SECRET");
  if ([pairingSecret, usageHashSecret, jobSecret].some((v) => v.length < 32)) {
    const required = {
      PAIRING_SECRET: pairingSecret,
      USAGE_HASH_SECRET: usageHashSecret,
      JOB_SECRET: jobSecret,
    };
    throw new ConfigurationError(
      "INVALID_REQUIRED_SECRETS",
      Object.keys(required).filter((key) => !required[key as keyof typeof required]),
      Object.keys(required).filter((key) =>
        required[key as keyof typeof required].length > 0 &&
        required[key as keyof typeof required].length < 32
      ),
    );
  }
  if (pairingSecret === usageHashSecret) throw new ConfigurationError("SECRETS_NOT_DISTINCT");
  return {
    publicBaseUrl,
    pairingSecret,
    usageHashSecret,
    jobSecret,
    usageEnabled: env("USAGE_METRICS_ENABLED") !== "false",
    collectorsEnabled: env("COLLECTORS_ENABLED") === "true",
    vapidPublicKey: env("VAPID_PUBLIC_KEY"),
    vapidPrivateKey: env("VAPID_PRIVATE_KEY"),
    vapidSubject: env("VAPID_SUBJECT"),
    laundrySourceUrl: env("LAUNDRY_SOURCE_URL"),
    mealsDefaultSourceUrl: env("MEALS_DEFAULT_SOURCE_URL"),
    mealsPinnedSourceUrl: env("MEALS_PINNED_SOURCE_URL"),
  };
}
