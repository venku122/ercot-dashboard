import { describe, expect, it } from "vitest";

import {
  parseNetLoadDailyResource,
  parseNetLoadManifest,
  parseNetLoadResource,
  type NetLoadDailyLink,
  type NetLoadResourceLink,
} from "./net-load";

const DAY_START = 1_768_435_200;
const CONTENT_VERSION = `v1-${"a".repeat(64)}`;
const SERIES = "net-load.forecast.latest-capped-1h-before-utc-day" as const;
const DAILY_SERIES = "net-load.forecast.latest-capped-1h-before-market-day" as const;

function link(): NetLoadResourceLink {
  return {
    content_version: CONTENT_VERSION,
    day_start: DAY_START,
    lod: "native",
    point_count: 24,
    policy_cutoff: DAY_START - 3_600,
    effective_as_of: DAY_START - 3_600,
    finalized: true,
    series_key: SERIES,
    url: `/api/v2/net-load/${SERIES}/v1/${CONTENT_VERSION}/1d/${DAY_START}/native`,
    valid_point_count: 24,
  };
}

function resource() {
  return {
    complete: true,
    contributors: {
      load: { issued_at: DAY_START - 7_200, retrieved_at: DAY_START - 7_100, vintage_key: "load" },
      solar: {
        issued_at: DAY_START - 7_200,
        retrieved_at: DAY_START - 7_100,
        vintage_key: "solar",
      },
      wind: { issued_at: DAY_START - 7_200, retrieved_at: DAY_START - 7_100, vintage_key: "wind" },
    },
    content_version: CONTENT_VERSION,
    day_end: DAY_START + 86_400,
    day_start: DAY_START,
    description: "Derived forecast net load — HSL-potential basis",
    exclusions: {},
    kind: "net_load_tile",
    lod: "native",
    methodology_version: "v1",
    official_ercot_net_load: false,
    rows: Array.from({ length: 24 }, (_, index) => ({
      demand_mw: 70_000,
      missing_reason: null,
      net_load_mw: 50_000,
      ramp_1h_mw: 1_000,
      ramp_3h_mw: 3_000,
      solar_mw: 5_000,
      storage_net_output_mw: -40_000,
      target_ts: DAY_START + index * 3_600,
      wind_mw: 15_000,
    })),
    schema_version: 1,
    finalized: true,
    policy_cutoff: DAY_START - 3_600,
    selection_policy: "coherent_whole_curve_latest_capped_before_utc_day",
    series_key: SERIES,
    snapshot_lead_seconds: 3_600,
    storage_policy: "context_only_not_in_formula",
  };
}

function dailyLink(): NetLoadDailyLink {
  return {
    complete: true,
    content_version: CONTENT_VERSION,
    delivery_date: "2025-11-02",
    policy_cutoff: DAY_START - 3_600,
    effective_as_of: DAY_START - 3_600,
    finalized: true,
    series_key: DAILY_SERIES,
    url: `/api/v2/net-load-daily/${DAILY_SERIES}/v1/${CONTENT_VERSION}/2025-11-02`,
  };
}

function daily() {
  return {
    complete: true,
    content_version: CONTENT_VERSION,
    daily_ramp: {
      complete_day: true,
      elapsed_seconds: 28_800,
      evening_peak_net_load_mw: 70_000,
      evening_peak_target_ts: 1_762_120_800,
      minimum_net_load_mw: 30_000,
      minimum_target_ts: 1_762_092_000,
      policy: "dashboard_evening_v1",
      ramp_mw: 40_000,
    },
    delivery_date: "2025-11-02",
    kind: "net_load_daily_ramp",
    policy_cutoff: DAY_START - 3_600,
    finalized: true,
    series_key: DAILY_SERIES,
  };
}

describe("independent net-load contract", () => {
  it("preserves half-open ordered rows and never applies storage to the formula", () => {
    const parsed = parseNetLoadResource(resource(), link());
    expect(parsed.rows.slice(0, 2).map((row) => row.target_ts)).toEqual([
      DAY_START,
      DAY_START + 3_600,
    ]);
    expect(parsed.rows.slice(0, 2).map((row) => row.net_load_mw)).toEqual([50_000, 50_000]);
    expect(parsed.rows.slice(0, 2).map((row) => row.storage_net_output_mw)).toEqual([
      -40_000, -40_000,
    ]);

    const atEnd = resource();
    atEnd.rows[1]!.target_ts = DAY_START + 86_400;
    expect(() => parseNetLoadResource(atEnd, link())).toThrow();

    const duplicate = resource();
    duplicate.rows[1]!.target_ts = DAY_START;
    expect(() => parseNetLoadResource(duplicate, link())).toThrow();
  });

  it("rejects formula null-coercion and snapshot-policy masquerading", () => {
    const missingComponent = resource();
    missingComponent.rows[0]!.demand_mw = null as never;
    expect(() => parseNetLoadResource(missingComponent, link())).toThrow();

    const wrongPolicy = resource();
    wrongPolicy.selection_policy = "per_target_1h_horizon";
    expect(() => parseNetLoadResource(wrongPolicy, link())).toThrow();

    const wrongLead = resource();
    wrongLead.snapshot_lead_seconds = 21_600;
    expect(() => parseNetLoadResource(wrongLead, link())).toThrow();

    const futureCapped = resource();
    futureCapped.finalized = false;
    expect(
      parseNetLoadResource(futureCapped, {
        ...link(),
        effective_as_of: DAY_START - 7_000,
        finalized: false,
      }).finalized,
    ).toBe(false);

    const futureLeak = resource();
    futureLeak.finalized = false;
    expect(() =>
      parseNetLoadResource(futureLeak, {
        ...link(),
        effective_as_of: DAY_START,
        finalized: false,
      }),
    ).toThrow();
  });

  it("requires exact canonical manifest paths, not accepted prefixes", () => {
    const manifest = {
      daily_resources: [],
      formula: "demand_mw - wind_mw - solar_mw",
      kind: "net_load_manifest",
      materialization_health: [
        {
          last_attempt_ts: DAY_START - 60,
          last_error_code: null,
          last_success_ts: DAY_START - 60,
          pipeline: "forecast",
          state: "healthy",
        },
      ],
      methodology_version: "v1",
      official_ercot_net_load: false,
      resources: [link()],
      schema_version: 1,
      storage_policy: "context_only_not_in_formula",
    };
    expect(parseNetLoadManifest(manifest).resources).toHaveLength(1);
    expect(parseNetLoadManifest(manifest).materialization_health).toEqual(
      expect.arrayContaining([expect.objectContaining({ pipeline: "forecast", state: "healthy" })]),
    );
    const missingHealth = { ...manifest };
    delete (missingHealth as Partial<typeof manifest>).materialization_health;
    expect(() => parseNetLoadManifest(missingHealth)).toThrow();
    manifest.resources[0]!.url += "/not-canonical";
    expect(() => parseNetLoadManifest(manifest)).toThrow();
  });

  it("accepts the repeated-hour day summary but excludes a 22:00 CT target", () => {
    expect(parseNetLoadDailyResource(daily(), dailyLink()).daily_ramp?.ramp_mw).toBe(40_000);

    const excludedBoundary = daily();
    excludedBoundary.daily_ramp.evening_peak_target_ts = 1_762_142_400;
    expect(() => parseNetLoadDailyResource(excludedBoundary, dailyLink())).toThrow();

    const incomplete = daily();
    incomplete.complete = false;
    incomplete.daily_ramp = null as never;
    expect(
      parseNetLoadDailyResource(incomplete, { ...dailyLink(), complete: false }).daily_ramp,
    ).toBeNull();
    expect(() =>
      parseNetLoadDailyResource(daily(), {
        ...dailyLink(),
        effective_as_of: DAY_START,
        finalized: false,
      }),
    ).toThrow();
  });
});
