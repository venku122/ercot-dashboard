import { describe, expect, it } from "vitest";

import { buildDerivedMetrics, derivedLatestQueries, type LatestPoint } from "./derived-metrics";
import type { TrendBaseline } from "./api";
import type { Point } from "./types";

const now = 1_800_000_000;

function normalInputs() {
  const latest = new Map<string, LatestPoint>([
    ["demand", { ts: now - 30, value: 72_000 }],
    ["capacity", { ts: now - 30, value: 90_000 }],
    ["price", { ts: now - 30, value: 50 }],
    ["fuel-natural-gas", { ts: now - 60, value: 30_000 }],
    ["fuel-wind", { ts: now - 60, value: 20_000 }],
    ["fuel-solar", { ts: now - 60, value: 10_000 }],
    ["fuel-coal", { ts: now - 60, value: 8_000 }],
    ["fuel-nuclear", { ts: now - 60, value: 5_000 }],
    ["fuel-storage", { ts: now - 60, value: -1_000 }],
    ["storage-net", { ts: now - 60, value: -450 }],
  ]);
  const context = new Map<string, Point[]>([
    [
      "derived:forecast-demand",
      [
        [now + 3600, 74_000],
        [now + 5 * 3600, 78_500],
      ],
    ],
    [
      "derived:price-history",
      [
        [now - 7200, 20],
        [now - 3600, 45],
        [now - 1800, 80],
      ],
    ],
    ["derived:demand-yesterday", [[now - 24 * 3600, 69_000]]],
  ]);
  const trendBaselines = new Map<string, TrendBaseline>([["demand", [now - 3600, 70_000]]]);
  return { context, latest, now, trendBaselines };
}

describe("derived grid metrics", () => {
  it("defines the seven additional latest queries once", () => {
    expect(derivedLatestQueries.map((query) => query.id)).toEqual([
      "fuel-natural-gas",
      "fuel-wind",
      "fuel-solar",
      "fuel-coal",
      "fuel-nuclear",
      "fuel-storage",
      "storage-net",
    ]);
  });

  it("builds all nine metrics from fresh source observations", () => {
    const metrics = buildDerivedMetrics(normalInputs());
    expect(metrics).toHaveLength(9);
    expect(metrics.every((metric) => metric.available)).toBe(true);
    expect(Object.fromEntries(metrics.map((metric) => [metric.id, metric.valueLabel]))).toEqual({
      "capacity-utilization": "80.0%",
      "demand-growth": "+2.9%",
      "forecast-peak": "78.5 GW",
      "historical-comparison": "+4.3%",
      "hours-until-peak": "5 hours",
      "price-percentile": "67th percentile",
      "renewable-share": "41.7%",
      "reserve-margin": "25.0%",
      "storage-state": "Charging",
    });
  });

  it("classifies storage using the documented deadband", () => {
    const inputs = normalInputs();
    inputs.latest.set("storage-net", { ts: now, value: 50 });
    expect(
      buildDerivedMetrics(inputs).find((metric) => metric.id === "storage-state")?.valueLabel,
    ).toBe("Idle");
    inputs.latest.set("storage-net", { ts: now, value: 51 });
    expect(
      buildDerivedMetrics(inputs).find((metric) => metric.id === "storage-state")?.valueLabel,
    ).toBe("Discharging");
  });

  it("does not manufacture results from stale, missing, or distant inputs", () => {
    const inputs = normalInputs();
    inputs.latest.set("capacity", { ts: now - 3600, value: 90_000 });
    inputs.latest.set("fuel-solar", null);
    inputs.context.clear();
    inputs.trendBaselines.set("demand", [now - 10_000, 70_000]);
    const metrics = buildDerivedMetrics(inputs);
    for (const id of [
      "reserve-margin",
      "capacity-utilization",
      "renewable-share",
      "demand-growth",
      "forecast-peak",
      "hours-until-peak",
      "price-percentile",
      "historical-comparison",
    ]) {
      expect(metrics.find((metric) => metric.id === id)).toMatchObject({
        available: false,
        valueLabel: "—",
      });
    }
  });
});
