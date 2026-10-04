import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";

const CAPACITY = "ercot.supply_demand.available_capacity_mw";
const DEMAND = "ercot.supply_demand.demand_mw";
const PAIR_POLICY = "supply-demand-observed-exact-epoch-v1";
export const pairedCatalogEntry = {
  key: "supply-demand.paired-headroom",
  match: "paired",
  metric: "ercot.supply_demand.paired_headroom_mw",
  native_interval_seconds: 300,
  rollup: null,
  source: "supply_demand",
  statistic_policy: "gauge",
  supported_lods: ["native", "5m", "15m", "1h"],
  tags: ["source:supply_demand"],
  unit: "MW",
  pairing: {
    policy: PAIR_POLICY,
    contributors: [
      { metric: CAPACITY, tags: ["source:supply_demand"] },
      { metric: DEMAND, tags: ["source:supply_demand"] },
    ],
  },
} as const;
const contributorEntries = [
  ["supply-demand.available-capacity", CAPACITY],
  ["supply-demand.demand", DEMAND],
].map(([key, metric]) => ({
  key: key!,
  metric: metric!,
  match: "exact",
  native_interval_seconds: 300,
  rollup: null,
  source: "supply_demand",
  statistic_policy: "power",
  supported_lods: ["native", "5m", "15m", "1h"],
  tags: ["source:supply_demand"],
  unit: "MW",
}));
export type NativeFixtureValue = (metric: string, index: number) => number;

export function nativeFixtureIndex(timestamp: number, now: number) {
  return 63 + (timestamp - Math.floor((now - 30) / 300) * 300) / 300;
}

export function observedTileFixture(
  path: string,
  now: number,
  value: NativeFixtureValue,
  empty = false,
) {
  const match =
    /^\/api\/v2\/tiles\/(supply-demand\.(?:paired-headroom|available-capacity|demand))\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/.exec(
      path,
    );
  if (!match) throw new Error("unknown_observed_fixture_tile");
  const [, key, span, startText, lod] = match;
  const start = Number(startText),
    end = start + (span === "1d" ? 86400 : 3600);
  const paired = key === pairedCatalogEntry.key;
  const step = lod === "native" ? 300 : lod === "5m" ? 300 : lod === "15m" ? 900 : 3600;
  const rows: Array<[number, number]> = [];
  for (let ts = start; !empty && ts < end && ts <= now - 30; ts += 300) {
    const index = nativeFixtureIndex(ts, now);
    // Same source identity and epoch for both native contributors; subtraction
    // happens here, before any bucket counts, extrema, sums or timestamps.
    const capacity = value(CAPACITY, index),
      demand = value(DEMAND, index);
    rows.push([
      ts,
      paired ? capacity - demand : key?.endsWith("available-capacity") ? capacity : demand,
    ]);
  }
  const groups = new Map<number, Array<[number, number]>>();
  for (const row of rows) {
    const anchor = lod === "native" ? row[0] : Math.floor(row[0] / step) * step;
    groups.set(anchor, [...(groups.get(anchor) ?? []), row]);
  }
  const buckets = [...groups].map(([anchor, points]) => {
    const first = points[0]!,
      last = points.at(-1)!;
    const minimum = points.reduce((a, b) => (b[1] < a[1] ? b : a));
    const maximum = points.reduce((a, b) => (b[1] > a[1] ? b : a));
    const integral = paired
      ? 0
      : points
          .slice(1)
          .reduce(
            (sum, point, index) => sum + points[index]![1] * (point[0] - points[index]![0]),
            0,
          );
    return {
      start: anchor,
      end: lod === "native" ? anchor : anchor + step,
      state: {
        version: 2,
        count: points.length,
        first_ts: first[0],
        first_value: first[1],
        first_ordinal: 0,
        last_ts: last[0],
        last_value: last[1],
        last_ordinal: 0,
        minimum: minimum[1],
        minimum_ts: minimum[0],
        maximum: maximum[1],
        maximum_ts: maximum[0],
        value_sum: points.reduce((sum, point) => sum + point[1], 0),
        integral_value_seconds: integral,
      },
    };
  });
  return {
    boundary_policy: "native_edges_coarse_aligned_interiors",
    buckets,
    lod,
    native_interval_seconds: 300,
    rollup: null,
    schema: 2,
    series_key: key,
    statistic_policy: paired ? "gauge" : "power",
    tile_end: end,
    tile_span: span,
    tile_start: start,
    unit: "MW",
    ...(paired
      ? {
          pairing: {
            policy: PAIR_POLICY,
            paired_count: rows.length,
            expected_count: (end - start) / 300,
            unpaired_count: 0,
            ambiguous_count: 0,
            first_observed_ts: rows[0]?.[0] ?? null,
            last_observed_ts: rows.at(-1)?.[0] ?? null,
            collection_history: "first_collection_time_not_recorded",
            reason: rows.length ? null : "no_matching_native_epochs",
            continuous_buckets:
              lod === "native"
                ? []
                : buckets
                    .filter((bucket) => bucket.state.count === step / 300)
                    .map((bucket) => bucket.start),
            partial_buckets:
              lod === "native"
                ? []
                : buckets
                    .filter((bucket) => bucket.state.count < step / 300)
                    .map((bucket) => bucket.start),
          },
        }
      : {}),
  };
}

export async function installObservedTiles(
  page: Page,
  now: number,
  value: NativeFixtureValue,
  empty = false,
  unavailable = false,
) {
  const fulfill = async (route: Parameters<Parameters<Page["route"]>[1]>[0], payload: unknown) => {
    const body = JSON.stringify(payload),
      etag = `"fixture-${createHash("sha256").update(body).digest("hex")}"`;
    if (route.request().headers()["if-none-match"] === etag)
      await route.fulfill({ status: 304, headers: { ETag: etag } });
    else
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body,
        headers: { ETag: etag, "Cache-Control": "public, max-age=30, must-revalidate" },
      });
  };
  await page.route("**/api/v2/tile-catalog**", async (route) => {
    const url = new URL(route.request().url());
    if (unavailable) {
      await route.fulfill({ status: 503, body: "fixture unavailable" });
      return;
    }
    if (!["", "?include=paired-headroom"].includes(url.search)) {
      await route.fulfill({ status: 400 });
      return;
    }
    await fulfill(route, {
      schema: 2,
      boundary_policy: {
        coarse_partial_clipping: false,
        edge_lod: "native",
        rule: "clients use native boundary tiles and coarse LOD only for aligned interiors",
      },
      derived_resources: [],
      lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": 3600 },
      tile_spans: { "1h": 3600, "1d": 86400 },
      series: [...contributorEntries, ...(url.search ? [pairedCatalogEntry] : [])],
    });
  });
  await page.route("**/api/v2/tiles/**", async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, body: "fixture unavailable" });
      return;
    }
    await fulfill(
      route,
      observedTileFixture(new URL(route.request().url()).pathname, now, value, empty),
    );
  });
}
