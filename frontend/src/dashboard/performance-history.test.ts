import { expect, it } from "vitest";
import * as evidence from "../../../e2e/performance-observations";

it("counts actual canonical/chunk/forecast GETs and legacy POSTs while excluding only polling identities", () => {
  for (const url of [
    "/api/series/batch",
    "/api/v1/series/chunk?start=1",
    "/api/v2/tiles/supply-demand.paired-headroom/1d/0/native",
    "/api/v2/tile-catalog?include=paired-headroom",
    "/api/v1/forecast-vintages?as_of=1",
    "/api/v1/outlook",
  ])
    expect(
      evidence.isHistoryDataRequest(
        url.includes("batch") ? "POST" : "GET",
        "http://127.0.0.1:4311" + url,
      ),
    ).toBe(true);
  for (const url of [
    "/api/v1/source-health",
    "/api/latest/batch",
    "/api/v1/ranking?limit=12",
    "/health",
    "/assets/app.js",
  ])
    expect(evidence.isHistoryDataRequest("GET", "http://127.0.0.1:4311" + url)).toBe(false);
  expect(evidence.isHistoryDataRequest("OPTIONS", "http://127.0.0.1:4311/api/series/batch")).toBe(
    false,
  );
});

it("retains native edge coverage and every real first/last/min/max CSV vertex without a 1200 cap", () => {
  const state = (ts: number, value: number) => ({
    count: 1,
    first_ts: ts,
    first_value: value,
    last_ts: ts,
    last_value: value,
    minimum: value,
    minimum_ts: ts,
    maximum: value,
    maximum_ts: ts,
  });
  const tiles: evidence.ObservedTile[] = [
    {
      lod: "native",
      series_key: "supply-demand.paired-headroom",
      buckets: [
        { start: 1500, end: 1500, state: state(1500, -999) },
        { start: 1800, end: 1800, state: state(1800, 0) },
        { start: 5700, end: 5700, state: state(5700, 9) },
        { start: 6000, end: 6000, state: state(6000, 999) },
      ],
    },
    {
      lod: "1h",
      series_key: "supply-demand.paired-headroom",
      buckets: [
        {
          start: 2100,
          end: 5700,
          state: {
            ...state(2100, 10),
            count: 12,
            last_ts: 5400,
            last_value: 7,
            minimum: 5,
            minimum_ts: 2700,
            maximum: 20,
            maximum_ts: 2400,
          },
        },
      ],
    },
  ];
  const proof = evidence.selectedPairedTileProof(tiles, 1800, 5700);
  expect(proof.count).toBe(14);
  expect(proof.minimum).toBe(0);
  expect(proof.maximum).toBe(20);
  expect([...proof.requiredPoints].sort((a, b) => a[0] - b[0])).toEqual([
    [1800, 0],
    [2100, 10],
    [2400, 20],
    [2700, 5],
    [5400, 7],
    [5700, 9],
  ]);
  expect(proof.maximumVertices).toBe(6);
});
