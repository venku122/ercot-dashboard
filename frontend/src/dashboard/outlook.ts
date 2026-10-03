export type OutlookPublication = {
  declared_unit: "MW";
  issued_at: number;
  product_id: "NP3-565-CD" | "NP3-763-CD";
  retrieved_at: number;
  source_id: "ercot_public_np3_565_weather_zone_forecast" | "ercot_public_np3_763_system_adequacy";
  vintage_key: string;
};

export type OutlookSourceHealth = {
  availability_status: "available" | "empty" | null;
  consecutive_failures: number;
  data_timestamp_ts: number | null;
  display_name: string;
  freshness_state: "delayed" | "event_driven" | "fresh" | "stale" | "unknown";
  last_success_ts: number | null;
  source_id: string;
  source_timestamp_ts: number | null;
  state: "delayed" | "failed" | "healthy" | "stale";
};

export type OutlookForecastRow = {
  delivery_date: string;
  demand_mw: number | null;
  dst_flag: boolean;
  hour_ending: string;
  model: string;
  revision_mw: number | null;
  target_ts: number;
};

export type OutlookAdequacyRow = {
  available_generation_mw: number | null;
  delivery_date: string;
  hour_ending: string;
  projected_headroom_mw: number | null;
  repeat_hour_flag: boolean;
  target_ts: number;
};

export type OutlookWeatherObservation = {
  label: string;
  observed_at: number | null;
  station_code: "KAUS" | "KDFW" | "KHOU" | "KSAT";
  temperature_c: number | null;
};

export type OutlookResponse = {
  adequacy: {
    headroom_definition: "AvailCapGen minus forecasted Demand for each hour";
    headroom_field: "availCapRes";
    publication: OutlookPublication | null;
    rows: OutlookAdequacyRow[];
    source_health: OutlookSourceHealth | null;
  };
  forecast: {
    publication: OutlookPublication | null;
    revision_policy: "latest_issued_at_least_24h_before_current";
    revision_reference: OutlookPublication | null;
    rows: OutlookForecastRow[];
    selection_policy: "in_use_flag_true";
    source_health: OutlookSourceHealth | null;
  };
  interpretation: {
    kind: "dashboard_outlook";
    official_ercot_status: false;
    status: null;
  };
  schema: 1;
  weather_context: {
    driver: null;
    forecast_driver_available: false;
    observations: OutlookWeatherObservation[];
    source:
      | null
      | (OutlookSourceHealth & {
          expected_interval_seconds: number;
          source_id: "metar";
        });
    state: "current_observations_only";
  };
};

export type OutlookDayCard = {
  deliveryDate: string;
  peakDemandMw: number | null;
  peakRevisionMw: number | null;
  peakTargetTs: number | null;
  projectedHeadroomMw: number | null;
  tightestTargetTs: number | null;
};

export type OutlookDayDetail = {
  card: OutlookDayCard;
  hours: Array<{
    demandMw: number | null;
    projectedHeadroomMw: number | null;
    revisionMw: number | null;
    targetTs: number;
  }>;
};

export type GridOutlook = {
  cards: OutlookDayCard[];
  days: OutlookDayDetail[];
  forecastAgeSeconds: number | null;
  forecastIssuedAt: number | null;
  forecastModel: string | null;
  forecastSourceHealth: OutlookSourceHealth | null;
  next24Hours: Array<[number, number]>;
  projectedPeakMw: number | null;
  projectedPeakTargetTs: number | null;
  sourceLabel: string;
  tightestHeadroomMw: number | null;
  tightestTargetTs: number | null;
  adequacySourceHealth: OutlookSourceHealth | null;
  weather: OutlookResponse["weather_context"];
};

const FORECAST_SOURCE = "ercot_public_np3_565_weather_zone_forecast";
const ADEQUACY_SOURCE = "ercot_public_np3_763_system_adequacy";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATION_CODES = new Set(["KDFW", "KAUS", "KHOU", "KSAT"]);

type RawRecord = Record<string, unknown> & {
  adequacy?: unknown;
  availability_status?: unknown;
  available_generation_mw?: unknown;
  consecutive_failures?: unknown;
  data_timestamp_ts?: unknown;
  declared_unit?: unknown;
  delivery_date?: unknown;
  demand_mw?: unknown;
  display_name?: unknown;
  driver?: unknown;
  dst_flag?: unknown;
  expected_interval_seconds?: unknown;
  forecast?: unknown;
  forecast_driver_available?: unknown;
  freshness_state?: unknown;
  headroom_definition?: unknown;
  headroom_field?: unknown;
  hour_ending?: unknown;
  interpretation?: unknown;
  issued_at?: unknown;
  kind?: unknown;
  label?: unknown;
  last_success_ts?: unknown;
  model?: unknown;
  observations?: unknown;
  observed_at?: unknown;
  official_ercot_status?: unknown;
  product_id?: unknown;
  projected_headroom_mw?: unknown;
  publication?: unknown;
  repeat_hour_flag?: unknown;
  retrieved_at?: unknown;
  revision_mw?: unknown;
  revision_policy?: unknown;
  revision_reference?: unknown;
  rows?: unknown;
  schema?: unknown;
  selection_policy?: unknown;
  source?: unknown;
  source_health?: unknown;
  source_id?: unknown;
  source_timestamp_ts?: unknown;
  state?: unknown;
  station_code?: unknown;
  status?: unknown;
  target_ts?: unknown;
  temperature_c?: unknown;
  vintage_key?: unknown;
  weather_context?: unknown;
};

function record(value: unknown, name: string): RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_outlook_${name}`);
  }
  return value as RawRecord;
}

function finite(value: unknown, name: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid_outlook_${name}`);
  }
  return value;
}

function integer(value: unknown, name: string, nullable = false): number | null {
  const parsed = finite(value, name, nullable);
  if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
    throw new Error(`invalid_outlook_${name}`);
  }
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    throw new Error(`invalid_outlook_${name}`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid_outlook_${name}`);
  return value;
}

function publication(value: unknown, product: "NP3-565-CD" | "NP3-763-CD") {
  if (value === null) return null;
  const item = record(value, "publication");
  const source = product === "NP3-565-CD" ? FORECAST_SOURCE : ADEQUACY_SOURCE;
  if (item.source_id !== source || item.product_id !== product || item.declared_unit !== "MW") {
    throw new Error("invalid_outlook_publication_identity");
  }
  return {
    source_id: source,
    product_id: product,
    vintage_key: (() => {
      const key = text(item.vintage_key, "vintage_key");
      if (!/^v1-[0-9a-f]{64}$/.test(key)) throw new Error("invalid_outlook_vintage_key");
      return key;
    })(),
    issued_at: integer(item.issued_at, "issued_at")!,
    retrieved_at: integer(item.retrieved_at, "retrieved_at")!,
    declared_unit: "MW" as const,
  } as OutlookPublication;
}

function sourceHealth(value: unknown, expectedSource: string): OutlookSourceHealth | null {
  if (value === null) return null;
  const item = record(value, "source_health");
  const states = new Set(["delayed", "failed", "healthy", "stale"]);
  const freshnessStates = new Set(["delayed", "event_driven", "fresh", "stale", "unknown"]);
  if (
    item.source_id !== expectedSource ||
    !states.has(String(item.state)) ||
    !freshnessStates.has(String(item.freshness_state)) ||
    ![null, "available", "empty"].includes(item.availability_status as null | string)
  ) {
    throw new Error("invalid_outlook_source_health");
  }
  return {
    source_id: expectedSource,
    display_name: text(item.display_name, "source_display_name"),
    availability_status: item.availability_status as OutlookSourceHealth["availability_status"],
    state: item.state as OutlookSourceHealth["state"],
    freshness_state: item.freshness_state as OutlookSourceHealth["freshness_state"],
    consecutive_failures: integer(item.consecutive_failures, "source_failures")!,
    last_success_ts: integer(item.last_success_ts, "source_last_success", true),
    source_timestamp_ts: integer(item.source_timestamp_ts, "source_timestamp", true),
    data_timestamp_ts: integer(item.data_timestamp_ts, "source_data_timestamp", true),
  };
}

function sortedTargets<T extends { target_ts: number }>(rows: T[], name: string): T[] {
  if (rows.length > 193) throw new Error("invalid_outlook_target_limit");
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.target_ts <= rows[index - 1]!.target_ts) {
      throw new Error(`invalid_outlook_${name}_ordering`);
    }
  }
  return rows;
}

export function parseOutlookResponse(value: unknown): OutlookResponse {
  const root = record(value, "response");
  if (root.schema !== 1) throw new Error("invalid_outlook_schema");
  const forecast = record(root.forecast, "forecast");
  const adequacy = record(root.adequacy, "adequacy");
  const interpretation = record(root.interpretation, "interpretation");
  const weather = record(root.weather_context, "weather");
  if (
    forecast.selection_policy !== "in_use_flag_true" ||
    forecast.revision_policy !== "latest_issued_at_least_24h_before_current" ||
    adequacy.headroom_field !== "availCapRes" ||
    adequacy.headroom_definition !== "AvailCapGen minus forecasted Demand for each hour" ||
    interpretation.kind !== "dashboard_outlook" ||
    interpretation.official_ercot_status !== false ||
    interpretation.status !== null
  ) {
    throw new Error("invalid_outlook_semantics");
  }
  if (!Array.isArray(forecast.rows) || !Array.isArray(adequacy.rows)) {
    throw new Error("invalid_outlook_rows");
  }
  const forecastRows = sortedTargets(
    forecast.rows.map((raw) => {
      const row = record(raw, "forecast_row");
      const deliveryDate = text(row.delivery_date, "delivery_date");
      if (!DATE_PATTERN.test(deliveryDate)) throw new Error("invalid_outlook_delivery_date");
      return {
        target_ts: integer(row.target_ts, "target_ts")!,
        delivery_date: deliveryDate,
        hour_ending: text(row.hour_ending, "hour_ending"),
        dst_flag: boolean(row.dst_flag, "dst_flag"),
        model: text(row.model, "model"),
        demand_mw: finite(row.demand_mw, "demand_mw", true),
        revision_mw: finite(row.revision_mw, "revision_mw", true),
      };
    }),
    "forecast",
  );
  const adequacyRows = sortedTargets(
    adequacy.rows.map((raw) => {
      const row = record(raw, "adequacy_row");
      const deliveryDate = text(row.delivery_date, "delivery_date");
      if (!DATE_PATTERN.test(deliveryDate)) throw new Error("invalid_outlook_delivery_date");
      return {
        target_ts: integer(row.target_ts, "target_ts")!,
        delivery_date: deliveryDate,
        hour_ending: text(row.hour_ending, "hour_ending"),
        repeat_hour_flag: boolean(row.repeat_hour_flag, "repeat_hour_flag"),
        available_generation_mw: finite(
          row.available_generation_mw,
          "available_generation_mw",
          true,
        ),
        projected_headroom_mw: finite(row.projected_headroom_mw, "projected_headroom_mw", true),
      };
    }),
    "adequacy",
  );
  if (
    weather.state !== "current_observations_only" ||
    weather.forecast_driver_available !== false ||
    weather.driver !== null ||
    !Array.isArray(weather.observations)
  ) {
    throw new Error("invalid_outlook_weather_semantics");
  }
  const seenStations = new Set<string>();
  const observations = weather.observations.map((raw) => {
    const item = record(raw, "weather_observation");
    const code = text(item.station_code, "station_code");
    if (!STATION_CODES.has(code) || seenStations.has(code)) {
      throw new Error("invalid_outlook_station");
    }
    seenStations.add(code);
    return {
      station_code: code as OutlookWeatherObservation["station_code"],
      label: text(item.label, "station_label"),
      observed_at: integer(item.observed_at, "observed_at", true),
      temperature_c: finite(item.temperature_c, "temperature_c", true),
    };
  });
  let weatherSource: OutlookResponse["weather_context"]["source"] = null;
  if (weather.source !== null) {
    const source = record(weather.source, "weather_source");
    if (source.source_id !== "metar") throw new Error("invalid_outlook_weather_source");
    const health = sourceHealth(source, "metar");
    if (health === null) throw new Error("invalid_outlook_weather_source");
    weatherSource = {
      ...health,
      source_id: "metar" as const,
      expected_interval_seconds: integer(source.expected_interval_seconds, "weather_interval")!,
    };
  }
  const forecastPublication = publication(forecast.publication, "NP3-565-CD");
  const adequacyPublication = publication(adequacy.publication, "NP3-763-CD");
  if ((forecastPublication === null) !== (forecastRows.length === 0)) {
    throw new Error("invalid_outlook_forecast_presence");
  }
  if ((adequacyPublication === null) !== (adequacyRows.length === 0)) {
    throw new Error("invalid_outlook_adequacy_presence");
  }
  const revisionReference = publication(forecast.revision_reference, "NP3-565-CD");
  if (forecastPublication === null && revisionReference !== null) {
    throw new Error("invalid_outlook_revision_presence");
  }
  return {
    schema: 1,
    forecast: {
      publication: forecastPublication,
      selection_policy: "in_use_flag_true",
      revision_reference: revisionReference,
      revision_policy: "latest_issued_at_least_24h_before_current",
      rows: forecastRows,
      source_health: sourceHealth(forecast.source_health, FORECAST_SOURCE),
    },
    adequacy: {
      publication: adequacyPublication,
      headroom_field: "availCapRes",
      headroom_definition: "AvailCapGen minus forecasted Demand for each hour",
      rows: adequacyRows,
      source_health: sourceHealth(adequacy.source_health, ADEQUACY_SOURCE),
    },
    weather_context: {
      state: "current_observations_only",
      forecast_driver_available: false,
      driver: null,
      source: weatherSource,
      observations,
    },
    interpretation: {
      kind: "dashboard_outlook",
      official_ercot_status: false,
      status: null,
    },
  };
}

function peak(rows: OutlookForecastRow[]) {
  return rows.reduce<OutlookForecastRow | null>(
    (best, row) =>
      row.demand_mw !== null &&
      (best?.demand_mw === null || best === null || row.demand_mw > best.demand_mw!)
        ? row
        : best,
    null,
  );
}

export function buildGridOutlook(response: OutlookResponse, now: number): GridOutlook {
  if (!Number.isInteger(now) || now < 0) throw new Error("invalid_outlook_now");
  const futureRows = response.forecast.rows.filter((row) => row.target_ts > now);
  const next24Rows = futureRows.filter((row) => row.target_ts <= now + 86_400);
  const deliveryDates = [...new Set(futureRows.map((row) => row.delivery_date))].slice(0, 7);
  const adequacyByTarget = new Map(
    response.adequacy.rows.map((row) => [row.target_ts, row] as const),
  );
  const cards = deliveryDates.map((deliveryDate) => {
    const rows = futureRows.filter((row) => row.delivery_date === deliveryDate);
    const dayPeak = peak(rows);
    const tightest = rows.reduce<OutlookAdequacyRow | null>((best, row) => {
      const adequacy = adequacyByTarget.get(row.target_ts);
      if (adequacy?.projected_headroom_mw === null || adequacy === undefined) return best;
      return best === null ||
        best.projected_headroom_mw === null ||
        adequacy.projected_headroom_mw < best.projected_headroom_mw
        ? adequacy
        : best;
    }, null);
    return {
      deliveryDate,
      peakDemandMw: dayPeak?.demand_mw ?? null,
      peakTargetTs: dayPeak?.target_ts ?? null,
      peakRevisionMw: dayPeak?.revision_mw ?? null,
      projectedHeadroomMw: tightest?.projected_headroom_mw ?? null,
      tightestTargetTs: tightest?.target_ts ?? null,
    };
  });
  const days = cards.map((card) => ({
    card,
    hours: futureRows
      .filter((row) => row.delivery_date === card.deliveryDate)
      .map((row) => ({
        targetTs: row.target_ts,
        demandMw: row.demand_mw,
        projectedHeadroomMw: adequacyByTarget.get(row.target_ts)?.projected_headroom_mw ?? null,
        revisionMw: row.revision_mw,
      })),
  }));
  const sevenDayRows = futureRows.filter((row) => deliveryDates.includes(row.delivery_date));
  const overallPeak = peak(sevenDayRows);
  const tightestCard = cards.reduce<OutlookDayCard | null>(
    (best, card) =>
      card.projectedHeadroomMw !== null &&
      (best?.projectedHeadroomMw === null ||
        best === null ||
        card.projectedHeadroomMw < best.projectedHeadroomMw)
        ? card
        : best,
    null,
  );
  const models = new Set(sevenDayRows.map((row) => row.model));
  const publication = response.forecast.publication;
  return {
    cards,
    days,
    next24Hours: next24Rows.flatMap((row) =>
      row.demand_mw === null ? [] : ([[row.target_ts, row.demand_mw]] as Array<[number, number]>),
    ),
    projectedPeakMw: overallPeak?.demand_mw ?? null,
    projectedPeakTargetTs: overallPeak?.target_ts ?? null,
    tightestHeadroomMw: tightestCard?.projectedHeadroomMw ?? null,
    tightestTargetTs: tightestCard?.tightestTargetTs ?? null,
    forecastIssuedAt: publication?.issued_at ?? null,
    forecastAgeSeconds: publication === null ? null : Math.max(0, now - publication.issued_at),
    forecastModel: models.size === 1 ? ([...models][0] ?? null) : null,
    forecastSourceHealth: response.forecast.source_health,
    adequacySourceHealth: response.adequacy.source_health,
    sourceLabel: "ERCOT NP3-565 load forecast and NP3-763 system adequacy",
    weather: response.weather_context,
  };
}
