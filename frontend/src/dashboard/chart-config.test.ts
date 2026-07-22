import { describe, expect, it } from "vitest";

import { chartDefinitions } from "./chart-config";
import { deriveSeries } from "./derived";

describe("legacy parity contract", () => {
  it("keeps every reviewed legacy behavior represented in the React dashboard", () => {
    const ids = new Set(chartDefinitions.map((chart) => chart.id));
    for (const id of [
      "capacity-headroom",
      "time-error",
      "inertia",
      "dc-ties",
      "eea",
      "ancillary-regulation",
      "ancillary-reserves",
      "customer-outages",
      "weather-temperature",
      "weather-wind",
      "collector-duty-cycle",
    ]) {
      expect(ids.has(id), `missing parity chart ${id}`).toBe(true);
    }
  });

  it("computes aligned headroom, net flow, total flow, and delta series", () => {
    const input = [
      [
        [100, 10],
        [200, 20],
      ],
      [
        [100, 3],
        [200, -5],
      ],
    ] as Array<Array<[number, number]>>;

    expect(deriveSeries("subtract", input)).toEqual([
      [100, 7],
      [200, 25],
    ]);
    expect(deriveSeries("sum", input)).toEqual([
      [100, 13],
      [200, 15],
    ]);
    expect(deriveSeries("sum_abs", input)).toEqual([
      [100, 13],
      [200, 25],
    ]);
    expect(deriveSeries("delta", [input[0]!])).toEqual([[200, 10]]);
  });

  it("declares dimensional statistic policy instead of inferring it in the legend", () => {
    const policies = new Map(
      chartDefinitions.map((chart) => [chart.id, chart.statisticPolicy] as const),
    );
    expect(policies.get("supply-demand")).toBe("power");
    expect(policies.get("storage")).toBe("power");
    expect(policies.get("frequency")).toBe("gauge");
    expect(policies.get("pricing")).toBe("gauge");
    expect(policies.get("weather-temperature")).toBe("gauge");
  });
});
