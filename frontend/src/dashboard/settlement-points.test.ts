import { describe, expect, it } from "vitest";

import { settlementFreshness, settlementPointMetadata } from "./settlement-points";

describe("settlement point metadata", () => {
  it("labels hubs and load zones while retaining the ERCOT code", () => {
    expect(settlementPointMetadata("ercot_region:HB_WEST")).toEqual({
      code: "HB_WEST",
      label: "West Hub",
      type: "Hub",
    });
    expect(settlementPointMetadata("ercot_region:LZ_WEST")).toEqual({
      code: "LZ_WEST",
      label: "West Load Zone",
      type: "Load Zone",
    });
  });

  it("describes the official 15-minute settlement publication cadence", () => {
    expect(settlementFreshness(900)).toMatch(/normal 15-minute/);
    expect(settlementFreshness(1801)).toMatch(/Older than two/);
  });
});
