import { describe, expect, it } from "vitest";

import {
  HISTORICAL_CONTEXT_POLICY,
  historicalContextAsOf,
  historicalContextResolverUrl,
  parseHistoricalContextResolver,
  type HistoricalContextResolver,
} from "./historical-context";

const AS_OF = 1_800_003_600;
const VERSION = `hc1-${"a".repeat(64)}`;

function coverage(
  state: "partial" | "qualified" | "unavailable" = "qualified",
  intervalEnd = AS_OF,
) {
  if (state === "qualified")
    return {
      state,
      expected_count: 12,
      observed_count: 12,
      ratio: 1,
      first_observed_at: intervalEnd - 3_600,
      last_observed_at: intervalEnd - 300,
    };
  if (state === "partial")
    return {
      state,
      expected_count: 12,
      observed_count: 9,
      ratio: 0.75,
      first_observed_at: intervalEnd - 3_600,
      last_observed_at: intervalEnd - 1_200,
    };
  return {
    state,
    expected_count: 12,
    observed_count: 0,
    ratio: 0,
    first_observed_at: null,
    last_observed_at: null,
  };
}

function point(value: number, timestamp: number) {
  return { value, timestamp };
}

export function historicalContextFixture(): HistoricalContextResolver {
  const end = AS_OF;
  const extrema = (window: "7d" | "30d" | "365d" | "since_collection", start: number) => ({
    window,
    state: "qualified" as const,
    start,
    end,
    minimum: point(61_000, start + 300),
    maximum: point(78_000, end - 300),
    coverage: {
      expected_count: 84,
      observed_count: 84,
      ratio: 1,
      first_observed_at: start + 300,
      last_observed_at: end - 300,
    },
  });
  return {
    schema: 1,
    policy: HISTORICAL_CONTEXT_POLICY,
    state: "available",
    summary: {
      schema: 1,
      policy: HISTORICAL_CONTEXT_POLICY,
      methodology: "v1",
      series_key: "supply-demand.demand",
      unit: "MW",
      statistic: "maximum_observed_5m_demand",
      time_basis: "America/Chicago civil hour; fall 01 combines both folds",
      as_of: AS_OF,
      selected_hour: {
        market_date: "2027-01-15",
        local_hour: 2,
        start: AS_OF - 3_600,
        end: AS_OF,
        occurrence_count: 1,
        utc_intervals: [{ start: AS_OF - 3_600, end: AS_OF }],
        coverage: coverage(),
        value: point(75_000, AS_OF - 300),
      },
      comparisons: {
        previous_day: {
          state: "available",
          reason: null,
          market_date: "2027-01-14",
          local_hour: 2,
          utc_intervals: [{ start: AS_OF - 86_400 - 3_600, end: AS_OF - 86_400 }],
          coverage: coverage("qualified", AS_OF - 86_400),
          value: point(73_000, AS_OF - 86_400 - 300),
        },
        previous_week: {
          state: "partial",
          reason: "insufficient_coverage",
          market_date: "2027-01-08",
          local_hour: 2,
          utc_intervals: [{ start: AS_OF - 7 * 86_400 - 3_600, end: AS_OF - 7 * 86_400 }],
          coverage: coverage("partial", AS_OF - 7 * 86_400),
          value: null,
        },
        previous_year: {
          state: "unavailable",
          reason: "insufficient_coverage",
          market_date: "2026-01-15",
          local_hour: 2,
          utc_intervals: [{ start: AS_OF - 365 * 86_400 - 3_600, end: AS_OF - 365 * 86_400 }],
          coverage: coverage("unavailable", AS_OF - 365 * 86_400),
          value: null,
        },
      },
      seasonal_local_hour_percentiles: {
        state: "available",
        reason: null,
        season: "DJF",
        local_hour: 2,
        lookback_completed_local_dates: 400,
        method: "type7",
        unit: "MW",
        qualification_threshold: 0.8,
        eligible_date_count: 50,
        sample_count: 45,
        excluded_date_count: 5,
        first_cohort_date: "2026-01-01",
        last_cohort_date: "2027-01-14",
        p10: 61_000,
        p50: 70_000,
        p90: 79_000,
      },
      completed_day_peak_rank: {
        state: "available",
        reason: null,
        market_date: "2027-01-14",
        window_days: 365,
        rank: 3,
        denominator: 365,
        cohort_start_date: "2026-01-15",
        cohort_end_date: "2027-01-14",
        qualification_threshold: 0.8,
        unit: "MW",
        expected_date_count: 365,
        qualified_prior_count: 364,
        excluded_prior_count: 0,
        observed_prior_summary_count: 364,
        ties: "competition",
        peak: point(78_500, AS_OF - 86_400),
        coverage: coverage("qualified", AS_OF - 86_400),
      },
      observed_extrema: {
        "7d": extrema("7d", AS_OF - 7 * 86_400),
        "30d": extrema("30d", AS_OF - 30 * 86_400),
        "365d": extrema("365d", AS_OF - 365 * 86_400),
        since_collection: extrema("since_collection", AS_OF - 500 * 86_400),
      },
      retention: {
        observed_start: AS_OF - 500 * 86_400,
        observed_end: AS_OF - 300,
        backfill_complete: true,
      },
    },
    resource: {
      content_version: VERSION,
      url: `/api/v2/historical-context/supply-demand.demand/v1/${VERSION}/${String(AS_OF)}`,
    },
  };
}

describe("PR20 historical context strict frontend contract", () => {
  it("accepts the exact embedded resolver and canonical hour URL", () => {
    const fixture = historicalContextFixture();
    expect(parseHistoricalContextResolver(fixture)).toEqual(fixture);
    expect(historicalContextAsOf(AS_OF + 3_599)).toBe(AS_OF);
    expect(historicalContextResolverUrl(AS_OF)).toBe(
      `/api/v1/historical-context?series_key=supply-demand.demand&as_of=${String(AS_OF)}`,
    );
  });

  it("rejects extra keys, wrong identities, incoherent coverage, and poisoned resource URLs", () => {
    for (const poison of [
      (item: Record<string, unknown>) => Object.assign(item, { extra: true }),
      (item: Record<string, unknown>) =>
        Object.assign(item["summary"] as Record<string, unknown>, {
          series_key: "pricing.houston",
        }),
      (item: Record<string, unknown>) =>
        Object.assign(
          (
            (item["summary"] as Record<string, unknown>)["selected_hour"] as Record<string, unknown>
          )["coverage"] as Record<string, unknown>,
          { ratio: 0.5 },
        ),
      (item: Record<string, unknown>) =>
        Object.assign(item["resource"] as Record<string, unknown>, { url: "/api/v2/other" }),
      (item: Record<string, unknown>) =>
        Object.assign(
          (
            (item["summary"] as Record<string, unknown>)["selected_hour"] as Record<string, unknown>
          )["value"] as Record<string, unknown>,
          { timestamp: AS_OF + 300 },
        ),
      (item: Record<string, unknown>) =>
        Object.assign(
          (item["summary"] as Record<string, unknown>)["selected_hour"] as Record<string, unknown>,
          { market_date: "2027-01-14" },
        ),
      (item: Record<string, unknown>) =>
        Object.assign(
          (item["summary"] as Record<string, unknown>)["seasonal_local_hour_percentiles"] as Record<
            string,
            unknown
          >,
          { season: "JJA" },
        ),
    ]) {
      const candidate = structuredClone(historicalContextFixture()) as unknown as Record<
        string,
        unknown
      >;
      poison(candidate);
      expect(() => parseHistoricalContextResolver(candidate)).toThrow();
    }
  });

  it("keeps partial and unavailable states distinct", () => {
    const partial = structuredClone(historicalContextFixture());
    partial.state = "partial";
    partial.summary.selected_hour.coverage = coverage("partial");
    partial.summary.selected_hour.value = null;
    expect(parseHistoricalContextResolver(partial).state).toBe("partial");

    const unavailable = structuredClone(historicalContextFixture());
    unavailable.state = "unavailable";
    unavailable.summary.selected_hour.coverage = coverage("unavailable");
    unavailable.summary.selected_hour.value = null;
    expect(parseHistoricalContextResolver(unavailable).state).toBe("unavailable");
  });
});
