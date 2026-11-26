import type { Config } from "../../functions/_shared/config.ts";
export const config: Config = {
  publicBaseUrl: "https://jungle-bell.sijun-yang.com",
  pairingSecret: "test-pairing-secret-32-characters-long",
  usageHashSecret: "test-usage-secret-32-characters-long",
  usageEnabled: true,
  collectorsEnabled: false,
  vapidPublicKey: "",
  vapidPrivateKey: "",
  vapidSubject: "",
  jobSecret: "test-job-secret-32-characters-long",
  laundrySourceUrl: "",
  mealsDefaultSourceUrl: "",
  mealsPinnedSourceUrl: "",
};
