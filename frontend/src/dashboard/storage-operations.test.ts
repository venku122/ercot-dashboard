import { describe, expect, it } from "vitest";

import { deriveStorageOperationsSnapshot, storageOperationMode } from "./storage-operations";

describe("storage operations truth contract", () => {
  it("uses the latest timestamp shared by all three source series", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [
          [100, -80],
          [200, -120],
          [300, -200],
        ],
        discharging: [
          [100, 20],
          [200, 30],
        ],
        netOutput: [
          [100, -60],
          [200, -90],
          [300, -190],
        ],
      }),
    ).toEqual({
      availability: "available",
      charging_mw: -120,
      discharging_mw: 30,
      mode: "charging",
      net_output_mw: -90,
      observed_at: 200,
      source_balance_delta_mw: 0,
    });
  });

  it("fails partial when independently latest values have no shared timestamp", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -80]],
        discharging: [[200, 20]],
        netOutput: [[300, -60]],
      }),
    ).toEqual({ availability: "partial", missing: ["shared-timestamp"] });
  });

  it("retains a source net value within the reviewed rounding tolerance", () => {
    const snapshot = deriveStorageOperationsSnapshot({
      charging: [[100, -100]],
      discharging: [[100, 40]],
      netOutput: [[100, -59.995]],
    });
    expect(snapshot).toMatchObject({ availability: "available", net_output_mw: -59.995 });
    expect(snapshot.availability === "available" && snapshot.source_balance_delta_mw).toBeCloseTo(
      0.005,
    );
  });

  it("fails partial when the independently published source values do not balance", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -100]],
        discharging: [[100, 40]],
        netOutput: [[100, -55]],
      }),
    ).toEqual({ availability: "partial", missing: ["source-balance"] });
  });

  it("uses strict deadband boundaries", () => {
    expect(storageOperationMode(-51)).toBe("charging");
    expect(storageOperationMode(-50)).toBe("near-idle");
    expect(storageOperationMode(50)).toBe("near-idle");
    expect(storageOperationMode(51)).toBe("discharging");
  });
});
