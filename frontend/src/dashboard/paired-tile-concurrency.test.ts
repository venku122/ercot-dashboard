import { afterEach, expect, it, vi } from "vitest";
import { loadSeries, resetCanonicalApiCachesForTests } from "./api";
import { headroomChart } from "./homepage-model";
import type { ChartDefinition } from "./types";

afterEach(() => {
  resetCanonicalApiCachesForTests();
  vi.unstubAllGlobals();
});

it("bounds physical and paired canonical tile transports together at eight", async () => {
  let active = 0,
    peak = 0,
    requests = 0;
  const physical = {
    key: "supply-demand.available-capacity",
    metric: "ercot.supply_demand.available_capacity_mw",
    match: "exact",
    source: "supply_demand",
    tags: ["source:supply_demand"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
  };
  const paired = {
    ...physical,
    key: "supply-demand.paired-headroom",
    metric: "ercot.supply_demand.paired_headroom_mw",
    match: "paired",
    statistic_policy: "gauge",
    pairing: {
      policy: "supply-demand-observed-exact-epoch-v1",
      contributors: [
        { metric: physical.metric, tags: physical.tags },
        { metric: "ercot.supply_demand.demand_mw", tags: physical.tags },
      ],
    },
  };
  const catalog = {
    schema: 2,
    tile_spans: { "1h": 3600, "1d": 86400 },
    lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": 3600 },
    boundary_policy: { coarse_partial_clipping: false, edge_lod: "native", rule: "native edges" },
    derived_resources: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("tile-catalog"))
        return new Response(
          JSON.stringify({
            ...catalog,
            series: url.includes("include=") ? [physical, paired] : [physical],
          }),
        );
      const match = /\/tiles\/([^/]+)\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/.exec(url)!;
      expect(match).not.toBeNull();
      active++;
      requests++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      const start = Number(match[3]),
        end = start + (match[2] === "1d" ? 86400 : 3600);
      const isPaired = match[1] === paired.key;
      return new Response(
        JSON.stringify({
          schema: 2,
          boundary_policy: "native_edges_coarse_aligned_interiors",
          buckets: [],
          lod: match[4],
          native_interval_seconds: 300,
          rollup: null,
          series_key: match[1],
          statistic_policy: isPaired ? "gauge" : "power",
          tile_start: start,
          tile_end: end,
          tile_span: match[2],
          unit: "MW",
          ...(isPaired
            ? {
                pairing: {
                  policy: paired.pairing.policy,
                  paired_count: 0,
                  expected_count: (end - start) / 300,
                  unpaired_count: 0,
                  ambiguous_count: 0,
                  first_observed_ts: null,
                  last_observed_ts: null,
                  collection_history: "first_collection_time_not_recorded",
                  reason: "no_matching_native_epochs",
                  partial_buckets: [],
                },
              }
            : {}),
        }),
      );
    }),
  );
  const charts: ChartDefinition[] = [
    { ...headroomChart, series: headroomChart.series.filter((series) => series.id === "headroom") },
    {
      ...headroomChart,
      id: "physical",
      statisticPolicy: "power",
      series: [
        {
          id: "capacity",
          label: "Capacity",
          color: "blue",
          metric: physical.metric,
          tags: physical.tags,
        },
      ],
    },
  ];
  await loadSeries(
    charts,
    {
      mode: "fixed",
      start: 86400,
      end: 86400 + 30 * 86400,
      rangeSeconds: 30 * 86400,
      paused: true,
    },
    "none",
    0,
    new AbortController().signal,
  );
  expect(requests).toBeGreaterThan(16);
  expect(peak).toBeLessThanOrEqual(8);
});
