export const FORECAST_QUALITY_SERIES = ["load.system", "wind.stwpf", "solar.stppf"] as const;
export const FORECAST_QUALITY_HORIZONS = ["1h", "6h", "24h"] as const;

export type ForecastQualitySeriesKey = (typeof FORECAST_QUALITY_SERIES)[number];
export type ForecastQualityHorizon = (typeof FORECAST_QUALITY_HORIZONS)[number];

export type ForecastQualitySummary = {
  sample_count: number;
  mape_sample_count: number;
  expected_count: number;
  joint_coverage: number;
  chicago_delivery_date_count: number;
  sample_span_seconds: number;
  bias_mw: number | null;
  mae_mw: number | null;
  mape_percent: number | null;
  signed_error_quantiles_mw: { p10: number | null; p50: number | null; p90: number | null };
  absolute_error_p80_mw: number | null;
  empirical_interval: null | {
    kind: "historical_signed_error_type7_p10_p90";
    lower_mw: number;
    upper_mw: number;
  };
  qualification: {
    qualified: boolean;
    reasons: string[];
    minimum_sample_count: 100;
    minimum_chicago_delivery_dates: 30;
    minimum_span_seconds: 2_419_200;
    minimum_joint_coverage: 0.8;
  };
};

export type ForecastQualityManifest = {
  schema: 1;
  kind: "forecast_quality_manifest";
  methodology_version: "v1";
  dataset_updated_through: number | null;
  window_days: 90;
  supported_series: ForecastQualitySeriesKey[];
  supported_horizons: ForecastQualityHorizon[];
  source_contracts: Array<{
    series_key: ForecastQualitySeriesKey;
    source_ids: string[];
    interpretation: "diagnostic_product_pairing" | "forecast_vs_system_wide_hsl";
    health: Array<{
      source_id: string;
      display_name: string | null;
      availability_status: "available" | "empty" | null;
      consecutive_failures: number | null;
      last_success_ts: number | null;
      source_timestamp_ts: number | null;
      data_timestamp_ts: number | null;
      expected_interval_seconds: number | null;
      collection_age_seconds: number | null;
      source_age_seconds: number | null;
      data_age_seconds: number | null;
      state: "healthy" | "delayed" | "stale" | "failed" | "unavailable";
      collection_state: "healthy" | "delayed" | "failed" | "unavailable";
      freshness_state: "fresh" | "delayed" | "stale" | "unknown" | "event_driven";
    }>;
  }>;
  summaries: Array<{
    series_key: ForecastQualitySeriesKey;
    horizon: ForecastQualityHorizon;
    availability: "available" | "unavailable";
    summary: ForecastQualitySummary;
    missing_reasons: Record<string, number>;
  }>;
  resources: Array<{
    series_key: ForecastQualitySeriesKey;
    horizon: ForecastQualityHorizon;
    day_start: number;
    content_version: string;
    url: string;
  }>;
};

export type ForecastQualityRow = {
  target_ts: number;
  delivery_date: string;
  forecast_mw: number | null;
  actual_mw: number | null;
  error_mw: number | null;
  absolute_error_mw: number | null;
  absolute_percentage_error: number | null;
  revision_mw: number | null;
  selected_issue_at: number | null;
  effective_lead_seconds: number | null;
  model: string | null;
  forecast_vintage_key: string | null;
  actual_vintage_key: string | null;
  missing_reason: string | null;
};

export type ForecastQualityResource = {
  schema: 1;
  kind: "forecast_quality_daily";
  series_key: ForecastQualitySeriesKey;
  horizon: ForecastQualityHorizon;
  horizon_seconds: 3600 | 21600 | 86400;
  tile_span: "1d";
  day_start: number;
  day_end: number;
  unit: "MW";
  methodology_version: "v1";
  content_version: string;
  methodology: {
    selection: "per_target_latest_issue_at_or_before_cutoff";
    lead_window: "[horizon,horizon+3600)";
    model_policy: "exactly_one_in_use_row" | "product_implicit_model";
    error_formula: "actual_minus_forecast";
    positive_error_meaning: "underforecast";
    mape_denominator: "positive_actual_only";
    quantile_method: "Type 7";
    diagnostic_pairing: string;
  };
  model_counts: Record<string, number>;
  missing_reasons: Record<string, number>;
  summary: ForecastQualitySummary;
  rows: ForecastQualityRow[];
};

const CONTENT_VERSION = /^q1-[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIAGNOSTIC_PAIRING: Record<ForecastQualitySeriesKey, string> = {
  "load.system": "NP3-565 systemTotal vs NP6-345 total",
  "wind.stwpf": "NP4-732 STWPF_SYSTEM_WIDE vs SYSTEM_WIDE_HSL",
  "solar.stppf": "NP4-737 STPPF_SYSTEM_WIDE vs SYSTEM_WIDE_HSL",
};
const SOURCE_IDS: Record<ForecastQualitySeriesKey, readonly string[]> = {
  "load.system": [
    "ercot_public_np3_565_weather_zone_forecast",
    "ercot_public_np6_345_weather_zone_actual_load",
  ],
  "wind.stwpf": ["ercot_mis_np4_732"],
  "solar.stppf": ["ercot_mis_np4_737"],
};

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function finite(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function integer(value: unknown, error: string): number {
  const result = finite(value, error);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(error);
  return result;
}

function nullableFinite(value: unknown, error: string): number | null {
  return value === null ? null : finite(value, error);
}

function nullableInteger(value: unknown, error: string): number | null {
  return value === null ? null : integer(value, error);
}

function text(value: unknown, error: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(error);
  }
  return value;
}

function nullableText(value: unknown, error: string): string | null {
  return value === null ? null : text(value, error);
}

function series(value: unknown): ForecastQualitySeriesKey {
  if (!FORECAST_QUALITY_SERIES.includes(value as ForecastQualitySeriesKey)) {
    throw new Error("invalid_forecast_quality_series");
  }
  return value as ForecastQualitySeriesKey;
}

function horizon(value: unknown): ForecastQualityHorizon {
  if (!FORECAST_QUALITY_HORIZONS.includes(value as ForecastQualityHorizon)) {
    throw new Error("invalid_forecast_quality_horizon");
  }
  return value as ForecastQualityHorizon;
}

function counts(value: unknown, error: string): Record<string, number> {
  const input = record(value, error);
  if (Object.keys(input).length > 32) throw new Error(error);
  return Object.fromEntries(
    Object.entries(input).map(([key, count]) => [text(key, error, 80), integer(count, error)]),
  );
}

function summary(value: unknown): ForecastQualitySummary {
  const input = record(value, "invalid_forecast_quality_summary");
  const quantiles = record(
    input["signed_error_quantiles_mw"],
    "invalid_forecast_quality_quantiles",
  );
  const qualification = record(input["qualification"], "invalid_forecast_quality_qualification");
  const reasons = qualification["reasons"];
  if (
    !Array.isArray(reasons) ||
    reasons.length > 8 ||
    reasons.some((item) => typeof item !== "string")
  ) {
    throw new Error("invalid_forecast_quality_qualification");
  }
  const intervalRaw = input["empirical_interval"];
  const interval =
    intervalRaw === null
      ? null
      : (() => {
          const item = record(intervalRaw, "invalid_forecast_quality_interval");
          if (item["kind"] !== "historical_signed_error_type7_p10_p90") {
            throw new Error("invalid_forecast_quality_interval");
          }
          return {
            kind: "historical_signed_error_type7_p10_p90" as const,
            lower_mw: finite(item["lower_mw"], "invalid_forecast_quality_interval"),
            upper_mw: finite(item["upper_mw"], "invalid_forecast_quality_interval"),
          };
        })();
  if (
    qualification["minimum_sample_count"] !== 100 ||
    qualification["minimum_chicago_delivery_dates"] !== 30 ||
    qualification["minimum_span_seconds"] !== 2_419_200 ||
    qualification["minimum_joint_coverage"] !== 0.8 ||
    typeof qualification["qualified"] !== "boolean"
  ) {
    throw new Error("invalid_forecast_quality_qualification");
  }
  const expectedCount = integer(input["expected_count"], "invalid_forecast_quality_summary");
  const sampleCount = integer(input["sample_count"], "invalid_forecast_quality_summary");
  const coverage = finite(input["joint_coverage"], "invalid_forecast_quality_summary");
  const deliveryDateCount = integer(
    input["chicago_delivery_date_count"],
    "invalid_forecast_quality_summary",
  );
  const sampleSpan = integer(input["sample_span_seconds"], "invalid_forecast_quality_summary");
  const mapeCount = integer(input["mape_sample_count"], "invalid_forecast_quality_summary");
  const bias = nullableFinite(input["bias_mw"], "invalid_forecast_quality_summary");
  const mae = nullableFinite(input["mae_mw"], "invalid_forecast_quality_summary");
  const mape = nullableFinite(input["mape_percent"], "invalid_forecast_quality_summary");
  const p10 = nullableFinite(quantiles["p10"], "invalid_forecast_quality_quantiles");
  const p50 = nullableFinite(quantiles["p50"], "invalid_forecast_quality_quantiles");
  const p90 = nullableFinite(quantiles["p90"], "invalid_forecast_quality_quantiles");
  const p80 = nullableFinite(input["absolute_error_p80_mw"], "invalid_forecast_quality_summary");
  const qualified = qualification["qualified"];
  const shouldQualify =
    sampleCount >= 100 && deliveryDateCount >= 30 && sampleSpan >= 2_419_200 && coverage >= 0.8;
  const expectedReasons = [
    ...(sampleCount < 100 ? ["insufficient_samples"] : []),
    ...(deliveryDateCount < 30 ? ["insufficient_delivery_dates"] : []),
    ...(sampleSpan < 2_419_200 ? ["insufficient_sample_span"] : []),
    ...(coverage < 0.8 ? ["insufficient_joint_coverage"] : []),
  ];
  if (
    sampleCount > expectedCount ||
    mapeCount > sampleCount ||
    coverage < 0 ||
    coverage > 1 ||
    (expectedCount > 0 && !close(coverage, sampleCount / expectedCount)) ||
    (expectedCount === 0 && coverage !== 0) ||
    (mae !== null && mae < 0) ||
    (mape !== null && mape < 0) ||
    (p80 !== null && p80 < 0) ||
    (p10 !== null && p50 !== null && p10 > p50) ||
    (p50 !== null && p90 !== null && p50 > p90) ||
    qualified !== shouldQualify ||
    reasons.length !== expectedReasons.length ||
    reasons.some((reason, index) => reason !== expectedReasons[index]) ||
    qualified !== (interval !== null) ||
    (interval !== null &&
      (p10 === null ||
        p90 === null ||
        !close(interval.lower_mw, p10) ||
        !close(interval.upper_mw, p90))) ||
    (sampleCount === 0 &&
      (bias !== null || mae !== null || p10 !== null || p50 !== null || p90 !== null))
  ) {
    throw new Error("invalid_forecast_quality_summary");
  }
  return {
    sample_count: sampleCount,
    mape_sample_count: mapeCount,
    expected_count: expectedCount,
    joint_coverage: coverage,
    chicago_delivery_date_count: deliveryDateCount,
    sample_span_seconds: sampleSpan,
    bias_mw: bias,
    mae_mw: mae,
    mape_percent: mape,
    signed_error_quantiles_mw: {
      p10,
      p50,
      p90,
    },
    absolute_error_p80_mw: p80,
    empirical_interval: interval,
    qualification: {
      qualified,
      reasons: reasons as string[],
      minimum_sample_count: 100,
      minimum_chicago_delivery_dates: 30,
      minimum_span_seconds: 2_419_200,
      minimum_joint_coverage: 0.8,
    },
  };
}

export function parseForecastQualityManifest(value: unknown): ForecastQualityManifest {
  const input = record(value, "invalid_forecast_quality_manifest");
  if (
    input["schema"] !== 1 ||
    input["kind"] !== "forecast_quality_manifest" ||
    input["methodology_version"] !== "v1" ||
    input["window_days"] !== 90
  ) {
    throw new Error("invalid_forecast_quality_manifest");
  }
  const supportedSeries = input["supported_series"];
  const supportedHorizons = input["supported_horizons"];
  if (
    !Array.isArray(supportedSeries) ||
    supportedSeries.length !== 3 ||
    supportedSeries.some((item, index) => item !== FORECAST_QUALITY_SERIES[index]) ||
    !Array.isArray(supportedHorizons) ||
    supportedHorizons.length !== 3 ||
    supportedHorizons.some((item, index) => item !== FORECAST_QUALITY_HORIZONS[index])
  ) {
    throw new Error("invalid_forecast_quality_catalog");
  }
  const summaryItems = input["summaries"];
  const resourceItems = input["resources"];
  const sourceItems = input["source_contracts"];
  if (
    !Array.isArray(summaryItems) ||
    summaryItems.length !== 9 ||
    !Array.isArray(resourceItems) ||
    resourceItems.length > 810 ||
    !Array.isArray(sourceItems) ||
    sourceItems.length !== 3
  ) {
    throw new Error("invalid_forecast_quality_manifest_bounds");
  }
  const summaries = summaryItems.map((item) => {
    const row = record(item, "invalid_forecast_quality_manifest_summary");
    if (row["availability"] !== "available" && row["availability"] !== "unavailable") {
      throw new Error("invalid_forecast_quality_availability");
    }
    return {
      series_key: series(row["series_key"]),
      horizon: horizon(row["horizon"]),
      availability: row["availability"] as "available" | "unavailable",
      summary: summary(row["summary"]),
      missing_reasons: counts(row["missing_reasons"], "invalid_forecast_quality_reasons"),
    };
  });
  if (new Set(summaries.map((item) => `${item.series_key}:${item.horizon}`)).size !== 9) {
    throw new Error("invalid_forecast_quality_summary_identity");
  }
  const resources = resourceItems.map((item) => {
    const row = record(item, "invalid_forecast_quality_resource_link");
    const seriesKey = series(row["series_key"]);
    const selectedHorizon = horizon(row["horizon"]);
    const dayStart = integer(row["day_start"], "invalid_forecast_quality_resource_link");
    const contentVersion = text(
      row["content_version"],
      "invalid_forecast_quality_resource_link",
      67,
    );
    const url = text(row["url"], "invalid_forecast_quality_resource_link", 300);
    const expected = `/api/v2/forecast-quality/${seriesKey}/v1/${contentVersion}/${selectedHorizon}/1d/${dayStart}`;
    if (!CONTENT_VERSION.test(contentVersion) || dayStart % 86_400 !== 0 || url !== expected) {
      throw new Error("invalid_forecast_quality_resource_link");
    }
    return {
      series_key: seriesKey,
      horizon: selectedHorizon,
      day_start: dayStart,
      content_version: contentVersion,
      url,
    };
  });
  for (let index = 1; index < resources.length; index++) {
    const previous = resources[index - 1]!;
    const current = resources[index]!;
    if (
      `${previous.series_key}:${previous.horizon}` > `${current.series_key}:${current.horizon}` ||
      (`${previous.series_key}:${previous.horizon}` ===
        `${current.series_key}:${current.horizon}` &&
        previous.day_start >= current.day_start)
    ) {
      throw new Error("invalid_forecast_quality_resource_order");
    }
  }
  const sourceContracts = sourceItems.map((item) => {
    const row = record(item, "invalid_forecast_quality_source");
    const sourceIds = row["source_ids"];
    const healthItems = row["health"];
    if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 2) {
      throw new Error("invalid_forecast_quality_source");
    }
    if (!Array.isArray(healthItems) || healthItems.length !== sourceIds.length) {
      throw new Error("invalid_forecast_quality_source_health");
    }
    const interpretation = row["interpretation"];
    if (
      interpretation !== "diagnostic_product_pairing" &&
      interpretation !== "forecast_vs_system_wide_hsl"
    ) {
      throw new Error("invalid_forecast_quality_source");
    }
    const seriesKey = series(row["series_key"]);
    const parsedSourceIds = sourceIds.map((sourceId) =>
      text(sourceId, "invalid_forecast_quality_source", 120),
    );
    if (
      parsedSourceIds.length !== SOURCE_IDS[seriesKey].length ||
      parsedSourceIds.some((sourceId, index) => sourceId !== SOURCE_IDS[seriesKey][index]) ||
      interpretation !==
        (seriesKey === "load.system" ? "diagnostic_product_pairing" : "forecast_vs_system_wide_hsl")
    ) {
      throw new Error("invalid_forecast_quality_source");
    }
    const parsedHealth = healthItems.map((item) => {
      const health = record(item, "invalid_forecast_quality_source_health");
      const availability = health["availability_status"];
      if (availability !== null && availability !== "available" && availability !== "empty") {
        throw new Error("invalid_forecast_quality_source_health");
      }
      const state = health["state"];
      const collectionState = health["collection_state"];
      const freshnessState = health["freshness_state"];
      if (
        !["healthy", "delayed", "stale", "failed", "unavailable"].includes(state as string) ||
        !["healthy", "delayed", "failed", "unavailable"].includes(collectionState as string) ||
        !["fresh", "delayed", "stale", "unknown", "event_driven"].includes(freshnessState as string)
      ) {
        throw new Error("invalid_forecast_quality_source_health");
      }
      return {
        source_id: text(health["source_id"], "invalid_forecast_quality_source_health", 120),
        display_name: nullableText(
          health["display_name"],
          "invalid_forecast_quality_source_health",
        ),
        availability_status: availability as "available" | "empty" | null,
        consecutive_failures: nullableInteger(
          health["consecutive_failures"],
          "invalid_forecast_quality_source_health",
        ),
        last_success_ts: nullableInteger(
          health["last_success_ts"],
          "invalid_forecast_quality_source_health",
        ),
        source_timestamp_ts: nullableInteger(
          health["source_timestamp_ts"],
          "invalid_forecast_quality_source_health",
        ),
        data_timestamp_ts: nullableInteger(
          health["data_timestamp_ts"],
          "invalid_forecast_quality_source_health",
        ),
        expected_interval_seconds: nullableInteger(
          health["expected_interval_seconds"],
          "invalid_forecast_quality_source_health",
        ),
        collection_age_seconds: nullableInteger(
          health["collection_age_seconds"],
          "invalid_forecast_quality_source_health",
        ),
        source_age_seconds: nullableInteger(
          health["source_age_seconds"],
          "invalid_forecast_quality_source_health",
        ),
        data_age_seconds: nullableInteger(
          health["data_age_seconds"],
          "invalid_forecast_quality_source_health",
        ),
        state: state as "healthy" | "delayed" | "stale" | "failed" | "unavailable",
        collection_state: collectionState as "healthy" | "delayed" | "failed" | "unavailable",
        freshness_state: freshnessState as
          | "fresh"
          | "delayed"
          | "stale"
          | "unknown"
          | "event_driven",
      };
    });
    if (parsedHealth.some((health, index) => health.source_id !== parsedSourceIds[index])) {
      throw new Error("invalid_forecast_quality_source_health");
    }
    return {
      series_key: seriesKey,
      source_ids: sourceIds.map((sourceId) =>
        text(sourceId, "invalid_forecast_quality_source", 120),
      ),
      interpretation: interpretation as
        | "diagnostic_product_pairing"
        | "forecast_vs_system_wide_hsl",
      health: parsedHealth,
    };
  });
  if (new Set(sourceContracts.map((item) => item.series_key)).size !== 3) {
    throw new Error("invalid_forecast_quality_source_identity");
  }
  if (
    sourceContracts.some(
      (contract, index) => contract.series_key !== FORECAST_QUALITY_SERIES[index],
    )
  ) {
    throw new Error("invalid_forecast_quality_source_order");
  }
  return {
    schema: 1,
    kind: "forecast_quality_manifest",
    methodology_version: "v1",
    dataset_updated_through: nullableInteger(
      input["dataset_updated_through"],
      "invalid_forecast_quality_manifest",
    ),
    window_days: 90,
    supported_series: [...FORECAST_QUALITY_SERIES],
    supported_horizons: [...FORECAST_QUALITY_HORIZONS],
    source_contracts: sourceContracts,
    summaries,
    resources,
  };
}

export function parseForecastQualityResource(
  value: unknown,
  expected?: ForecastQualityManifest["resources"][number],
): ForecastQualityResource {
  const input = record(value, "invalid_forecast_quality_resource");
  const seriesKey = series(input["series_key"]);
  const selectedHorizon = horizon(input["horizon"]);
  const horizonSeconds: 3_600 | 21_600 | 86_400 = {
    "1h": 3_600 as const,
    "6h": 21_600 as const,
    "24h": 86_400 as const,
  }[selectedHorizon];
  const dayStart = integer(input["day_start"], "invalid_forecast_quality_resource");
  const dayEnd = integer(input["day_end"], "invalid_forecast_quality_resource");
  const contentVersion = text(input["content_version"], "invalid_forecast_quality_resource", 67);
  if (
    input["schema"] !== 1 ||
    input["kind"] !== "forecast_quality_daily" ||
    input["methodology_version"] !== "v1" ||
    input["tile_span"] !== "1d" ||
    input["unit"] !== "MW" ||
    input["horizon_seconds"] !== horizonSeconds ||
    dayStart % 86_400 !== 0 ||
    dayEnd !== dayStart + 86_400 ||
    !CONTENT_VERSION.test(contentVersion)
  ) {
    throw new Error("invalid_forecast_quality_resource");
  }
  if (
    expected &&
    (expected.series_key !== seriesKey ||
      expected.horizon !== selectedHorizon ||
      expected.day_start !== dayStart ||
      expected.content_version !== contentVersion)
  ) {
    throw new Error("forecast_quality_resource_identity_mismatch");
  }
  const methodology = record(input["methodology"], "invalid_forecast_quality_methodology");
  const expectedModelPolicy =
    seriesKey === "load.system" ? "exactly_one_in_use_row" : "product_implicit_model";
  if (
    methodology["selection"] !== "per_target_latest_issue_at_or_before_cutoff" ||
    methodology["lead_window"] !== "[horizon,horizon+3600)" ||
    methodology["model_policy"] !== expectedModelPolicy ||
    methodology["error_formula"] !== "actual_minus_forecast" ||
    methodology["positive_error_meaning"] !== "underforecast" ||
    methodology["mape_denominator"] !== "positive_actual_only" ||
    methodology["quantile_method"] !== "Type 7"
  ) {
    throw new Error("invalid_forecast_quality_methodology");
  }
  const rawRows = input["rows"];
  if (!Array.isArray(rawRows) || rawRows.length !== 24) {
    throw new Error("invalid_forecast_quality_rows");
  }
  const rows = rawRows.map((item, index): ForecastQualityRow => {
    const row = record(item, "invalid_forecast_quality_row");
    const target = integer(row["target_ts"], "invalid_forecast_quality_row");
    if (target !== dayStart + index * 3_600) throw new Error("invalid_forecast_quality_order");
    const deliveryDate = text(row["delivery_date"], "invalid_forecast_quality_row", 10);
    if (!DATE.test(deliveryDate)) throw new Error("invalid_forecast_quality_row");
    const parsed: ForecastQualityRow = {
      target_ts: target,
      delivery_date: deliveryDate,
      forecast_mw: nullableFinite(row["forecast_mw"], "invalid_forecast_quality_row"),
      actual_mw: nullableFinite(row["actual_mw"], "invalid_forecast_quality_row"),
      error_mw: nullableFinite(row["error_mw"], "invalid_forecast_quality_row"),
      absolute_error_mw: nullableFinite(row["absolute_error_mw"], "invalid_forecast_quality_row"),
      absolute_percentage_error: nullableFinite(
        row["absolute_percentage_error"],
        "invalid_forecast_quality_row",
      ),
      revision_mw: nullableFinite(row["revision_mw"], "invalid_forecast_quality_row"),
      selected_issue_at: nullableInteger(row["selected_issue_at"], "invalid_forecast_quality_row"),
      effective_lead_seconds: nullableInteger(
        row["effective_lead_seconds"],
        "invalid_forecast_quality_row",
      ),
      model: nullableText(row["model"], "invalid_forecast_quality_row"),
      forecast_vintage_key: nullableText(
        row["forecast_vintage_key"],
        "invalid_forecast_quality_row",
      ),
      actual_vintage_key: nullableText(row["actual_vintage_key"], "invalid_forecast_quality_row"),
      missing_reason: nullableText(row["missing_reason"], "invalid_forecast_quality_row"),
    };
    const complete =
      parsed.forecast_mw !== null &&
      parsed.actual_mw !== null &&
      parsed.error_mw !== null &&
      parsed.absolute_error_mw !== null &&
      parsed.selected_issue_at !== null &&
      parsed.effective_lead_seconds !== null &&
      parsed.model !== null &&
      parsed.forecast_vintage_key !== null &&
      parsed.actual_vintage_key !== null &&
      parsed.missing_reason === null;
    if (complete) {
      const error = parsed.actual_mw! - parsed.forecast_mw!;
      const expectedApe =
        parsed.actual_mw! > 0 ? (100 * Math.abs(error)) / Math.abs(parsed.actual_mw!) : null;
      if (
        !close(parsed.error_mw!, error) ||
        !close(parsed.absolute_error_mw!, Math.abs(error)) ||
        parsed.effective_lead_seconds !== target - parsed.selected_issue_at! ||
        parsed.effective_lead_seconds < horizonSeconds ||
        parsed.effective_lead_seconds >= horizonSeconds + 3_600 ||
        (expectedApe === null
          ? parsed.absolute_percentage_error !== null
          : parsed.absolute_percentage_error === null ||
            !close(parsed.absolute_percentage_error, expectedApe))
      ) {
        throw new Error("invalid_forecast_quality_formula");
      }
    } else if (
      parsed.error_mw !== null ||
      parsed.absolute_error_mw !== null ||
      parsed.absolute_percentage_error !== null ||
      parsed.missing_reason === null
    ) {
      throw new Error("invalid_forecast_quality_null_contract");
    }
    return parsed;
  });
  const resourceSummary = summary(input["summary"]);
  const validRows = rows.filter((row) => row.error_mw !== null);
  const validApe = rows.filter((row) => row.absolute_percentage_error !== null);
  if (
    resourceSummary.sample_count !== validRows.length ||
    resourceSummary.mape_sample_count !== validApe.length
  ) {
    throw new Error("invalid_forecast_quality_summary_counts");
  }
  return {
    schema: 1,
    kind: "forecast_quality_daily",
    series_key: seriesKey,
    horizon: selectedHorizon,
    horizon_seconds: horizonSeconds,
    tile_span: "1d",
    day_start: dayStart,
    day_end: dayEnd,
    unit: "MW",
    methodology_version: "v1",
    content_version: contentVersion,
    methodology: {
      selection: "per_target_latest_issue_at_or_before_cutoff",
      lead_window: "[horizon,horizon+3600)",
      model_policy: expectedModelPolicy,
      error_formula: "actual_minus_forecast",
      positive_error_meaning: "underforecast",
      mape_denominator: "positive_actual_only",
      quantile_method: "Type 7",
      diagnostic_pairing: (() => {
        const pairing = text(
          methodology["diagnostic_pairing"],
          "invalid_forecast_quality_methodology",
        );
        if (pairing !== DIAGNOSTIC_PAIRING[seriesKey]) {
          throw new Error("invalid_forecast_quality_pairing");
        }
        return pairing;
      })(),
    },
    model_counts: counts(input["model_counts"], "invalid_forecast_quality_models"),
    missing_reasons: counts(input["missing_reasons"], "invalid_forecast_quality_reasons"),
    summary: resourceSummary,
    rows,
  };
}
