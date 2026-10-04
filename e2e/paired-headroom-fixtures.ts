import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { TileCatalogSeries } from "../frontend/src/dashboard/tile-planner";

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
// Reviewed primary06 receiver physical catalog. Legacy hourly forecast is
// retained; archived forecasting uses a separate publication API contract.
export const physicalFixtureCatalog: TileCatalogSeries[] = [
  {
    key: "supply-demand.demand",
    metric: "ercot.supply_demand.demand_mw",
    tags: ["source:supply_demand"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "supply_demand",
    match: "exact",
  },
  {
    key: "supply-demand.available-capacity",
    metric: "ercot.supply_demand.available_capacity_mw",
    tags: ["source:supply_demand"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "supply_demand",
    match: "exact",
  },
  {
    key: "storage.net-output",
    metric: "ercot.storage.net_output_mw",
    tags: ["source:energy_storage"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "energy_storage",
    match: "exact",
  },
  {
    key: "fuel-mix.wind",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:wind", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "fuel-mix.solar",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:solar", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "fuel-mix.total",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: "sum",
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "selector",
  },
  {
    key: "renewables.wind-actual",
    metric: "ercot.renewables.actual_mw",
    tags: ["resource:wind", "source:wind_solar"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "wind_solar",
    match: "exact",
  },
  {
    key: "renewables.solar-actual",
    metric: "ercot.renewables.actual_mw",
    tags: ["resource:solar", "source:wind_solar"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "wind_solar",
    match: "exact",
  },
  {
    key: "supply-demand.forecast-demand",
    metric: "ercot.supply_demand.forecast_demand_mw",
    tags: ["source:supply_demand"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "supply_demand",
    match: "exact",
  },
  {
    key: "frequency.system",
    metric: "ercot.Frequency.Current_Frequency",
    tags: [],
    native_interval_seconds: 60,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "Hz",
    statistic_policy: "gauge",
    source: "ercot_realtime",
    match: "exact",
  },
  {
    key: "storage.charging",
    metric: "ercot.storage.charging_mw",
    tags: ["source:energy_storage"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "energy_storage",
    match: "exact",
  },
  {
    key: "storage.discharging",
    metric: "ercot.storage.discharging_mw",
    tags: ["source:energy_storage"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "energy_storage",
    match: "exact",
  },
  {
    key: "fuel-mix.natural-gas",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:natural_gas", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "fuel-mix.coal-and-lignite",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:coal_and_lignite", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "fuel-mix.nuclear",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:nuclear", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "fuel-mix.power-storage",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:power_storage", "source:fuel_mix"],
    native_interval_seconds: 300,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "fuel_mix",
    match: "exact",
  },
  {
    key: "renewables.wind-forecast",
    metric: "ercot.renewables.forecast_mw",
    tags: ["resource:wind", "source:wind_solar"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "wind_solar",
    match: "exact",
  },
  {
    key: "renewables.wind-hsl",
    metric: "ercot.renewables.hsl_mw",
    tags: ["resource:wind", "source:wind_solar"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "wind_solar",
    match: "exact",
  },
  {
    key: "renewables.solar-forecast",
    metric: "ercot.renewables.forecast_mw",
    tags: ["resource:solar", "source:wind_solar"],
    native_interval_seconds: 3600,
    supported_lods: ["native", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "wind_solar",
    match: "exact",
  },
  {
    key: "generation-outages.total",
    metric: "ercot.generation_outages.total_mw",
    tags: ["source:generation_outages"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "generation_outages",
    match: "exact",
  },
  {
    key: "generation-outages.dispatchable-unplanned",
    metric: "ercot.generation_outages.mw",
    tags: ["category:dispatchable", "outage_type:unplanned", "source:generation_outages"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "generation_outages",
    match: "exact",
  },
  {
    key: "generation-outages.dispatchable-planned",
    metric: "ercot.generation_outages.mw",
    tags: ["category:dispatchable", "outage_type:planned", "source:generation_outages"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "generation_outages",
    match: "exact",
  },
  {
    key: "generation-outages.renewable-unplanned",
    metric: "ercot.generation_outages.mw",
    tags: ["category:renewable", "outage_type:unplanned", "source:generation_outages"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "generation_outages",
    match: "exact",
  },
  {
    key: "generation-outages.renewable-planned",
    metric: "ercot.generation_outages.mw",
    tags: ["category:renewable", "outage_type:planned", "source:generation_outages"],
    native_interval_seconds: 300,
    supported_lods: ["native", "5m", "15m", "1h"],
    rollup: null,
    unit: "MW",
    statistic_policy: "power",
    source: "generation_outages",
    match: "exact",
  },
  {
    key: "pricing.houston",
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_HOUSTON"],
    native_interval_seconds: 900,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "$/MWh",
    statistic_policy: "gauge",
    source: "ercot_pricing",
    match: "exact",
  },
  {
    key: "pricing.north",
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_NORTH"],
    native_interval_seconds: 900,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "$/MWh",
    statistic_policy: "gauge",
    source: "ercot_pricing",
    match: "exact",
  },
  {
    key: "pricing.west",
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_WEST"],
    native_interval_seconds: 900,
    supported_lods: ["native", "15m", "1h"],
    rollup: null,
    unit: "$/MWh",
    statistic_policy: "gauge",
    source: "ercot_pricing",
    match: "exact",
  },
];
export type NativeFixtureValue = (metric: string, index: number, tags?: string[]) => number;

export function nativeFixtureIndex(timestamp: number, now: number, cadence = 300) {
  return 63 + (timestamp - Math.floor((now - 30) / cadence) * cadence) / cadence;
}

export function observedTileFixture(
  path: string,
  now: number,
  value: NativeFixtureValue,
  empty = false,
  inclusiveNow = false,
) {
  const match =
    /^\/api\/v2\/tiles\/([a-z0-9]+(?:[.-][a-z0-9]+)*)\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/.exec(
      path,
    );
  if (!match) throw new Error("unknown_observed_fixture_tile");
  const [, key, span, startText, lod] = match;
  const start = Number(startText),
    end = start + (span === "1d" ? 86400 : 3600);
  const paired = key === pairedCatalogEntry.key;
  const entry = paired
    ? pairedCatalogEntry
    : physicalFixtureCatalog.find((entry) => entry.key === key);
  if (!entry || !entry.supported_lods.some((candidate) => candidate === lod))
    throw new Error("unknown_physical_fixture_tile");
  const cadence = entry.native_interval_seconds;
  const future = entry.metric.includes("forecast") || entry.metric.includes("hsl");
  const availableThrough = future ? now + 7 * 86400 : now - (inclusiveNow ? 0 : 30);
  const step = lod === "native" ? 300 : lod === "5m" ? 300 : lod === "15m" ? 900 : 3600;
  const rows: Array<[number, number]> = [];
  for (
    let ts = Math.ceil(start / cadence) * cadence;
    !empty && ts < end && ts <= availableThrough;
    ts += cadence
  ) {
    const index = nativeFixtureIndex(ts, now, cadence);
    // Same source identity and epoch for both native contributors; subtraction
    // happens here, before any bucket counts, extrema, sums or timestamps.
    const capacity = value(CAPACITY, index),
      demand = value(DEMAND, index);
    const physical = !paired
      ? entry.rollup === "sum"
        ? physicalFixtureCatalog
            .filter(
              (candidate) =>
                candidate.metric === entry.metric &&
                candidate.rollup === null &&
                candidate.tags.some((tag) => tag.startsWith("fuel:")),
            )
            .reduce((sum, candidate) => sum + value(entry.metric, index, candidate.tags), 0)
        : value(entry.metric, index, [...entry.tags])
      : 0;
    rows.push([ts, paired ? capacity - demand : physical]);
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
    native_interval_seconds: cadence,
    rollup: entry.rollup,
    schema: 2,
    series_key: key,
    statistic_policy: entry.statistic_policy,
    tile_end: end,
    tile_span: span,
    tile_start: start,
    unit: entry.unit,
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
  inclusiveNow = false,
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
      series: [...physicalFixtureCatalog, ...(url.search ? [pairedCatalogEntry] : [])].sort(
        (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      ),
    });
  });
  await page.route("**/api/v2/tiles/**", async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, body: "fixture unavailable" });
      return;
    }
    try {
      await fulfill(
        route,
        observedTileFixture(
          new URL(route.request().url()).pathname,
          now,
          value,
          empty,
          inclusiveNow,
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("unknown_")) throw error;
      await route.fulfill({ status: 400, json: { error: error.message } });
    }
  });
}

// Frozen primary06 chart source contracts keep the same fixture independent
// of baseline/candidate production imports. For unverified publication cadence,
// 1800 is fixture spacing only; declared native cadence remains null.
const fallbackFixtureSources = [
  {
    metric: "ercot.supply_demand.demand_mw",
    tags: [],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.supply_demand.forecast_demand_mw",
    tags: [],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: true,
  },
  {
    metric: "ercot.supply_demand.available_capacity_mw",
    tags: [],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.Frequency.Current_Frequency",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "Hz",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.prc",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.regUpAwd",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.regDownAwd",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:natural_gas"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:wind"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:solar"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:coal_and_lignite"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:nuclear"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:power_storage"],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.storage.charging_mw",
    tags: [],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.storage.discharging_mw",
    tags: [],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.storage.net_output_mw",
    tags: [],
    rollup: null,
    cadence: 300,
    declaredCadence: 300,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.renewables.actual_mw",
    tags: ["resource:wind"],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.renewables.forecast_mw",
    tags: ["resource:wind"],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: true,
  },
  {
    metric: "ercot.renewables.hsl_mw",
    tags: ["resource:wind"],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: true,
  },
  {
    metric: "ercot.renewables.actual_mw",
    tags: ["resource:solar"],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.renewables.forecast_mw",
    tags: ["resource:solar"],
    rollup: null,
    cadence: 3600,
    declaredCadence: 3600,
    unit: "MW",
    statisticPolicy: "power",
    forecast: true,
  },
  {
    metric: "ercot.generation_outages.total_mw",
    tags: [],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.generation_outages.mw",
    tags: ["category:dispatchable", "outage_type:unplanned"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.generation_outages.mw",
    tags: ["category:dispatchable", "outage_type:planned"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.generation_outages.mw",
    tags: ["category:renewable", "outage_type:unplanned"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.generation_outages.mw",
    tags: ["category:renewable", "outage_type:planned"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_HOUSTON"],
    rollup: null,
    cadence: 900,
    declaredCadence: 900,
    unit: "$/MWh",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_NORTH"],
    rollup: null,
    cadence: 900,
    declaredCadence: 900,
    unit: "$/MWh",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.pricing",
    tags: ["ercot_region:HB_WEST"],
    rollup: null,
    cadence: 900,
    declaredCadence: 900,
    unit: "$/MWh",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.DC_Tie_Flows",
    tags: ["ercot_dc_tie:DC_E"],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.DC_Tie_Flows",
    tags: ["ercot_dc_tie:DC_N"],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.DC_Tie_Flows",
    tags: ["ercot_dc_tie:DC_S"],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.DC_Tie_Flows",
    tags: ["ercot_dc_tie:DC_L"],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.DC_Tie_Flows",
    tags: ["ercot_dc_tie:DC_R"],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.Real_Time_Data.Total_System_Capacity",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.Real_Time_Data.Actual_System_Demand",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot.Frequency.Instantaneous_Time_Error",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "seconds",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.Real_Time_Data.Current_System_Inertia",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "GW\u00b7s",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.eea_level",
    tags: [],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "level",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.rtReserveOnline",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.rtReserveOnOffline",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.nsrCapOffGen",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "ercot_ancillary.ecrsCapQs",
    tags: [],
    rollup: null,
    cadence: 60,
    declaredCadence: 60,
    unit: "MW",
    statisticPolicy: "power",
    forecast: false,
  },
  {
    metric: "metar.temperature",
    tags: ["metar_code:KDFW"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "\u00b0C",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.temperature",
    tags: ["metar_code:KAUS"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "\u00b0C",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.temperature",
    tags: ["metar_code:KHOU"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "\u00b0C",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.temperature",
    tags: ["metar_code:KSAT"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "\u00b0C",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.winds.speed",
    tags: ["metar_code:KDFW"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "mph",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.winds.speed",
    tags: ["metar_code:KAUS"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "mph",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.winds.speed",
    tags: ["metar_code:KHOU"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "mph",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "metar.winds.speed",
    tags: ["metar_code:KSAT"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "mph",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.app.duty_cycle",
    tags: ["app:ercot_realtime"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "%",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.app.duty_cycle",
    tags: ["app:ercot_ancillary"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "%",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.app.duty_cycle",
    tags: ["app:ercot_pricing"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "%",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.app.duty_cycle",
    tags: ["app:metar"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "%",
    statisticPolicy: "gauge",
    forecast: false,
  },
  {
    metric: "ercot.app.duty_cycle",
    tags: ["app:ercot_eea"],
    rollup: null,
    cadence: 1800,
    declaredCadence: null,
    unit: "%",
    statisticPolicy: "gauge",
    forecast: false,
  },
];

export function physicalFixtureSource(
  metric: string,
  tags: readonly string[],
  rollup: null | "sum" = null,
) {
  const catalog = physicalFixtureCatalog.find(
    (entry) =>
      entry.metric === metric &&
      entry.rollup === rollup &&
      tags.every((tag) => entry.tags.includes(tag)),
  );
  if (catalog)
    return {
      cadence: catalog.native_interval_seconds,
      declaredCadence: catalog.native_interval_seconds,
      tags: catalog.tags,
      unit: catalog.unit,
      statisticPolicy: catalog.statistic_policy,
      forecast: metric.includes("forecast") || metric.includes("hsl"),
      rollup,
    };
  const fallback = fallbackFixtureSources.find(
    (entry) =>
      entry.metric === metric &&
      entry.rollup === rollup &&
      [...tags].sort().join("|") === entry.tags.join("|"),
  );
  return fallback ?? null;
}

export function physicalFixturePoints(
  metric: string,
  tags: string[],
  start: number,
  end: number,
  now: number,
  value: NativeFixtureValue,
  rollup: null | "sum" = null,
  inclusiveNow = false,
) {
  const source = physicalFixtureSource(metric, tags, rollup);
  if (!source) throw new Error("unknown_physical_fixture_source");
  const points: Array<[number, number]> = [];
  const available = source.forecast ? now + 7 * 86400 : now - (inclusiveNow ? 0 : 30);
  for (
    let ts = Math.ceil(start / source.cadence) * source.cadence;
    ts < end && ts <= available;
    ts += source.cadence
  ) {
    const index = nativeFixtureIndex(ts, now, source.cadence);
    const reading =
      rollup === "sum"
        ? physicalFixtureCatalog
            .filter(
              (entry) =>
                entry.metric === metric &&
                entry.rollup === null &&
                entry.tags.some((tag) => tag.startsWith("fuel:")),
            )
            .reduce((sum, entry) => sum + value(metric, index, entry.tags), 0)
        : value(metric, index, source.tags);
    points.push([ts, reading]);
  }
  return { points, source };
}

export async function installPhysicalChunks(
  page: Page,
  now: number,
  value: NativeFixtureValue,
  empty = false,
  unavailable = false,
  requests: string[] = [],
  inclusiveNow = false,
) {
  await page.route("**/api/v1/series/chunk**", async (route) => {
    const url = new URL(route.request().url()),
      params = url.searchParams;
    requests.push(url.toString());
    const metric = params.get("metric") ?? "",
      tags = params.getAll("tag").sort();
    const start = Number(params.get("start")),
      end = Number(params.get("end")),
      resolution = Number(params.get("resolution"));
    const span = Number(params.get("chunk_seconds")),
      aggregation = params.get("aggregation"),
      rollup = params.get("rollup");
    if (
      ![3600, 86400].includes(span) ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      end - start !== span ||
      !Number.isInteger(resolution) ||
      resolution < 1 ||
      !["average", "minmax"].includes(aggregation ?? "") ||
      ![null, "sum"].includes(rollup)
    ) {
      await route.fulfill({ status: 400, json: { error: "invalid_physical_fixture_chunk" } });
      return;
    }
    if (!physicalFixtureSource(metric, tags, rollup as null | "sum")) {
      await route.fulfill({ status: 400, json: { error: "unknown_physical_fixture_source" } });
      return;
    }
    if (unavailable) {
      await route.fulfill({ status: 503, json: { error: "fixture_upstream_unavailable" } });
      return;
    }
    const raw = physicalFixturePoints(
      metric,
      tags,
      start,
      end,
      now,
      value,
      rollup as null | "sum",
      inclusiveNow,
    );
    const groups = new Map<number, Array<[number, number]>>();
    for (const point of empty ? [] : raw.points) {
      const epoch = Math.floor(point[0] / resolution) * resolution;
      const group = groups.get(epoch) ?? [];
      group.push(point);
      groups.set(epoch, group);
    }
    const points = [...groups].flatMap(([epoch, group]) => {
      if (aggregation === "average")
        return [[epoch, group.reduce((sum, point) => sum + point[1], 0) / group.length]];
      const minimum = group.reduce((a, b) => (b[1] < a[1] ? b : a)),
        maximum = group.reduce((a, b) => (b[1] > a[1] ? b : a));
      return minimum === maximum ? [minimum] : [minimum, maximum].sort((a, b) => a[0] - b[0]);
    });
    const payload = {
      aggregation,
      end,
      metric,
      points,
      resolution,
      start,
      tags,
      rollup,
      native_interval_seconds: raw.source.declaredCadence,
      stats: {
        count: empty ? 0 : raw.points.length,
        minimum: empty || !raw.points.length ? null : Math.min(...raw.points.map(([, v]) => v)),
        maximum: empty || !raw.points.length ? null : Math.max(...raw.points.map(([, v]) => v)),
      },
    };
    const body = JSON.stringify(payload),
      etag = `"fixture-${createHash("sha256").update(body).digest("hex")}"`;
    await route.fulfill(
      params && route.request().headers()["if-none-match"] === etag
        ? { status: 304, headers: { ETag: etag } }
        : {
            status: 200,
            body,
            contentType: "application/json",
            headers: { ETag: etag, "Cache-Control": "public,max-age=30,must-revalidate" },
          },
    );
  });
}
