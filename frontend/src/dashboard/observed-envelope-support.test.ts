import { expect, it } from "vitest";
import { displayPoints, headroomChart, seriesGapSeconds } from "./homepage-model";
import { observationAt, temporalPolicy } from "./series-temporal-policy";
import type { LoadedSeries } from "./types";

it("connects verified full native support but breaks partial and old unknown envelopes", () => {
  const points: [number, number][] = [
    [90000, 10],
    [93300, 7],
  ];
  const data: LoadedSeries = {
    points,
    compare: [],
    error: null,
    meta: { bucket_seconds: 3600, observed_envelope_support: [{ start: 90000, end: 93300 }] },
  };
  const gap = seriesGapSeconds(headroomChart.id, headroomChart.series[0]!, data);
  expect(displayPoints(points, gap, data.meta.observed_envelope_support)).toHaveLength(2);
  expect(displayPoints(points, gap, [])).toHaveLength(3);
  expect(
    observationAt(data, 93300, temporalPolicy(headroomChart.id, headroomChart.series[0]!)),
  ).toMatchObject({ ts: 93300, value: 7, resolution: "aggregate", coverage: "unknown" });
  expect(
    observationAt(data, 93901, temporalPolicy(headroomChart.id, headroomChart.series[0]!)),
  ).toBeNull();
});
