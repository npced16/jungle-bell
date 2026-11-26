export type Row = Record<string, any>;
export interface Appliance extends Row {
  machineId: string;
  appliance: string;
  observedAt: string;
  state: { code: string; raw: string | null; known: boolean };
  operationalStatus: string;
  remainingMinutes: number;
  totalMinutes: number;
  startedAt: string;
  estimatedFinishAt: string | null;
  sessionId: string | null;
  errorCode: string | null;
}
export interface LaundryVersion {
  schemaVersion: number;
  sourceVersionSha: string;
  observedAt: string;
  machines: { id: string; washer: Appliance | null; dryer: Appliance | null }[];
  events: Row[];
  unknownEnums: Row[];
}
const known = new Set(
  "POWER_OFF INITIAL RESERVED DETECTING DISPENSING SOAKING WASHING RINSING SPINNING RUNNING DRYING COOLING REFRESHING WRINKLE_CARE PAUSE END ERROR"
    .split(" "),
);
function object(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const int = (v: unknown) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;
export function normalizeLaundry(
  raw: unknown,
  sha: string,
  at: string,
  previous: LaundryVersion | null,
): LaundryVersion {
  if (!object(raw) || !Object.keys(raw).length) throw new Error("Laundry response must contain machines");
  if (Object.keys(raw).length > 128) throw new Error("Laundry machine limit exceeded");
  const events: Row[] = [], unknownEnums: Row[] = [];
  const machines = Object.keys(raw).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(
    (id) => {
      const tower = raw[id];
      if (!object(tower)) throw new Error("Laundry machine must be an object");
      const old = previous?.machines.find((m) => m.id === id);
      const normalize = (kind: "washer" | "dryer"): Appliance | null => {
        if (!(kind in tower)) return null;
        const value = tower[kind];
        if (!object(value)) throw new Error("Laundry appliance must be an object");
        const prev = old?.[kind];
        const rawState = value.runState?.currentState == null ? null : String(value.runState.currentState);
        const state = {
          code: rawState && known.has(rawState) ? rawState : "UNKNOWN",
          raw: rawState && !known.has(rawState) ? rawState : null,
          known: rawState !== null && known.has(rawState),
        };
        if (state.raw) {
          unknownEnums.push({
            machineId: id,
            appliance: kind,
            fieldPath: `${kind}.runState.currentState`,
            value: state.raw,
          });
        }
        const remainingMinutes = int(value.timer?.remainHour) * 60 + int(value.timer?.remainMinute);
        const totalMinutes = int(value.timer?.totalHour) * 60 + int(value.timer?.totalMinute);
        const errorCode = value.error == null ? null : String(value.error);
        const operationalStatus = !state.known
          ? "UNKNOWN"
          : state.code === "ERROR" || errorCode !== null
          ? "ERROR"
          : state.code === "PAUSE"
          ? "PAUSED"
          : state.code === "END"
          ? "COMPLETED"
          : ["POWER_OFF", "INITIAL"].includes(state.code)
          ? "IDLE"
          : state.code === "RESERVED"
          ? "SCHEDULED"
          : "RUNNING";
        const cycleCount = value.cycle?.cycleCount == null ? null : int(value.cycle.cycleCount);
        const sessionId = rawState === null || ["IDLE", "COMPLETED"].includes(operationalStatus)
          ? prev?.sessionId ?? null
          : kind === "washer" && cycleCount !== null
          ? `${id}:washer:cycle:${cycleCount}`
          : prev?.sessionId && !["IDLE", "COMPLETED"].includes(prev.operationalStatus)
          ? prev.sessionId
          : `${id}:${kind}:${at}`;
        const current: Appliance = {
          machineId: id,
          appliance: kind,
          observedAt: at,
          state,
          operationalStatus,
          remainingMinutes,
          totalMinutes,
          startedAt: sessionId === null
            ? "1970-01-01T00:00:00Z"
            : prev?.sessionId === sessionId
            ? prev.startedAt
            : operationalStatus === "RUNNING"
            ? at
            : "1970-01-01T00:00:00Z",
          estimatedFinishAt: operationalStatus === "RUNNING"
            ? new Date(Date.parse(at) + remainingMinutes * 60000).toISOString()
            : null,
          remoteControlEnabled: value.remoteControlEnable?.remoteControlEnabled ?? null,
          cycleCount,
          sessionId,
          errorCode,
          projection: null,
          attempts: 0,
          errors: 0,
          rate: 0,
          riskLevel: "safe",
        };
        if (
          prev && !(prev.state.raw === null && !prev.state.known) && !(state.raw === null && !state.known)
        ) {
          const types: string[] = [];
          const before = prev.operationalStatus;
          for (
            const [status, type] of [["RUNNING", "STARTED"], ["COMPLETED", "COMPLETED"], [
              "ERROR",
              "ERROR_ENTERED",
            ], ["PAUSED", "PAUSED"]]
          ) if (before !== status && operationalStatus === status) types.push(type);
          if (before === "ERROR" && operationalStatus !== "ERROR") types.push("ERROR_CLEARED");
          if (before === "RUNNING" && operationalStatus === "IDLE") types.push("STOPPED_UNEXPECTEDLY");
          if ((prev.state.raw ?? prev.state.code) !== (state.raw ?? state.code)) types.push("STATE_CHANGED");
          for (const type of types) {
            events.push({
              id: `${id}:${kind}:${sessionId ?? "none"}:${at}:${type}`,
              machineId: id,
              appliance: kind,
              sessionId,
              type,
              previousObservedAt: prev.observedAt,
              observedAt: at,
              etaDeltaMinutes: null,
              previousState: prev.state.raw ?? prev.state.code,
              currentState: state.raw ?? state.code,
              detail: { changeWindow: { after: prev.observedAt, atOrBefore: at } },
            });
          }
        }
        return current;
      };
      const washer = normalize("washer"), dryer = normalize("dryer");
      if (!washer && !dryer) throw new Error("Laundry machine must contain an appliance");
      return { id, washer, dryer };
    },
  );
  return { schemaVersion: 1, sourceVersionSha: sha, observedAt: at, machines, events, unknownEnums };
}
