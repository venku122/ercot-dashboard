import type { Page } from "@playwright/test";

const DAY_START = 1_787_011_200;
const VERSION = `rg1-${"a".repeat(64)}`;
const TAXONOMIES = {
  load: [
    "coast",
    "east",
    "far-west",
    "north",
    "north-central",
    "south-central",
    "southern",
    "west",
  ],
  wind: ["panhandle", "coastal", "south", "west", "north"],
  solar: ["center-west", "north-west", "far-west", "far-east", "south-east", "center-east"],
} as const;

function seriesKey(mode: keyof typeof TAXONOMIES, region: string) {
  return mode === "load"
    ? `regional.load.weather-zone.${region}.actual`
    : `regional.${mode}.${region}.hourly`;
}

function currentPoint(mode: keyof typeof TAXONOMIES, region: string, index: number) {
  const common = {
    region,
    current_target_ts: DAY_START + 3_600,
    current_mw: 1_000 + index,
    share_percent: 10 + index,
    change_1h_mw: index === 0 ? null : 50 + index,
  };
  return mode === "load"
    ? {
        ...common,
        forecast_mw: 950 + index,
        forecast_error_mw: 50,
        forecast_horizon_seconds: 3_600,
      }
    : {
        ...common,
        forecast_error_available: false,
        forecast_error_unavailable_reason:
          "generation_is_curtailment_affected_forecast_targets_hsl",
        next_24h_forecast_peak: { target_ts: DAY_START + 7_200, forecast_mw: 2_000 + index },
      };
}

export async function installRegionalGeographyApi(page: Page, requests: string[]) {
  await page.route("**/api/v1/regional-geography", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: {
        schema_version: 1,
        kind: "regional_geography_manifest",
        methodology: "v1",
        title: "ERCOT region schematic — not geographic boundaries",
        taxonomies: TAXONOMIES,
        deferred_products: ["NP4-743-CD", "NP4-746-CD"],
        current: {
          load: {
            availability: "available",
            regions: TAXONOMIES.load.map((region, index) => currentPoint("load", region, index)),
            source: {
              source_id: "ercot_public_np6_345_weather_zone_actual_load",
              observed_at: DAY_START + 3_600,
              retrieved_at: DAY_START + 3_660,
            },
          },
          wind: {
            availability: "available",
            regions: TAXONOMIES.wind.map((region, index) => currentPoint("wind", region, index)),
            source: {
              source_id: "ercot_mis_np4_742",
              vintage_key: `rgv1-${"b".repeat(64)}`,
              issued_at: DAY_START,
              retrieved_at: DAY_START + 60,
            },
          },
          solar: {
            availability: "available",
            regions: TAXONOMIES.solar.map((region, index) => currentPoint("solar", region, index)),
            source: {
              source_id: "ercot_mis_np4_745",
              vintage_key: `rgv1-${"c".repeat(64)}`,
              issued_at: DAY_START,
              retrieved_at: DAY_START + 60,
            },
          },
        },
        source_health: [
          {
            source_id: "ercot_public_np6_345_weather_zone_actual_load",
            state: "healthy",
            data_age_seconds: 60,
            last_success_ts: DAY_START + 60,
          },
          {
            source_id: "ercot_mis_np4_742",
            state: "stale",
            data_age_seconds: 10_800,
            last_success_ts: DAY_START + 60,
          },
          {
            source_id: "ercot_mis_np4_745",
            state: "healthy",
            data_age_seconds: 60,
            last_success_ts: DAY_START + 60,
          },
        ],
        materialization_health: {
          pipeline: "load",
          state: "healthy",
          last_attempt_ts: DAY_START,
          last_success_ts: DAY_START,
          consecutive_failures: 0,
          last_error: null,
        },
        resources: (Object.keys(TAXONOMIES) as Array<keyof typeof TAXONOMIES>).flatMap((mode) =>
          TAXONOMIES[mode].flatMap((region) => {
            const keys =
              mode === "load"
                ? [
                    `regional.load.weather-zone.${region}.actual`,
                    `regional.load.weather-zone.${region}.forecast`,
                  ]
                : [seriesKey(mode, region)];
            return keys.map((key) => ({
              series_key: key,
              tile_start: DAY_START,
              content_version: VERSION,
              lod: "native",
              url: `/api/v2/regional/${key}/v1/${VERSION}/1d/${DAY_START}/native`,
            }));
          }),
        ),
      },
    });
  });
  await page.route("**/api/v2/regional/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const match = /^\/api\/v2\/regional\/(.+)\/v1\/(rg1-[a-f0-9]{64})\/1d\/(\d+)\/native$/.exec(
      path,
    )!;
    const key = match[1]!;
    const renewable = /^regional\.(wind|solar)\.([a-z-]+)\.hourly$/.exec(key);
    const load = /^regional\.load\.weather-zone\.([a-z-]+)\.(actual|forecast)$/.exec(key);
    const kind = renewable ? renewable[1]! : "load";
    const region = renewable ? renewable[2]! : load![1]!;
    const values = [
      [1_200, 12, 100, 1_400, -200],
      [1_250, 13, 50, 1_500, -250],
      [1_300, 14, 50, 1_550, -250],
      [null, null, null, null, null],
      [1_350, 15, null, 1_600, -250],
      [1_400, 16, 50, 1_650, -250],
    ] as const;
    const rows = values.map(([current, share, change, forecast, error], index) => ({
      target_ts: DAY_START + (index + 1) * 3_600,
      current_mw: load?.[2] === "forecast" ? null : current,
      share_percent: share,
      change_1h_mw: load?.[2] === "forecast" ? null : change,
      forecast_mw: load?.[2] === "actual" ? null : forecast,
      forecast_error_mw: load?.[2] === "forecast" ? error : null,
    }));
    return route.fulfill({
      headers: { ETag: `"${VERSION}"` },
      json: {
        schema_version: 1,
        methodology: "v1",
        series_key: key,
        content_version: VERSION,
        kind,
        region,
        tile_span: "1d",
        tile_start: DAY_START,
        tile_end: DAY_START + 86_400,
        lod: "native",
        native_interval_seconds: 3_600,
        unit: "MW",
        forecast_error_available: renewable ? false : true,
        forecast_error_unavailable_reason: renewable
          ? "generation_is_curtailment_affected_forecast_targets_hsl"
          : null,
        source: {
          vintage_key: `rgv1-${"d".repeat(64)}`,
          issued_at: DAY_START,
          retrieved_at: DAY_START + 60,
        },
        rows,
      },
    });
  });
}
