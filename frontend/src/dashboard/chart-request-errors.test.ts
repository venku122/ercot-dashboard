import { describe, expect, it } from "vitest";
import { chartDefinitions } from "./chart-config";
import { collectionPriceChart } from "./homepage-model";
import { chartRequestError, updateChartRequestErrors } from "./chart-request-errors";

const demand = chartDefinitions.find((chart) => chart.id === "supply-demand")!;
const frequency = chartDefinitions.find((chart) => chart.id === "frequency")!;
const pricing = chartDefinitions.find((chart) => chart.id === "pricing")!;

describe("history request cohort errors", () => {
  it("healthy unrelated frequency cannot clear a failed core cohort; core retry clears its own errors", () => {
    const failed = updateChartRequestErrors(new Map(), [demand], "HTTP503");
    expect(chartRequestError(failed, demand)).toBe("HTTP503");
    expect(chartRequestError(failed, frequency)).toBeNull();
    expect(updateChartRequestErrors(failed, [frequency], null)).toBe(failed);
    const recovered = updateChartRequestErrors(failed, [demand], null);
    expect(chartRequestError(recovered, demand)).toBeNull();
    expect(failed.size).toBe(1);
  });
  it("partial cohort success clears only the requested series", () => {
    const failed = updateChartRequestErrors(new Map(), [demand], "HTTP503");
    const corrected = updateChartRequestErrors(
      failed,
      [{ ...demand, series: [demand.series[0]!] }],
      null,
    );
    expect(corrected.get(demand.id)?.has(demand.series[0]!.id)).toBe(false);
    expect(chartRequestError(corrected, demand)).toBe("HTTP503");
  });
  it("legacy collection errors follow display aliases but never contaminate native settlement intervals", () => {
    const failed = updateChartRequestErrors(new Map(), [pricing], "legacy history unavailable");
    expect(chartRequestError(failed, collectionPriceChart)).toBe("legacy history unavailable");
    const native = { ...pricing, series: [{ ...pricing.series[0]!, id: "interval" }] };
    expect(chartRequestError(failed, native)).toBeNull();
  });
});
