export const HISTORICAL_CONTEXT_POLICY =
  "collection_history_season_and_local_hour_context_not_forecast_or_all_time_record" as const;
export const HISTORICAL_CONTEXT_SERIES_KEY = "supply-demand.demand" as const;
export const HISTORICAL_CONTEXT_METHODOLOGY = "v1" as const;

export type HistoricalCoverageState = "partial" | "qualified" | "unavailable";
export type HistoricalCoverage = {
  state: HistoricalCoverageState;
  expected_count: number;
  observed_count: number;
  ratio: number;
  first_observed_at: number | null;
  last_observed_at: number | null;
};
export type HistoricalValue = { timestamp: number; value: number };

export type HistoricalComparison = {
  state: "available" | "partial" | "unavailable";
  reason:
    | "insufficient_coverage"
    | "nonexistent_local_hour"
    | "unavailable_no_calendar_anniversary"
    | null;
  market_date: string | null;
  local_hour: number;
  utc_intervals: HistoricalUtcInterval[];
  coverage: HistoricalCoverage | null;
  value: HistoricalValue | null;
};

export type HistoricalUtcInterval = { start: number; end: number };

export type HistoricalExtrema = {
  window: "7d" | "30d" | "365d" | "since_collection";
  state: HistoricalCoverageState;
  start: number | null;
  end: number;
  minimum: HistoricalValue | null;
  maximum: HistoricalValue | null;
  coverage: Omit<HistoricalCoverage, "state"> | null;
};

export type HistoricalContextSummary = {
  schema: 1;
  policy: typeof HISTORICAL_CONTEXT_POLICY;
  methodology: typeof HISTORICAL_CONTEXT_METHODOLOGY;
  series_key: typeof HISTORICAL_CONTEXT_SERIES_KEY;
  unit: "MW";
  statistic: "maximum_observed_5m_demand";
  time_basis: "America/Chicago civil hour; fall 01 combines both folds";
  as_of: number;
  selected_hour: {
    market_date: string;
    local_hour: number;
    start: number;
    end: number;
    occurrence_count: number;
    utc_intervals: HistoricalUtcInterval[];
    coverage: HistoricalCoverage;
    value: HistoricalValue | null;
  };
  comparisons: {
    previous_day: HistoricalComparison;
    previous_week: HistoricalComparison;
    previous_year: HistoricalComparison;
  };
  seasonal_local_hour_percentiles: {
    state: "available" | "unavailable";
    reason: "minimum_30_qualified_hours" | null;
    season: "DJF" | "MAM" | "JJA" | "SON";
    local_hour: number;
    lookback_completed_local_dates: 400;
    method: "type7";
    unit: "MW";
    qualification_threshold: 0.8;
    eligible_date_count: number;
    sample_count: number;
    excluded_date_count: number;
    first_cohort_date: string | null;
    last_cohort_date: string | null;
    p10: number | null;
    p50: number | null;
    p90: number | null;
  };
  completed_day_peak_rank: {
    state: "available" | "partial" | "unavailable";
    reason:
      | "incomplete_or_unqualified_365_day_cohort"
      | "selected_day_insufficient_coverage"
      | null;
    market_date: string;
    window_days: 365;
    rank: number | null;
    denominator: number;
    cohort_start_date: string;
    cohort_end_date: string;
    qualification_threshold: 0.8;
    unit: "MW";
    expected_date_count: 365;
    qualified_prior_count: number;
    excluded_prior_count: number;
    observed_prior_summary_count: number;
    ties: "competition";
    peak: HistoricalValue | null;
    coverage: HistoricalCoverage;
  };
  observed_extrema: Record<"7d" | "30d" | "365d" | "since_collection", HistoricalExtrema>;
  retention: {
    observed_start: number | null;
    observed_end: number | null;
    backfill_complete: boolean;
  };
};

export type HistoricalContextResolver = {
  schema: 1;
  policy: typeof HISTORICAL_CONTEXT_POLICY;
  state: "available" | "partial" | "unavailable";
  summary: HistoricalContextSummary;
  resource: { content_version: string; url: string };
};

const VERSION = /^hc1-[0-9a-f]{64}$/;
const MARKET_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXTREMA_WINDOWS = ["7d", "30d", "365d", "since_collection"] as const;
const CHICAGO_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function integer(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function finite(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(code);
  return value;
}

function nullableInteger(value: unknown, code: string): number | null {
  return value === null ? null : integer(value, code);
}

function nullableValue(value: unknown, code: string): HistoricalValue | null {
  if (value === null) return null;
  const item = object(value, code);
  exact(item, ["value", "timestamp"], code);
  return { value: finite(item["value"], code), timestamp: integer(item["timestamp"], code) };
}

function ratio(value: unknown, code: string): number {
  const result = finite(value, code);
  if (result < 0 || result > 1) throw new Error(code);
  return result;
}

function parseCounts(
  input: Record<string, unknown>,
  code: string,
): Omit<HistoricalCoverage, "state"> {
  const expected = integer(input["expected_count"], code);
  const observed = integer(input["observed_count"], code);
  const result = ratio(input["ratio"], code);
  const first = nullableInteger(input["first_observed_at"], code);
  const last = nullableInteger(input["last_observed_at"], code);
  if (
    observed > expected ||
    Math.abs(result - (expected ? observed / expected : 0)) > 1e-12 ||
    (observed === 0) !== (first === null) ||
    (first === null) !== (last === null) ||
    (first !== null && first > last!)
  ) {
    throw new Error(code);
  }
  return {
    expected_count: expected,
    observed_count: observed,
    ratio: result,
    first_observed_at: first,
    last_observed_at: last,
  };
}

function parseCoverage(value: unknown, code: string): HistoricalCoverage {
  const item = object(value, code);
  exact(
    item,
    ["state", "expected_count", "observed_count", "ratio", "first_observed_at", "last_observed_at"],
    code,
  );
  if (!["partial", "qualified", "unavailable"].includes(String(item["state"]))) {
    throw new Error(code);
  }
  const counts = parseCounts(item, code);
  if (
    (item["state"] === "qualified" && (counts.expected_count === 0 || counts.ratio < 0.8)) ||
    (item["state"] === "partial" && (counts.observed_count === 0 || counts.ratio >= 0.8)) ||
    (item["state"] === "unavailable" && counts.observed_count !== 0)
  ) {
    throw new Error(code);
  }
  return { state: item["state"] as HistoricalCoverageState, ...counts };
}

function marketDate(value: unknown, code: string): string {
  if (typeof value !== "string" || !MARKET_DATE.test(value)) throw new Error(code);
  return value;
}

function localHour(value: unknown, code: string): number {
  const result = integer(value, code);
  if (result > 23) throw new Error(code);
  return result;
}

function parseIntervals(value: unknown, code: string): HistoricalUtcInterval[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error(code);
  let priorEnd = -1;
  return value.map((raw) => {
    const interval = object(raw, code);
    exact(interval, ["start", "end"], code);
    const start = integer(interval["start"], code);
    const end = integer(interval["end"], code);
    if (end !== start + 3_600 || start < priorEnd) throw new Error(code);
    priorEnd = end;
    return { start, end };
  });
}

function intervalContains(intervals: HistoricalUtcInterval[], timestamp: number): boolean {
  return intervals.some((interval) => timestamp >= interval.start && timestamp < interval.end);
}

function coverageFitsIntervals(
  coverage: HistoricalCoverage | null,
  intervals: HistoricalUtcInterval[],
): boolean {
  if (!coverage || coverage.first_observed_at === null || coverage.last_observed_at === null) {
    return coverage === null || coverage.observed_count === 0;
  }
  return (
    intervalContains(intervals, coverage.first_observed_at) &&
    intervalContains(intervals, coverage.last_observed_at)
  );
}

function intervalMatchesChicagoIdentity(
  intervals: HistoricalUtcInterval[],
  date: string,
  hour: number,
): boolean {
  return intervals.every((interval) => {
    const parts = Object.fromEntries(
      CHICAGO_PARTS.formatToParts(new Date(interval.start * 1_000))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return (
      `${parts["year"]}-${parts["month"]}-${parts["day"]}` === date &&
      Number(parts["hour"]) === hour
    );
  });
}

function chicagoDate(timestamp: number): string {
  const parts = Object.fromEntries(
    CHICAGO_PARTS.formatToParts(new Date(timestamp * 1_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

function meteorologicalSeason(date: string): "DJF" | "MAM" | "JJA" | "SON" {
  const month = Number(date.slice(5, 7));
  if (month === 12 || month <= 2) return "DJF";
  if (month <= 5) return "MAM";
  if (month <= 8) return "JJA";
  return "SON";
}

function parseComparison(value: unknown, selectedHour: number): HistoricalComparison {
  const code = "invalid_historical_context_comparison";
  const item = object(value, code);
  exact(
    item,
    ["state", "reason", "market_date", "local_hour", "utc_intervals", "coverage", "value"],
    code,
  );
  if (!["available", "partial", "unavailable"].includes(String(item["state"])))
    throw new Error(code);
  if (item["local_hour"] !== selectedHour) throw new Error(code);
  const reason = item["reason"];
  if (
    reason !== null &&
    reason !== "insufficient_coverage" &&
    reason !== "nonexistent_local_hour" &&
    reason !== "unavailable_no_calendar_anniversary"
  ) {
    throw new Error(code);
  }
  const date = item["market_date"] === null ? null : marketDate(item["market_date"], code);
  const intervals = parseIntervals(item["utc_intervals"], code);
  const coverage = item["coverage"] === null ? null : parseCoverage(item["coverage"], code);
  const point = nullableValue(item["value"], code);
  if (
    (item["state"] === "available" &&
      (!point || !coverage || coverage.state !== "qualified" || reason !== null)) ||
    (item["state"] !== "available" && point !== null) ||
    ((reason === "nonexistent_local_hour" || reason === "unavailable_no_calendar_anniversary") &&
      intervals.length !== 0) ||
    (reason === "unavailable_no_calendar_anniversary" && (date !== null || coverage !== null)) ||
    (reason === "insufficient_coverage" && coverage === null) ||
    (coverage !== null && coverage.expected_count !== 12 * intervals.length) ||
    (date !== null && !intervalMatchesChicagoIdentity(intervals, date, selectedHour)) ||
    !coverageFitsIntervals(coverage, intervals) ||
    (point !== null && !intervalContains(intervals, point.timestamp))
  ) {
    throw new Error(code);
  }
  return {
    state: item["state"] as HistoricalComparison["state"],
    reason,
    market_date: date,
    local_hour: selectedHour,
    utc_intervals: intervals,
    coverage,
    value: point,
  };
}

function parseExtrema(
  value: unknown,
  expectedWindow: HistoricalExtrema["window"],
): HistoricalExtrema {
  const code = "invalid_historical_context_extrema";
  const item = object(value, code);
  exact(item, ["window", "state", "start", "end", "minimum", "maximum", "coverage"], code);
  if (
    item["window"] !== expectedWindow ||
    !["partial", "qualified", "unavailable"].includes(String(item["state"]))
  )
    throw new Error(code);
  const start = nullableInteger(item["start"], code);
  const end = integer(item["end"], code);
  const coverageItem = item["coverage"] === null ? null : object(item["coverage"], code);
  if (coverageItem)
    exact(
      coverageItem,
      ["expected_count", "observed_count", "ratio", "first_observed_at", "last_observed_at"],
      code,
    );
  const coverage = coverageItem ? parseCounts(coverageItem, code) : null;
  const minimum = nullableValue(item["minimum"], code);
  const maximum = nullableValue(item["maximum"], code);
  if (
    (start === null) !== (coverage === null) ||
    (start !== null && start >= end) ||
    (item["state"] === "qualified" && (!coverage || coverage.ratio < 0.8)) ||
    (item["state"] === "partial" && (!coverage || coverage.observed_count === 0)) ||
    (item["state"] === "unavailable" && (minimum !== null || maximum !== null)) ||
    (coverage !== null &&
      (coverage.first_observed_at! < start! || coverage.last_observed_at! >= end)) ||
    (minimum !== null && (minimum.timestamp < start! || minimum.timestamp >= end)) ||
    (maximum !== null && (maximum.timestamp < start! || maximum.timestamp >= end))
  )
    throw new Error(code);
  return {
    window: expectedWindow,
    state: item["state"] as HistoricalCoverageState,
    start,
    end,
    minimum,
    maximum,
    coverage,
  };
}

export function historicalContextAsOf(end: number): number {
  if (!Number.isFinite(end) || end < 0) throw new Error("invalid_historical_context_as_of");
  return Math.floor(end / 3_600) * 3_600;
}

export function historicalContextResolverUrl(asOf: number): string {
  if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf % 3_600 !== 0) {
    throw new Error("invalid_historical_context_as_of");
  }
  return `/api/v1/historical-context?series_key=${HISTORICAL_CONTEXT_SERIES_KEY}&as_of=${String(asOf)}`;
}

export function parseHistoricalContextResolver(value: unknown): HistoricalContextResolver {
  const code = "invalid_historical_context";
  const root = object(value, code);
  exact(root, ["schema", "policy", "state", "summary", "resource"], code);
  if (
    root["schema"] !== 1 ||
    root["policy"] !== HISTORICAL_CONTEXT_POLICY ||
    !["available", "partial", "unavailable"].includes(String(root["state"]))
  )
    throw new Error(code);
  const summary = object(root["summary"], code);
  exact(
    summary,
    [
      "as_of",
      "comparisons",
      "completed_day_peak_rank",
      "methodology",
      "observed_extrema",
      "policy",
      "retention",
      "schema",
      "seasonal_local_hour_percentiles",
      "selected_hour",
      "series_key",
      "statistic",
      "time_basis",
      "unit",
    ],
    code,
  );
  if (
    summary["schema"] !== 1 ||
    summary["policy"] !== HISTORICAL_CONTEXT_POLICY ||
    summary["methodology"] !== HISTORICAL_CONTEXT_METHODOLOGY ||
    summary["series_key"] !== HISTORICAL_CONTEXT_SERIES_KEY ||
    summary["unit"] !== "MW" ||
    summary["statistic"] !== "maximum_observed_5m_demand" ||
    summary["time_basis"] !== "America/Chicago civil hour; fall 01 combines both folds"
  )
    throw new Error(code);
  const asOf = integer(summary["as_of"], code);
  if (asOf % 3_600 !== 0) throw new Error(code);
  const selected = object(summary["selected_hour"], code);
  exact(
    selected,
    [
      "market_date",
      "local_hour",
      "start",
      "end",
      "occurrence_count",
      "utc_intervals",
      "coverage",
      "value",
    ],
    code,
  );
  const selectedHour = localHour(selected["local_hour"], code);
  const selectedStart = integer(selected["start"], code);
  const selectedEnd = integer(selected["end"], code);
  const occurrenceCount = integer(selected["occurrence_count"], code);
  const selectedIntervals = parseIntervals(selected["utc_intervals"], code);
  const selectedCoverage = parseCoverage(selected["coverage"], code);
  const selectedValue = nullableValue(selected["value"], code);
  const selectedDate = marketDate(selected["market_date"], code);
  if (
    selectedEnd <= selectedStart ||
    ![1, 2].includes(occurrenceCount) ||
    selectedIntervals.length !== occurrenceCount ||
    selectedIntervals[0]?.start !== selectedStart ||
    selectedIntervals.at(-1)?.end !== selectedEnd ||
    selectedEnd > asOf ||
    selectedCoverage.expected_count !== 12 * occurrenceCount ||
    (selectedCoverage.state === "qualified") !== (selectedValue !== null) ||
    !intervalMatchesChicagoIdentity(selectedIntervals, selectedDate, selectedHour) ||
    !coverageFitsIntervals(selectedCoverage, selectedIntervals) ||
    (selectedValue !== null && !intervalContains(selectedIntervals, selectedValue.timestamp))
  )
    throw new Error(code);
  const comparisons = object(summary["comparisons"], code);
  exact(comparisons, ["previous_day", "previous_week", "previous_year"], code);
  const percentiles = object(summary["seasonal_local_hour_percentiles"], code);
  exact(
    percentiles,
    [
      "state",
      "reason",
      "season",
      "local_hour",
      "lookback_completed_local_dates",
      "method",
      "unit",
      "qualification_threshold",
      "eligible_date_count",
      "sample_count",
      "excluded_date_count",
      "first_cohort_date",
      "last_cohort_date",
      "p10",
      "p50",
      "p90",
    ],
    code,
  );
  if (
    !["available", "unavailable"].includes(String(percentiles["state"])) ||
    percentiles["season"] !== meteorologicalSeason(selectedDate) ||
    percentiles["local_hour"] !== selectedHour ||
    percentiles["lookback_completed_local_dates"] !== 400 ||
    percentiles["method"] !== "type7" ||
    percentiles["unit"] !== "MW" ||
    percentiles["qualification_threshold"] !== 0.8
  )
    throw new Error(code);
  const eligibleDateCount = integer(percentiles["eligible_date_count"], code);
  const sampleCount = integer(percentiles["sample_count"], code);
  const excludedDateCount = integer(percentiles["excluded_date_count"], code);
  const firstCohortDate =
    percentiles["first_cohort_date"] === null
      ? null
      : marketDate(percentiles["first_cohort_date"], code);
  const lastCohortDate =
    percentiles["last_cohort_date"] === null
      ? null
      : marketDate(percentiles["last_cohort_date"], code);
  if (
    sampleCount + excludedDateCount !== eligibleDateCount ||
    (eligibleDateCount === 0) !== (firstCohortDate === null) ||
    (firstCohortDate === null) !== (lastCohortDate === null) ||
    (firstCohortDate !== null && firstCohortDate > lastCohortDate!)
  )
    throw new Error(code);
  const percentileValues = [percentiles["p10"], percentiles["p50"], percentiles["p90"]].map(
    (entry) => (entry === null ? null : finite(entry, code)),
  );
  const percentileAvailable = percentiles["state"] === "available";
  if (
    percentiles["reason"] !== (percentileAvailable ? null : "minimum_30_qualified_hours") ||
    percentileAvailable !== sampleCount >= 30 ||
    percentileValues.some((entry) => (entry === null) === percentileAvailable)
  )
    throw new Error(code);
  if (
    percentileAvailable &&
    !(percentileValues[0]! <= percentileValues[1]! && percentileValues[1]! <= percentileValues[2]!)
  )
    throw new Error(code);
  const peak = object(summary["completed_day_peak_rank"], code);
  exact(
    peak,
    [
      "state",
      "reason",
      "market_date",
      "window_days",
      "rank",
      "denominator",
      "cohort_start_date",
      "cohort_end_date",
      "qualification_threshold",
      "unit",
      "expected_date_count",
      "qualified_prior_count",
      "excluded_prior_count",
      "observed_prior_summary_count",
      "ties",
      "peak",
      "coverage",
    ],
    code,
  );
  const peakAvailable = peak["state"] === "available" || peak["state"] === "partial";
  const expectedPeakReason =
    peak["state"] === "available"
      ? null
      : peak["state"] === "partial"
        ? "incomplete_or_unqualified_365_day_cohort"
        : "selected_day_insufficient_coverage";
  if (
    (!peakAvailable && peak["state"] !== "unavailable") ||
    peak["reason"] !== expectedPeakReason ||
    peak["window_days"] !== 365 ||
    peak["ties"] !== "competition" ||
    peak["qualification_threshold"] !== 0.8 ||
    peak["unit"] !== "MW" ||
    peak["expected_date_count"] !== 365
  )
    throw new Error(code);
  const peakRank = nullableInteger(peak["rank"], code);
  const denominator = integer(peak["denominator"], code);
  const qualifiedPriorCount = integer(peak["qualified_prior_count"], code);
  const excludedPriorCount = integer(peak["excluded_prior_count"], code);
  const observedPriorSummaryCount = integer(peak["observed_prior_summary_count"], code);
  const peakMarketDate = marketDate(peak["market_date"], code);
  const cohortStartDate = marketDate(peak["cohort_start_date"], code);
  const cohortEndDate = marketDate(peak["cohort_end_date"], code);
  const peakCoverage = parseCoverage(peak["coverage"], code);
  const peakValue = nullableValue(peak["peak"], code);
  if (
    peakAvailable &&
    (!peakRank || peakRank > denominator || denominator !== qualifiedPriorCount + 1)
  )
    throw new Error(code);
  if (!peakAvailable && peakRank !== null) throw new Error(code);
  if (
    qualifiedPriorCount + excludedPriorCount !== 364 ||
    observedPriorSummaryCount > 364 ||
    cohortStartDate > cohortEndDate ||
    peakAvailable !== (peakCoverage.state === "qualified") ||
    (peak["state"] === "available") !== (peakAvailable && excludedPriorCount === 0) ||
    (peak["state"] === "partial") !== (peakAvailable && excludedPriorCount > 0) ||
    peakAvailable !== (peakValue !== null) ||
    (peakValue !== null && chicagoDate(peakValue.timestamp) !== peakMarketDate) ||
    (peakCoverage.first_observed_at !== null &&
      chicagoDate(peakCoverage.first_observed_at) !== peakMarketDate) ||
    (peakCoverage.last_observed_at !== null &&
      chicagoDate(peakCoverage.last_observed_at) !== peakMarketDate)
  )
    throw new Error(code);
  const extremaRaw = object(summary["observed_extrema"], code);
  exact(extremaRaw, EXTREMA_WINDOWS, code);
  const observedExtrema = Object.fromEntries(
    EXTREMA_WINDOWS.map((window) => [window, parseExtrema(extremaRaw[window], window)]),
  ) as HistoricalContextSummary["observed_extrema"];
  const retention = object(summary["retention"], code);
  exact(retention, ["observed_start", "observed_end", "backfill_complete"], code);
  const observedStart = nullableInteger(retention["observed_start"], code);
  const observedEnd = nullableInteger(retention["observed_end"], code);
  if (
    typeof retention["backfill_complete"] !== "boolean" ||
    (observedStart === null) !== (observedEnd === null) ||
    (observedStart !== null && observedStart > observedEnd!)
  )
    throw new Error(code);
  const resource = object(root["resource"], code);
  exact(resource, ["content_version", "url"], code);
  if (typeof resource["content_version"] !== "string" || !VERSION.test(resource["content_version"]))
    throw new Error(code);
  const expectedUrl = `/api/v2/historical-context/${HISTORICAL_CONTEXT_SERIES_KEY}/${HISTORICAL_CONTEXT_METHODOLOGY}/${resource["content_version"]}/${String(asOf)}`;
  if (resource["url"] !== expectedUrl) throw new Error(code);
  if (
    (root["state"] === "available") !== (selectedCoverage.state === "qualified") ||
    (root["state"] === "partial") !== (selectedCoverage.state === "partial")
  )
    throw new Error(code);
  return {
    schema: 1,
    policy: HISTORICAL_CONTEXT_POLICY,
    state: root["state"] as HistoricalContextResolver["state"],
    summary: {
      schema: 1,
      policy: HISTORICAL_CONTEXT_POLICY,
      methodology: HISTORICAL_CONTEXT_METHODOLOGY,
      series_key: HISTORICAL_CONTEXT_SERIES_KEY,
      unit: "MW",
      statistic: "maximum_observed_5m_demand",
      time_basis: "America/Chicago civil hour; fall 01 combines both folds",
      as_of: asOf,
      selected_hour: {
        market_date: selectedDate,
        local_hour: selectedHour,
        start: selectedStart,
        end: selectedEnd,
        occurrence_count: occurrenceCount,
        utc_intervals: selectedIntervals,
        coverage: selectedCoverage,
        value: selectedValue,
      },
      comparisons: {
        previous_day: parseComparison(comparisons["previous_day"], selectedHour),
        previous_week: parseComparison(comparisons["previous_week"], selectedHour),
        previous_year: parseComparison(comparisons["previous_year"], selectedHour),
      },
      seasonal_local_hour_percentiles: {
        state: percentiles["state"] as "available" | "unavailable",
        reason: percentiles["reason"] as "minimum_30_qualified_hours" | null,
        season: percentiles["season"] as "DJF" | "MAM" | "JJA" | "SON",
        local_hour: selectedHour,
        lookback_completed_local_dates: 400,
        method: "type7",
        unit: "MW",
        qualification_threshold: 0.8,
        eligible_date_count: eligibleDateCount,
        sample_count: sampleCount,
        excluded_date_count: excludedDateCount,
        first_cohort_date: firstCohortDate,
        last_cohort_date: lastCohortDate,
        p10: percentileValues[0],
        p50: percentileValues[1],
        p90: percentileValues[2],
      },
      completed_day_peak_rank: {
        state: peak["state"] as "available" | "partial" | "unavailable",
        reason: peak["reason"] as
          | "incomplete_or_unqualified_365_day_cohort"
          | "selected_day_insufficient_coverage"
          | null,
        market_date: peakMarketDate,
        window_days: 365,
        rank: peakRank,
        denominator,
        cohort_start_date: cohortStartDate,
        cohort_end_date: cohortEndDate,
        qualification_threshold: 0.8,
        unit: "MW",
        expected_date_count: 365,
        qualified_prior_count: qualifiedPriorCount,
        excluded_prior_count: excludedPriorCount,
        observed_prior_summary_count: observedPriorSummaryCount,
        ties: "competition",
        peak: peakValue,
        coverage: peakCoverage,
      },
      observed_extrema: observedExtrema,
      retention: {
        observed_start: observedStart,
        observed_end: observedEnd,
        backfill_complete: retention["backfill_complete"],
      },
    },
    resource: { content_version: resource["content_version"], url: expectedUrl },
  };
}
