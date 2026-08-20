import { describe, expect, it } from "vitest";

import { deriveStorageOperationsSnapshot, storageOperationMode } from "./storage-operations";

describe("PR16 independent storage operations acceptance", () => {
  it("uses the newest timestamp shared by all three source series without borrowing", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [
          [100, -90],
          [200, -120],
          [300, -500],
        ],
        discharging: [
          [100, 20],
          [200, 30],
        ],
        netOutput: [
          [100, -70],
          [200, -90],
          [300, -450],
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

  it("reports partial when nonempty series have no shared timestamp", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -90]],
        discharging: [[200, 20]],
        netOutput: [[300, -70]],
      }),
    ).toEqual({ availability: "partial", missing: ["shared-timestamp"] });
  });

  it("distinguishes unavailable from specifically missing source series", () => {
    expect(
      deriveStorageOperationsSnapshot({ charging: [], discharging: [], netOutput: [] }),
    ).toEqual({
      availability: "unavailable",
      missing: ["charging", "discharging", "net-output"],
    });
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -90]],
        discharging: [],
        netOutput: [[100, -70]],
      }),
    ).toEqual({ availability: "partial", missing: ["discharging"] });
  });

  it("uses strict deadband boundaries and preserves a balanced published net value", () => {
    expect(storageOperationMode(-50.0001)).toBe("charging");
    expect(storageOperationMode(-50)).toBe("near-idle");
    expect(storageOperationMode(50)).toBe("near-idle");
    expect(storageOperationMode(50.0001)).toBe("discharging");
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -100]],
        discharging: [[100, 40]],
        netOutput: [[100, -59.995]],
      }),
    ).toMatchObject({ net_output_mw: -59.995 });
    const snapshot = deriveStorageOperationsSnapshot({
      charging: [[100, -100]],
      discharging: [[100, 40]],
      netOutput: [[100, -59.995]],
    });
    expect(snapshot).toMatchObject({ availability: "available" });
    if (snapshot.availability === "available") {
      expect(snapshot.source_balance_delta_mw).toBeCloseTo(0.005, 9);
    }
  });

  it("rejects a source-balance mismatch above the reviewed tolerance", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [[100, -100]],
        discharging: [[100, 40]],
        netOutput: [[100, -55]],
      }),
    ).toEqual({ availability: "partial", missing: ["source-balance"] });
  });

  it("ignores invalid points rather than promoting them into the coherent snapshot", () => {
    expect(
      deriveStorageOperationsSnapshot({
        charging: [
          [100, -80],
          [100.5, -90],
        ],
        discharging: [
          [100, 20],
          [200, Number.NaN],
        ],
        netOutput: [[100, -60]],
      }),
    ).toMatchObject({ availability: "available", observed_at: 100 });
  });
});
