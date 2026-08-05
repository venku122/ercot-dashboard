import { describe, expect, it } from "vitest";

import { buildHeroTrend, unavailableHeroTrend } from "./hero-trends";

describe("hero trends", () => {
  it("formats rising and falling deltas through the shared unit system", () => {
    expect(buildHeroTrend(71_800, 70_400, "MW", 1_753_139_940)).toMatchObject({
      arrow: "▲",
      comparisonLabel: "Last hour",
      deltaLabel: "+1.4 GW",
      direction: "up",
      observedAt: 1_753_139_940,
    });
    expect(buildHeroTrend(35, 42.5, "$/MWh", 1_753_139_940)).toMatchObject({
      arrow: "▼",
      deltaLabel: "−$7.50/MWh",
      direction: "down",
    });
  });

  it("labels an unchanged comparison without relying on color", () => {
    expect(buildHeroTrend(60, 60, "Hz", 1_753_139_940)).toMatchObject({
      arrow: "—",
      deltaLabel: "No change",
      direction: "steady",
    });
  });

  it("keeps missing or non-finite comparisons explicitly unavailable", () => {
    expect(buildHeroTrend(68_000, null, "MW", 1_753_139_940)).toEqual(
      unavailableHeroTrend(1_753_139_940),
    );
    expect(buildHeroTrend(Number.NaN, 68_000, "MW", null)).toMatchObject({
      deltaLabel: "Trend unavailable",
      direction: "unavailable",
      timestampLabel: "Update time unavailable",
    });
  });
});
