import { describe, expect, it } from "vitest";

import { chartDefinitions } from "./chart-config";
import {
  formatInterpretationRange,
  interpretationAriaDescription,
  interpretationPolicyIssues,
  resolveInterpretationBands,
} from "./chart-interpretation";
import type { LoadedSeries } from "./types";

const interpretedChartIds = [
  "supply-demand",
  "frequency",
  "reserves",
  "storage",
  "generation-outages",
  "pricing",
];

function loaded(points: Array<[number, number]>): LoadedSeries {
  return { compare: [], error: null, meta: {}, points };
}

describe("chart interpretation policy", () => {
  it("centralizes complete, contiguous policies for the directive charts", () => {
    for (const id of interpretedChartIds) {
      const chart = chartDefinitions.find((candidate) => candidate.id === id);
      expect(chart?.interpretation, `${id} interpretation`).toBeTruthy();
      expect(interpretationPolicyIssues(chart!)).toEqual([]);
    }
  });

  it("resolves demand and outage ratios from the latest finite capacity", () => {
    const chart = chartDefinitions.find((candidate) => candidate.id === "supply-demand")!;
    const interpretation = chart.interpretation!;
    const data = new Map([
      [
        "supply-demand:available-capacity",
        loaded([
          [100, 90_000],
          [200, Number.NaN],
          [300, 100_000],
        ]),
      ],
    ]);
    const bands = resolveInterpretationBands(interpretation, data);

    expect(bands.map(({ lowerValue, upperValue }) => [lowerValue, upperValue])).toEqual([
      [undefined, 80_000],
      [80_000, 90_000],
      [90_000, 100_000],
      [100_000, undefined],
    ]);
    expect(formatInterpretationRange(interpretation, interpretation.bands[1]!, chart.unit)).toBe(
      "80.0%–90.0%",
    );
  });

  it("withholds relative canvas bands when the reference is missing or invalid", () => {
    const chart = chartDefinitions.find((candidate) => candidate.id === "generation-outages")!;
    const interpretation = chart.interpretation!;
    expect(resolveInterpretationBands(interpretation, new Map())).toEqual([]);
    expect(
      resolveInterpretationBands(
        interpretation,
        new Map([["supply-demand:available-capacity", loaded([[100, 0]])]]),
      ),
    ).toEqual([]);
  });

  it("provides a complete non-color text equivalent for canvas bands", () => {
    const frequency = chartDefinitions.find((chart) => chart.id === "frequency")!;
    expect(interpretationAriaDescription(frequency)).toContain(
      "Interpretation guide for system frequency",
    );
    expect(interpretationAriaDescription(frequency)).toContain("Near nominal, 59.950 Hz–60.050 Hz");
    expect(interpretationAriaDescription(frequency)).toContain("Critical high, 60.200 Hz or above");
  });
});
