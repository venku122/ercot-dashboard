import { describe, expect, it } from "vitest";

import { chartDefinitions } from "./chart-config";
import {
  canonicalTileUrl,
  parseTileCatalog,
  planTileRequests,
  resolveTileSeries,
  selectTileLod,
  type TileCatalog,
  type TileCatalogSeries,
} from "./tile-planner";

const HOUR = 3_600;
const DAY = 86_400;

function entry(
  overrides: Partial<TileCatalogSeries> & Pick<TileCatalogSeries, "key" | "metric">,
): TileCatalogSeries {
  return {
    match: "exact",
    native_interval_seconds: 300,
    rollup: null,
    source: "fixture",
    statistic_policy: "power",
    supported_lods: ["native", "5m", "15m", "1h"],
    tags: ["source:fixture"],
    unit: "MW",
    ...overrides,
  };
}

function catalog(series = [entry({ key: "fixture.power", metric: "fixture.power" })]): TileCatalog {
  return parseTileCatalog({
    boundary_policy: {
      coarse_partial_clipping: false,
      edge_lod: "native",
      rule: "native edges",
    },
    lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": 3_600 },
    schema: 2,
    series: [...series].sort((left, right) => left.key.localeCompare(right.key)),
    tile_spans: { "1d": DAY, "1h": HOUR },
  });
}

describe("semantic tile catalog resolution", () => {
  it("resolves config tags as a stable subset of the server exact identity", () => {
    const source = catalog([
      entry({
        key: "fuel-mix.wind",
        metric: "ercot.fuel_mix.generation_mw",
        tags: ["fuel:wind", "source:fuel_mix"],
      }),
      entry({
        key: "fuel-mix.solar",
        metric: "ercot.fuel_mix.generation_mw",
        tags: ["fuel:solar", "source:fuel_mix"],
      }),
    ]);

    expect(
      resolveTileSeries(source, {
        metric: "ercot.fuel_mix.generation_mw",
        statisticPolicy: "power",
        tags: ["fuel:wind"],
        unit: "MW",
      })?.key,
    ).toBe("fuel-mix.wind");
    expect(
      resolveTileSeries(source, {
        metric: "ercot.fuel_mix.generation_mw",
        statisticPolicy: "power",
        unit: "MW",
      }),
    ).toBeNull();
  });

  it("golden-maps all 26 core physical chart series to server semantic keys", () => {
    const definitions = [
      entry({
        key: "supply-demand.demand",
        metric: "ercot.supply_demand.demand_mw",
        tags: ["source:supply_demand"],
      }),
      entry({
        key: "supply-demand.forecast-demand",
        metric: "ercot.supply_demand.forecast_demand_mw",
        native_interval_seconds: 3_600,
        supported_lods: ["native", "1h"],
        tags: ["source:supply_demand"],
      }),
      entry({
        key: "supply-demand.available-capacity",
        metric: "ercot.supply_demand.available_capacity_mw",
        tags: ["source:supply_demand"],
      }),
      entry({
        key: "frequency.system",
        metric: "ercot.Frequency.Current_Frequency",
        native_interval_seconds: 60,
        statistic_policy: "gauge",
        tags: [],
        unit: "Hz",
      }),
      ...(["charging", "discharging", "net-output"] as const).map((name) =>
        entry({
          key: `storage.${name}`,
          metric: `ercot.storage.${name.replace("-", "_")}_mw`,
          tags: ["source:energy_storage"],
        }),
      ),
      ...(
        [
          ["natural-gas", "natural_gas"],
          ["wind", "wind"],
          ["solar", "solar"],
          ["coal", "coal_and_lignite"],
          ["nuclear", "nuclear"],
          ["power-storage", "power_storage"],
        ] as const
      ).map(([key, tag]) =>
        entry({
          key: `fuel-mix.${key === "coal" ? "coal-and-lignite" : key}`,
          metric: "ercot.fuel_mix.generation_mw",
          supported_lods: ["native", "15m", "1h"],
          tags: [`fuel:${tag}`, "source:fuel_mix"],
        }),
      ),
      ...(
        [
          ["wind-actual", "actual", "wind"],
          ["wind-forecast", "forecast", "wind"],
          ["wind-hsl", "hsl", "wind"],
          ["solar-actual", "actual", "solar"],
          ["solar-forecast", "forecast", "solar"],
        ] as const
      ).map(([key, metric, resource]) =>
        entry({
          key: `renewables.${key}`,
          metric: `ercot.renewables.${metric}_mw`,
          native_interval_seconds: 3_600,
          supported_lods: ["native", "1h"],
          tags: [`resource:${resource}`, "source:wind_solar"],
        }),
      ),
      entry({
        key: "generation-outages.total",
        metric: "ercot.generation_outages.total_mw",
        tags: ["source:generation_outages"],
      }),
      ...(
        [
          ["dispatchable-unplanned", "dispatchable", "unplanned"],
          ["dispatchable-planned", "dispatchable", "planned"],
          ["renewable-unplanned", "renewable", "unplanned"],
          ["renewable-planned", "renewable", "planned"],
        ] as const
      ).map(([key, category, outageType]) =>
        entry({
          key: `generation-outages.${key}`,
          metric: "ercot.generation_outages.mw",
          tags: [
            `category:${category}`,
            `outage_type:${outageType}`,
            "source:generation_outages",
          ].sort(),
        }),
      ),
      ...(
        [
          ["houston", "HB_HOUSTON"],
          ["north", "HB_NORTH"],
          ["west", "HB_WEST"],
        ] as const
      ).map(([name, region]) =>
        entry({
          key: `pricing.${name}`,
          metric: "ercot.pricing",
          native_interval_seconds: 900,
          statistic_policy: "gauge",
          supported_lods: ["native", "15m", "1h"],
          tags: [`ercot_region:${region}`],
          unit: "$/MWh",
        }),
      ),
    ];
    const source = catalog(definitions);
    const expected = new Map<string, string>([
      ["supply-demand:demand", "supply-demand.demand"],
      ["supply-demand:forecast-demand", "supply-demand.forecast-demand"],
      ["supply-demand:available-capacity", "supply-demand.available-capacity"],
      ["frequency:frequency", "frequency.system"],
      ["storage:charging", "storage.charging"],
      ["storage:discharging", "storage.discharging"],
      ["storage:net-output", "storage.net-output"],
      ["fuel-mix:natural-gas", "fuel-mix.natural-gas"],
      ["fuel-mix:wind", "fuel-mix.wind"],
      ["fuel-mix:solar", "fuel-mix.solar"],
      ["fuel-mix:coal", "fuel-mix.coal-and-lignite"],
      ["fuel-mix:nuclear", "fuel-mix.nuclear"],
      ["fuel-mix:power-storage", "fuel-mix.power-storage"],
      ["renewables:wind-actual", "renewables.wind-actual"],
      ["renewables:wind-forecast", "renewables.wind-forecast"],
      ["renewables:wind-hsl", "renewables.wind-hsl"],
      ["renewables:solar-actual", "renewables.solar-actual"],
      ["renewables:solar-forecast", "renewables.solar-forecast"],
      ["generation-outages:total", "generation-outages.total"],
      ["generation-outages:dispatchable-unplanned", "generation-outages.dispatchable-unplanned"],
      ["generation-outages:dispatchable-planned", "generation-outages.dispatchable-planned"],
      ["generation-outages:renewable-unplanned", "generation-outages.renewable-unplanned"],
      ["generation-outages:renewable-planned", "generation-outages.renewable-planned"],
      ["pricing:houston", "pricing.houston"],
      ["pricing:north", "pricing.north"],
      ["pricing:west", "pricing.west"],
    ]);
    const resolved = new Map<string, string>();
    for (const chart of chartDefinitions) {
      for (const series of chart.series) {
        if (!series.metric) continue;
        const match = resolveTileSeries(source, {
          metric: series.metric,
          ...(series.rollup ? { rollup: series.rollup } : {}),
          statisticPolicy: chart.statisticPolicy,
          ...(series.tags ? { tags: series.tags } : {}),
          unit: chart.unit,
        });
        if (match) resolved.set(`${chart.id}:${series.id}`, match.key);
      }
    }
    expect(resolved).toEqual(expected);
    expect(resolved.size).toBe(26);
  });

  it("rejects malformed, duplicate, or unsorted catalog authority", () => {
    const value = catalog();
    expect(() => parseTileCatalog({ ...value, schema: 3 })).toThrow("invalid_tile_catalog");
    expect(() =>
      parseTileCatalog({ ...value, series: [...value.series, value.series[0]] }),
    ).toThrow("invalid_tile_catalog_series");
    expect(() =>
      parseTileCatalog({
        ...value,
        series: [{ ...value.series[0], tags: ["z", "a"] }],
      }),
    ).toThrow("invalid_tile_catalog_series");
  });
});

describe("deterministic tile planning", () => {
  it.each([
    ["1h", HOUR, "native"],
    ["6h", 6 * HOUR, "native"],
    ["12h", 12 * HOUR, "native"],
    ["24h", DAY, "native"],
    ["3d", 3 * DAY, "native"],
    ["7d", 7 * DAY, "15m"],
    ["30d", 30 * DAY, "1h"],
    ["90d", 90 * DAY, "1h"],
    ["12mo", 365 * DAY, "1h"],
  ] as const)("selects only the fixed LOD vocabulary for %s", (_label, range, expected) => {
    const source = catalog();
    expect(selectTileLod(source, source.series[0]!, range)).toBe(expected);
  });

  it.each([
    [60, ["native", "5m", "15m", "1h"]],
    [300, ["native", "5m", "15m", "1h"]],
    [900, ["native", "15m", "1h"]],
    [3_600, ["native", "1h"]],
  ] as const)("honors %ss native cadence and supported LODs", (native, supported) => {
    const source = catalog([
      entry({
        key: `fixture.${native}`,
        metric: `fixture.${native}`,
        native_interval_seconds: native,
        supported_lods: [...supported],
      }),
    ]);
    expect(selectTileLod(source, source.series[0]!, 30 * DAY)).toBe(
      native === 3_600 ? "native" : "1h",
    );
    expect(supported).toContain(selectTileLod(source, source.series[0]!, 6 * HOUR));
  });

  it("uses sealed UTC days, correction-horizon hours, and covers the inclusive end", () => {
    const source = catalog();
    const now = 102 * DAY;
    const requests = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now,
      start: 99 * DAY,
      end: 101 * DAY,
    });

    expect(requests[0]).toMatchObject({ tileSpan: "1d", tileStart: 99 * DAY });
    expect(requests.filter((request) => request.tileSpan === "1d")).toHaveLength(2);
    expect(requests.filter((request) => request.tileSpan === "1h")).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({
      tileEnd: 101 * DAY + HOUR,
      tileSpan: "1h",
      tileStart: 101 * DAY,
    });
    expect(new Set(requests.map((request) => request.url)).size).toBe(requests.length);
  });

  it("switches exactly at the correction horizon boundary", () => {
    const source = catalog();
    const now = 200 * DAY;
    const requests = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now,
      start: 198 * DAY,
      end: 199 * DAY,
    });
    expect(requests[0]?.tileSpan).toBe("1d");
    expect(requests[1]).toMatchObject({ tileSpan: "1h", tileStart: 199 * DAY });
  });

  it("uses native boundary tiles and coarse aligned interiors", () => {
    const source = catalog();
    const start = 100 * DAY + 60;
    const end = start + 7 * DAY;
    const requests = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now: 200 * DAY,
      start,
      end,
    });
    expect(requests[0]?.lod).toBe("native");
    expect(requests.at(-1)?.lod).toBe("native");
    expect(requests.slice(1, -1).every((request) => request.lod === "15m")).toBe(true);
  });

  it.each([
    ["spring-forward", "2026-03-08T00:00:00Z"],
    ["fall-back repeated hour", "2026-11-01T00:00:00Z"],
  ])("is UTC-epoch deterministic across the %s date", (_label, isoStart) => {
    const source = catalog();
    const start = Date.parse(isoStart) / 1_000;
    const requests = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now: start + 10 * DAY,
      start,
      end: start + DAY,
    });
    expect(requests.every((request) => request.tileStart % DAY === 0)).toBe(true);
    expect(requests.map((request) => request.tileStart)).toEqual([start, start + DAY]);
  });

  it("keeps shared series/day/LOD URLs byte-identical without range identity", () => {
    const source = catalog();
    const sharedDay = 100 * DAY;
    const first = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now: 200 * DAY,
      start: sharedDay - DAY,
      end: sharedDay + DAY,
    });
    const second = planTileRequests({
      catalog: source,
      entry: source.series[0]!,
      now: 200 * DAY,
      start: sharedDay,
      end: sharedDay + 2 * DAY,
    });
    const shared = first.find((request) => request.tileStart === sharedDay)!;
    expect(second.find((request) => request.tileStart === sharedDay)?.url).toBe(shared.url);
    expect(shared.url).toBe(canonicalTileUrl("fixture.power", "1d", sharedDay, shared.lod));
    expect(shared.url).not.toContain("range");
    expect(shared.url).not.toContain("resolution");
    expect(shared.url).not.toContain("?");
  });
});
