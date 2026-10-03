import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadRegionalResource,
  parseRegionalManifest,
  type RegionalResourceLink,
} from "./regional-geography";

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
};

type ManifestFixture = {
  schema_version: number;
  kind: string;
  methodology: string;
  title: string;
  taxonomies: Record<"load" | "wind" | "solar", string[]>;
  deferred_products: string[];
  current: Record<
    "load" | "wind" | "solar",
    { availability: string; regions: Array<Record<string, unknown>> }
  >;
  source_health: Array<Record<string, unknown>>;
  materialization_health?: Record<string, unknown>;
  resources: Array<Record<string, unknown>>;
};

function manifest(): ManifestFixture {
  return {
    schema_version: 1,
    kind: "regional_geography_manifest",
    methodology: "v1",
    title: "ERCOT region schematic — not geographic boundaries",
    taxonomies: TAXONOMIES,
    deferred_products: ["NP4-743-CD", "NP4-746-CD"],
    current: {
      load: { availability: "unavailable", regions: [] },
      wind: { availability: "unavailable", regions: [] },
      solar: { availability: "unavailable", regions: [] },
    },
    source_health: [],
    materialization_health: {
      pipeline: "load",
      state: "healthy",
      last_attempt_ts: DAY_START,
      last_success_ts: DAY_START,
      consecutive_failures: 0,
      last_error: null,
    },
    resources: [],
  };
}

function renewablePoint(region: string) {
  return {
    region,
    current_mw: 10,
    share_percent: 20,
    change_1h_mw: 1,
    next_24h_forecast_peak: { target_ts: 1_787_040_000, forecast_mw: 15 },
    forecast_error_available: false,
    forecast_error_unavailable_reason: "generation_is_curtailment_affected_forecast_targets_hsl",
  };
}

const DAY_START = 1_787_011_200;
const VERSION = `rg1-${"a".repeat(64)}`;
const LINK: RegionalResourceLink = {
  series_key: "regional.wind.panhandle.hourly",
  tile_start: DAY_START,
  content_version: VERSION,
  lod: "native",
  url: `/api/v2/regional/regional.wind.panhandle.hourly/v1/${VERSION}/1d/${DAY_START}/native`,
};

afterEach(() => vi.unstubAllGlobals());

describe("regional geography independent wire acceptance", () => {
  it("accepts the exact valid-empty manifest", () => {
    const parsed = parseRegionalManifest(manifest());
    expect(parsed.current.load).toEqual({ availability: "unavailable", regions: [] });
    expect(parsed.resources).toEqual([]);
  });

  it("rejects a manifest that omits required materialization health", () => {
    const value = manifest();
    delete value.materialization_health;
    expect(() => parseRegionalManifest(value)).toThrow();
  });

  it("rejects duplicate region rows and unrecognized availability states", () => {
    const duplicate = manifest();
    duplicate.current.wind = {
      availability: "available",
      regions: [...TAXONOMIES.wind.map(renewablePoint), renewablePoint("panhandle")],
    };
    expect(() => parseRegionalManifest(duplicate)).toThrow();

    const inventedState = manifest();
    inventedState.current.wind = {
      availability: "looks-good-to-me",
      regions: TAXONOMIES.wind.map(renewablePoint),
    };
    expect(() => parseRegionalManifest(inventedState)).toThrow();
  });

  it("rejects canonical-looking links for invented regions", () => {
    const value = manifest();
    const invented = {
      ...LINK,
      series_key: "regional.wind.invented.hourly",
      url: `/api/v2/regional/regional.wind.invented.hourly/v1/${VERSION}/1d/${DAY_START}/native`,
    };
    value.resources = [invented];
    expect(() => parseRegionalManifest(value)).toThrow();
  });

  it("binds resource kind, region, tile bounds, and renewable-error semantics to its link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schema_version: 1,
              methodology: "v1",
              series_key: LINK.series_key,
              content_version: LINK.content_version,
              kind: "solar",
              region: "center-west",
              tile_span: "1d",
              tile_start: LINK.tile_start,
              tile_end: LINK.tile_start + 86_400,
              lod: "native",
              native_interval_seconds: 3_600,
              unit: "MW",
              forecast_error_available: true,
              forecast_error_unavailable_reason: null,
              source: { vintage_key: `rgv1-${"b".repeat(64)}`, issued_at: 1, retrieved_at: 2 },
              rows: [
                {
                  target_ts: LINK.tile_start + 86_400,
                  current_mw: 10,
                  share_percent: 20,
                  change_1h_mw: 1,
                  forecast_mw: 15,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(loadRegionalResource(LINK)).rejects.toThrow("invalid_regional_resource");
  });

  it("binds a load resource to the exact weather zone in its canonical link", async () => {
    const link: RegionalResourceLink = {
      ...LINK,
      series_key: "regional.load.weather-zone.coast.actual",
      url: `/api/v2/regional/regional.load.weather-zone.coast.actual/v1/${VERSION}/1d/${DAY_START}/native`,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              schema_version: 1,
              methodology: "v1",
              series_key: link.series_key,
              content_version: link.content_version,
              kind: "load",
              region: "west",
              tile_span: "1d",
              tile_start: link.tile_start,
              tile_end: link.tile_start + 86_400,
              lod: "native",
              native_interval_seconds: 3_600,
              unit: "MW",
              rows: [
                {
                  target_ts: link.tile_start + 3_600,
                  current_mw: 10,
                  share_percent: 20,
                  change_1h_mw: null,
                  forecast_mw: null,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(loadRegionalResource(link)).rejects.toThrow("invalid_regional_resource");
  });

  it("rejects non-null fields from the opposite load resource flavor", async () => {
    for (const flavor of ["actual", "forecast"] as const) {
      const link: RegionalResourceLink = {
        ...LINK,
        series_key: `regional.load.weather-zone.coast.${flavor}`,
        url: `/api/v2/regional/regional.load.weather-zone.coast.${flavor}/v1/${VERSION}/1d/${DAY_START}/native`,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                schema_version: 1,
                methodology: "v1",
                series_key: link.series_key,
                content_version: link.content_version,
                kind: "load",
                region: "coast",
                tile_span: "1d",
                tile_start: link.tile_start,
                tile_end: link.tile_start + 86_400,
                lod: "native",
                native_interval_seconds: 3_600,
                unit: "MW",
                rows: [
                  {
                    target_ts: link.tile_start + 3_600,
                    current_mw: 10,
                    share_percent: 20,
                    change_1h_mw: 1,
                    forecast_mw: 15,
                    forecast_error_mw: -5,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        ),
      );
      await expect(loadRegionalResource(link)).rejects.toThrow("invalid_regional_resource_flavor");
    }
  });
});
