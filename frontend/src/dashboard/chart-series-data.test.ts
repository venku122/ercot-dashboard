import { describe, expect, it } from "vitest";
import { chartDefinitions } from "./chart-config";
import { retainChartSeriesData } from "./chart-series-data";
import type { ChartDefinition, LoadedSeries } from "./types";

const chart = chartDefinitions.find((entry) => entry.id === "supply-demand")!;
const loaded = (): LoadedSeries => ({
  points: [[300, 60000]],
  compare: [[300, 59000]],
  meta: { bucket_seconds: 300 },
  error: null,
});

describe("per-card plot source identity", () => {
  it("retains the projection when unrelated frequency data is published", () => {
    const demand = loaded();
    const source = new Map([["supply-demand:demand", demand]]);
    const first = retainChartSeriesData(chart, source, undefined);
    const next = new Map(source).set("frequency:frequency", loaded());
    expect(retainChartSeriesData(chart, next, first)).toBe(first);
    expect(first.get("supply-demand:demand")).toBe(demand);
  });

  it.each(["points", "compare", "meta", "error"] as const)(
    "invalidates on a relevant %s correction",
    (field) => {
      const demand = loaded();
      const first = retainChartSeriesData(
        chart,
        new Map([["supply-demand:demand", demand]]),
        undefined,
      );
      const corrected = {
        ...demand,
        [field]:
          field === "error"
            ? "unavailable"
            : field === "meta"
              ? { ...demand.meta, bucket_seconds: 900 }
              : [[300, 61000]],
      };
      const next = retainChartSeriesData(
        chart,
        new Map([["supply-demand:demand", corrected]]),
        first,
      );
      expect(next).not.toBe(first);
      expect(next.get("supply-demand:demand")).toBe(corrected);
      expect(next.get("supply-demand:demand")!.meta).toBe(corrected.meta);
    },
  );

  it("tracks input-only series and external interpretation references without dropping metadata", () => {
    const withInputs: ChartDefinition = {
      ...chart,
      series: [...chart.series, { ...chart.series[0]!, id: "input", inputOnly: true }],
      interpretation: {
        ...chart.interpretation!,
        mode: "reference-ratio",
        referenceLabel: "Capacity",
        referenceSeriesKey: "other:capacity",
      },
    };
    const input = loaded();
    const reference = loaded();
    const first = retainChartSeriesData(
      withInputs,
      new Map([
        ["supply-demand:input", input],
        ["other:capacity", reference],
      ]),
      undefined,
    );
    expect(first.get("supply-demand:input")).toBe(input);
    expect(first.get("other:capacity")).toBe(reference);
    const next = retainChartSeriesData(
      withInputs,
      new Map([
        ["supply-demand:input", input],
        ["other:capacity", { ...reference, meta: { bucket_seconds: 900 } }],
      ]),
      first,
    );
    expect(next).not.toBe(first);
  });

  it("invalidates removed entries and changed descriptor keys", () => {
    const demand = loaded();
    const first = retainChartSeriesData(
      chart,
      new Map([["supply-demand:demand", demand]]),
      undefined,
    );
    expect(retainChartSeriesData(chart, new Map(), first)).not.toBe(first);
    const changed = { ...chart, id: "new-source" };
    expect(
      retainChartSeriesData(changed, new Map([["new-source:demand", demand]]), first),
    ).not.toBe(first);
  });
});
