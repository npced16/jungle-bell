export interface Principal {
  sessionId: string;
  userId: string;
  installationId: string;
  kind: "desktop" | "mobile" | "desktop-ui";
  origin?: string;
}
