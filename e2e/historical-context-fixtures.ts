import type { Page } from "@playwright/test";

const VERSION = `hc1-${"a".repeat(64)}`;
const POLICY = "collection_history_season_and_local_hour_context_not_forecast_or_all_time_record";

function coverage(
  intervalEnd: number,
  state: "qualified" | "partial" | "unavailable" = "qualified",
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

export function historicalContextFixture(asOf: number) {
  const point = (value: number, timestamp = asOf - 300) => ({ value, timestamp });
  const extrema = (window: "7d" | "30d" | "365d" | "since_collection", days: number) => ({
    window,
    state: days === 365 ? "partial" : "qualified",
    start: asOf - days * 86_400,
    end: asOf,
    minimum: point(61_200, asOf - days * 86_400 + 300),
    maximum: point(78_400),
    coverage: {
      expected_count: days * 288,
      observed_count: days * 285,
      ratio: 285 / 288,
      first_observed_at: asOf - days * 86_400 + 300,
      last_observed_at: asOf - 300,
    },
  });
  const summary = {
    schema: 1,
    policy: POLICY,
    methodology: "v1",
    series_key: "supply-demand.demand",
    unit: "MW",
    statistic: "maximum_observed_5m_demand",
    time_basis: "America/Chicago civil hour; fall 01 combines both folds",
    as_of: asOf,
    selected_hour: {
      market_date: "2026-07-21",
      local_hour: 17,
      start: asOf - 3_600,
      end: asOf,
      occurrence_count: 1,
      utc_intervals: [{ start: asOf - 3_600, end: asOf }],
      coverage: coverage(asOf),
      value: point(75_250),
    },
    comparisons: {
      previous_day: {
        state: "available",
        reason: null,
        market_date: "2026-07-20",
        local_hour: 17,
        utc_intervals: [{ start: asOf - 90_000, end: asOf - 86_400 }],
        coverage: coverage(asOf - 86_400),
        value: point(73_100, asOf - 86_700),
      },
      previous_week: {
        state: "partial",
        reason: "insufficient_coverage",
        market_date: "2026-07-14",
        local_hour: 17,
        utc_intervals: [{ start: asOf - 608_400, end: asOf - 604_800 }],
        coverage: coverage(asOf - 604_800, "partial"),
        value: null,
      },
      previous_year: {
        state: "unavailable",
        reason: "insufficient_coverage",
        market_date: "2025-07-21",
        local_hour: 17,
        utc_intervals: [{ start: asOf - 31_539_600, end: asOf - 31_536_000 }],
        coverage: coverage(asOf - 31_536_000, "unavailable"),
        value: null,
      },
    },
    seasonal_local_hour_percentiles: {
      state: "available",
      reason: null,
      season: "JJA",
      local_hour: 17,
      lookback_completed_local_dates: 400,
      method: "type7",
      unit: "MW",
      qualification_threshold: 0.8,
      eligible_date_count: 50,
      sample_count: 45,
      excluded_date_count: 5,
      first_cohort_date: "2025-06-01",
      last_cohort_date: "2026-07-20",
      p10: 61_500,
      p50: 70_250,
      p90: 79_100,
    },
    completed_day_peak_rank: {
      state: "partial",
      reason: "incomplete_or_unqualified_365_day_cohort",
      market_date: "2026-07-20",
      window_days: 365,
      rank: 3,
      denominator: 120,
      cohort_start_date: "2025-07-22",
      cohort_end_date: "2026-07-20",
      qualification_threshold: 0.8,
      unit: "MW",
      expected_date_count: 365,
      qualified_prior_count: 119,
      excluded_prior_count: 245,
      observed_prior_summary_count: 125,
      ties: "competition",
      peak: point(78_500, asOf - 86_400),
      coverage: coverage(asOf - 86_400),
    },
    observed_extrema: {
      "7d": extrema("7d", 7),
      "30d": extrema("30d", 30),
      "365d": extrema("365d", 365),
      since_collection: extrema("since_collection", 500),
    },
    retention: {
      observed_start: asOf - 500 * 86_400,
      observed_end: asOf - 300,
      backfill_complete: true,
    },
  };
  return {
    schema: 1,
    policy: POLICY,
    state: "available",
    summary,
    resource: {
      content_version: VERSION,
      url: `/api/v2/historical-context/supply-demand.demand/v1/${VERSION}/${String(asOf)}`,
    },
  };
}

export async function installHistoricalContextApi(page: Page, requests: string[]) {
  await page.route("**/api/v1/historical-context?*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    const asOf = Number(url.searchParams.get("as_of"));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(historicalContextFixture(asOf)),
    });
  });
  await page.route("**/api/v2/historical-context/**", async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500, body: "resource fanout forbidden" });
  });
}
