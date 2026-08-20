import type { Point } from "./types";

export const STORAGE_OPERATION_THRESHOLD_MW = 50;
export const STORAGE_BALANCE_TOLERANCE_MW = 0.01;

export type StorageOperationMode = "charging" | "near-idle" | "discharging";

export type StorageOperationsSnapshot =
  | {
      availability: "available";
      charging_mw: number;
      discharging_mw: number;
      mode: StorageOperationMode;
      net_output_mw: number;
      observed_at: number;
      source_balance_delta_mw: number;
    }
  | {
      availability: "partial" | "unavailable";
      missing: Array<
        "charging" | "discharging" | "net-output" | "shared-timestamp" | "source-balance"
      >;
    };

function finitePoints(points: Point[]): Map<number, number> {
  const output = new Map<number, number>();
  for (const [timestamp, value] of points) {
    if (Number.isSafeInteger(timestamp) && Number.isFinite(value)) output.set(timestamp, value);
  }
  return output;
}

export function storageOperationMode(netOutputMw: number): StorageOperationMode {
  if (netOutputMw < -STORAGE_OPERATION_THRESHOLD_MW) return "charging";
  if (netOutputMw > STORAGE_OPERATION_THRESHOLD_MW) return "discharging";
  return "near-idle";
}

export function deriveStorageOperationsSnapshot(input: {
  charging: Point[];
  discharging: Point[];
  netOutput: Point[];
}): StorageOperationsSnapshot {
  const charging = finitePoints(input.charging);
  const discharging = finitePoints(input.discharging);
  const netOutput = finitePoints(input.netOutput);
  const missing: Array<
    "charging" | "discharging" | "net-output" | "shared-timestamp" | "source-balance"
  > = [];
  if (!charging.size) missing.push("charging");
  if (!discharging.size) missing.push("discharging");
  if (!netOutput.size) missing.push("net-output");
  if (missing.length) {
    return {
      availability: charging.size || discharging.size || netOutput.size ? "partial" : "unavailable",
      missing,
    };
  }
  const common = [...netOutput.keys()]
    .filter((timestamp) => charging.has(timestamp) && discharging.has(timestamp))
    .sort((left, right) => right - left);
  const observedAt = common[0];
  if (observedAt === undefined) {
    return { availability: "partial", missing: ["shared-timestamp"] };
  }
  const chargingMw = charging.get(observedAt)!;
  const dischargingMw = discharging.get(observedAt)!;
  const netOutputMw = netOutput.get(observedAt)!;
  const balanceDelta = netOutputMw - (chargingMw + dischargingMw);
  if (Math.abs(balanceDelta) > STORAGE_BALANCE_TOLERANCE_MW) {
    return { availability: "partial", missing: ["source-balance"] };
  }
  return {
    availability: "available",
    charging_mw: chargingMw,
    discharging_mw: dischargingMw,
    mode: storageOperationMode(netOutputMw),
    net_output_mw: netOutputMw,
    observed_at: observedAt,
    source_balance_delta_mw: balanceDelta,
  };
}
