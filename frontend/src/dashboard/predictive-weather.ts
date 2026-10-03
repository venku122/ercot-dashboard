export const PREDICTIVE_WEATHER_POINTS = ["KDFW", "KAUS", "KHOU", "KSAT"] as const;
export const PREDICTIVE_WEATHER_LAYERS = [
  "temperature",
  "apparentTemperature",
  "heatIndex",
  "windChill",
  "windSpeed",
  "windGust",
] as const;

export type PredictiveWeatherPointId = (typeof PREDICTIVE_WEATHER_POINTS)[number];
export type PredictiveWeatherLayerName = (typeof PREDICTIVE_WEATHER_LAYERS)[number];
export type PredictiveWeatherState = "available" | "partial" | "stale" | "failed" | "unavailable";

export type PredictiveWeatherInterval = {
  valid_start: number;
  valid_end: number;
  value: number | null;
};

export type PredictiveWeatherLayer = {
  key: PredictiveWeatherLayerName;
  unit: "wmoUnit:degC" | "wmoUnit:km_h-1";
  rows: PredictiveWeatherInterval[];
};

export type PredictiveWeatherPoint = {
  point_id: PredictiveWeatherPointId;
  label: string;
  latitude: number;
  longitude: number;
  state: "available" | "stale" | "unavailable";
  mapping: null | {
    grid_id: string;
    grid_x: number;
    grid_y: number;
    forecast_grid_data_url: string;
    time_zone: string;
  };
  update_time: number | null;
  retrieved_at: number | null;
  cache_fresh_until: number | null;
  layers: PredictiveWeatherLayer[];
};

export type PredictiveWeatherAlert = {
  id: string;
  area_desc: string;
  sent: number;
  effective: number;
  onset: number | null;
  expires: number;
  ends: number | null;
  event: string;
  severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  urgency: "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
  certainty: "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown";
  headline: string | null;
  description: string;
  instruction: string | null;
  message_type: "Alert" | "Update" | "Cancel" | "Ack" | "Error";
  response: string;
  affected_zones: string[];
  references: Array<{ identifier: string; sender: string; sent: number }>;
  source_url: string;
};

export type PredictiveWeatherManifest = {
  schema: 1;
  kind: "predictive_weather";
  registry_version: "representative-airport-points-v1";
  policy: "representative_point_weather_context_not_grid_alert_or_load_causality";
  generated_at: number;
  forecast: {
    state: PredictiveWeatherState;
    content_version: string | null;
    points: PredictiveWeatherPoint[];
  };
  alerts: {
    state: PredictiveWeatherState | "valid_empty";
    coverage: "texas_statewide_not_ercot_footprint";
    collection_updated_at: number | null;
    retrieved_at: number | null;
    cache_fresh_until: number | null;
    content_version: string | null;
    truncated: boolean;
    items: PredictiveWeatherAlert[];
  };
  source_health: Array<{
    source_id: string;
    state: "healthy" | "stale" | "failed" | "unavailable";
    availability_status: "available" | "empty" | null;
    content_version: string | null;
    last_attempt_ts: number | null;
    last_success_ts: number | null;
    source_updated_at: number | null;
    retrieved_at: number | null;
    cache_fresh_until: number | null;
    consecutive_failures: number;
    last_error: string | null;
    materialization: {
      state: "healthy" | "failed" | "unavailable";
      last_success_ts: number | null;
      consecutive_failures: number | null;
      last_error: string | null;
    };
  }>;
};

const POINTS: Record<
  PredictiveWeatherPointId,
  { label: string; latitude: number; longitude: number }
> = {
  KDFW: { label: "Dallas/Fort Worth", latitude: 32.8974, longitude: -97.022 },
  KAUS: { label: "Austin", latitude: 30.1831, longitude: -97.6806 },
  KHOU: { label: "Houston Hobby", latitude: 29.6458, longitude: -95.2821 },
  KSAT: { label: "San Antonio", latitude: 29.5443, longitude: -98.4839 },
};

function object(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], error: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(error);
}

function integer(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(error);
  return value;
}

function finite(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function nullableInteger(value: unknown, error: string): number | null {
  return value === null ? null : integer(value, error);
}

function text(value: unknown, error: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(error);
  return value;
}

function nullableText(value: unknown, error: string, maximum = 2_000): string | null {
  return value === null ? null : text(value, error, maximum);
}

function state(value: unknown): PredictiveWeatherState {
  if (!["available", "partial", "stale", "failed", "unavailable"].includes(String(value))) {
    throw new Error("invalid_predictive_weather_state");
  }
  return value as PredictiveWeatherState;
}

function parseLayer(value: unknown): PredictiveWeatherLayer {
  const layer = object(value, "invalid_predictive_weather_layer");
  exact(layer, ["key", "unit", "rows"], "invalid_predictive_weather_layer");
  if (!PREDICTIVE_WEATHER_LAYERS.includes(layer["key"] as PredictiveWeatherLayerName)) {
    throw new Error("invalid_predictive_weather_layer");
  }
  const key = layer["key"] as PredictiveWeatherLayerName;
  const expectedUnit =
    key === "windSpeed" || key === "windGust" ? "wmoUnit:km_h-1" : "wmoUnit:degC";
  if (
    layer["unit"] !== expectedUnit ||
    !Array.isArray(layer["rows"]) ||
    layer["rows"].length > 512
  ) {
    throw new Error("invalid_predictive_weather_layer");
  }
  let priorEnd = -1;
  const rows = layer["rows"].map((raw) => {
    const interval = object(raw, "invalid_predictive_weather_interval");
    exact(interval, ["valid_start", "valid_end", "value"], "invalid_predictive_weather_interval");
    const validStart = integer(interval["valid_start"], "invalid_predictive_weather_interval");
    const validEnd = integer(interval["valid_end"], "invalid_predictive_weather_interval");
    const intervalValue =
      interval["value"] === null
        ? null
        : finite(interval["value"], "invalid_predictive_weather_interval");
    if (validEnd <= validStart || validStart < priorEnd)
      throw new Error("invalid_predictive_weather_interval");
    priorEnd = validEnd;
    return { valid_start: validStart, valid_end: validEnd, value: intervalValue };
  });
  return { key, unit: expectedUnit, rows };
}

function parsePoint(value: unknown, expectedId: PredictiveWeatherPointId): PredictiveWeatherPoint {
  const point = object(value, "invalid_predictive_weather_point");
  exact(
    point,
    [
      "point_id",
      "label",
      "latitude",
      "longitude",
      "state",
      "mapping",
      "update_time",
      "retrieved_at",
      "cache_fresh_until",
      "layers",
    ],
    "invalid_predictive_weather_point",
  );
  const frozen = POINTS[expectedId];
  if (
    point["point_id"] !== expectedId ||
    point["label"] !== frozen.label ||
    point["latitude"] !== frozen.latitude ||
    point["longitude"] !== frozen.longitude
  ) {
    throw new Error("invalid_predictive_weather_point_identity");
  }
  const pointState = state(point["state"]);
  if (pointState !== "available" && pointState !== "stale" && pointState !== "unavailable") {
    throw new Error("invalid_predictive_weather_point_state");
  }
  let mapping: PredictiveWeatherPoint["mapping"] = null;
  if (point["mapping"] !== null) {
    const raw = object(point["mapping"], "invalid_predictive_weather_mapping");
    exact(
      raw,
      ["grid_id", "grid_x", "grid_y", "forecast_grid_data_url", "time_zone"],
      "invalid_predictive_weather_mapping",
    );
    const gridId = text(raw["grid_id"], "invalid_predictive_weather_mapping", 8);
    const gridX = integer(raw["grid_x"], "invalid_predictive_weather_mapping");
    const gridY = integer(raw["grid_y"], "invalid_predictive_weather_mapping");
    const forecastGridData = text(
      raw["forecast_grid_data_url"],
      "invalid_predictive_weather_mapping",
      256,
    );
    if (forecastGridData !== `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}`) {
      throw new Error("invalid_predictive_weather_mapping");
    }
    mapping = {
      grid_id: gridId,
      grid_x: gridX,
      grid_y: gridY,
      forecast_grid_data_url: forecastGridData,
      time_zone: text(raw["time_zone"], "invalid_predictive_weather_mapping", 80),
    };
  }
  if (!Array.isArray(point["layers"])) throw new Error("invalid_predictive_weather_point");
  const layers = point["layers"].map(parseLayer);
  if (
    layers.length !== PREDICTIVE_WEATHER_LAYERS.length ||
    layers.some((layer, index) => layer.key !== PREDICTIVE_WEATHER_LAYERS[index])
  ) {
    throw new Error("invalid_predictive_weather_point");
  }
  if (pointState === "unavailable" ? mapping !== null : mapping === null) {
    throw new Error("invalid_predictive_weather_point_state");
  }
  return {
    point_id: expectedId,
    label: frozen.label,
    latitude: frozen.latitude,
    longitude: frozen.longitude,
    state: pointState,
    mapping,
    update_time: nullableInteger(point["update_time"], "invalid_predictive_weather_point"),
    retrieved_at: nullableInteger(point["retrieved_at"], "invalid_predictive_weather_point"),
    cache_fresh_until: nullableInteger(
      point["cache_fresh_until"],
      "invalid_predictive_weather_point",
    ),
    layers,
  };
}

function parseAlert(value: unknown): PredictiveWeatherAlert {
  const alert = object(value, "invalid_predictive_weather_alert");
  exact(
    alert,
    [
      "id",
      "event",
      "headline",
      "area_desc",
      "severity",
      "urgency",
      "certainty",
      "message_type",
      "sent",
      "effective",
      "onset",
      "expires",
      "ends",
      "description",
      "instruction",
      "response",
      "affected_zones",
      "references",
      "source_url",
    ],
    "invalid_predictive_weather_alert",
  );
  const enumValue = <T extends string>(raw: unknown, values: readonly T[]) => {
    if (!values.includes(raw as T)) throw new Error("invalid_predictive_weather_alert");
    return raw as T;
  };
  const sourceUrl = text(alert["source_url"], "invalid_predictive_weather_alert", 512);
  if (!sourceUrl.startsWith("https://api.weather.gov/alerts/"))
    throw new Error("invalid_predictive_weather_alert");
  if (!Array.isArray(alert["affected_zones"]) || !Array.isArray(alert["references"])) {
    throw new Error("invalid_predictive_weather_alert");
  }
  const affectedZones = alert["affected_zones"].map((zone) => {
    const result = text(zone, "invalid_predictive_weather_alert", 512);
    if (!result.startsWith("https://api.weather.gov/zones/"))
      throw new Error("invalid_predictive_weather_alert");
    return result;
  });
  const references = alert["references"].map((raw) => {
    const reference = object(raw, "invalid_predictive_weather_alert");
    exact(reference, ["identifier", "sender", "sent"], "invalid_predictive_weather_alert");
    return {
      identifier: text(reference["identifier"], "invalid_predictive_weather_alert", 512),
      sender: text(reference["sender"], "invalid_predictive_weather_alert", 256),
      sent: integer(reference["sent"], "invalid_predictive_weather_alert"),
    };
  });
  return {
    id: text(alert["id"], "invalid_predictive_weather_alert", 512),
    area_desc: text(alert["area_desc"], "invalid_predictive_weather_alert", 2_000),
    sent: integer(alert["sent"], "invalid_predictive_weather_alert"),
    effective: integer(alert["effective"], "invalid_predictive_weather_alert"),
    onset: nullableInteger(alert["onset"], "invalid_predictive_weather_alert"),
    expires: integer(alert["expires"], "invalid_predictive_weather_alert"),
    ends: nullableInteger(alert["ends"], "invalid_predictive_weather_alert"),
    event: text(alert["event"], "invalid_predictive_weather_alert", 160),
    severity: enumValue(alert["severity"], ["Extreme", "Severe", "Moderate", "Minor", "Unknown"]),
    urgency: enumValue(alert["urgency"], ["Immediate", "Expected", "Future", "Past", "Unknown"]),
    certainty: enumValue(alert["certainty"], [
      "Observed",
      "Likely",
      "Possible",
      "Unlikely",
      "Unknown",
    ]),
    headline: nullableText(alert["headline"], "invalid_predictive_weather_alert"),
    description: text(alert["description"], "invalid_predictive_weather_alert", 16_000),
    instruction: nullableText(alert["instruction"], "invalid_predictive_weather_alert", 16_000),
    message_type: enumValue(alert["message_type"], ["Alert", "Update", "Cancel", "Ack", "Error"]),
    response: text(alert["response"], "invalid_predictive_weather_alert", 160),
    affected_zones: affectedZones,
    references,
    source_url: sourceUrl,
  };
}

export function parsePredictiveWeatherManifest(value: unknown): PredictiveWeatherManifest {
  const root = object(value, "invalid_predictive_weather_manifest");
  exact(
    root,
    [
      "schema",
      "kind",
      "registry_version",
      "policy",
      "generated_at",
      "forecast",
      "alerts",
      "source_health",
    ],
    "invalid_predictive_weather_manifest",
  );
  if (
    root["schema"] !== 1 ||
    root["kind"] !== "predictive_weather" ||
    root["registry_version"] !== "representative-airport-points-v1" ||
    root["policy"] !== "representative_point_weather_context_not_grid_alert_or_load_causality"
  ) {
    throw new Error("invalid_predictive_weather_manifest");
  }
  const forecast = object(root["forecast"], "invalid_predictive_weather_forecast");
  exact(forecast, ["state", "content_version", "points"], "invalid_predictive_weather_forecast");
  if (!Array.isArray(forecast["points"]) || forecast["points"].length !== 4)
    throw new Error("invalid_predictive_weather_forecast");
  const rawPoints = forecast["points"] as unknown[];
  const points = PREDICTIVE_WEATHER_POINTS.map((pointId, index) =>
    parsePoint(rawPoints[index], pointId),
  );
  const forecastState = state(forecast["state"]);
  const forecastContentVersion = nullableText(
    forecast["content_version"],
    "invalid_predictive_weather_forecast",
    68,
  );
  if (forecastContentVersion !== null && !/^pw1-[0-9a-f]{64}$/.test(forecastContentVersion)) {
    throw new Error("invalid_predictive_weather_forecast");
  }
  const pointStates = new Set(points.map((point) => point.state));
  if (
    (forecastState === "available" && (pointStates.size !== 1 || !pointStates.has("available"))) ||
    (forecastState === "stale" && (pointStates.size !== 1 || !pointStates.has("stale"))) ||
    ((forecastState === "failed" || forecastState === "unavailable") &&
      (pointStates.size !== 1 || !pointStates.has("unavailable"))) ||
    (forecastState === "partial" && pointStates.size < 2) ||
    (forecastState === "failed" || forecastState === "unavailable") !==
      (forecastContentVersion === null)
  ) {
    throw new Error("invalid_predictive_weather_forecast_state");
  }

  const alerts = object(root["alerts"], "invalid_predictive_weather_alerts");
  exact(
    alerts,
    [
      "state",
      "content_version",
      "coverage",
      "collection_updated_at",
      "retrieved_at",
      "cache_fresh_until",
      "truncated",
      "items",
    ],
    "invalid_predictive_weather_alerts",
  );
  const alertState = alerts["state"] === "valid_empty" ? "valid_empty" : state(alerts["state"]);
  if (
    alerts["coverage"] !== "texas_statewide_not_ercot_footprint" ||
    typeof alerts["truncated"] !== "boolean" ||
    !Array.isArray(alerts["items"]) ||
    alerts["items"].length > 2_000
  ) {
    throw new Error("invalid_predictive_weather_alerts");
  }
  const items = alerts["items"].map(parseAlert);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    (alertState === "valid_empty"
      ? items.length !== 0
      : alertState === "available" && items.length === 0)
  ) {
    throw new Error("invalid_predictive_weather_alerts");
  }
  const alertContentVersion = nullableText(
    alerts["content_version"],
    "invalid_predictive_weather_alerts",
    68,
  );
  if (alertContentVersion !== null && !/^pw1-[0-9a-f]{64}$/.test(alertContentVersion)) {
    throw new Error("invalid_predictive_weather_alerts");
  }

  if (!Array.isArray(root["source_health"]) || root["source_health"].length > 16)
    throw new Error("invalid_predictive_weather_health");
  const sourceHealth = root["source_health"].map((raw) => {
    const item = object(raw, "invalid_predictive_weather_health");
    exact(
      item,
      [
        "source_id",
        "state",
        "availability_status",
        "content_version",
        "last_attempt_ts",
        "last_success_ts",
        "source_updated_at",
        "retrieved_at",
        "cache_fresh_until",
        "consecutive_failures",
        "last_error",
        "materialization",
      ],
      "invalid_predictive_weather_health",
    );
    const healthState = String(item["state"]);
    if (!["healthy", "stale", "failed", "unavailable"].includes(healthState))
      throw new Error("invalid_predictive_weather_health");
    const availability = item["availability_status"];
    if (availability !== null && availability !== "available" && availability !== "empty")
      throw new Error("invalid_predictive_weather_health");
    const contentVersion = nullableText(
      item["content_version"],
      "invalid_predictive_weather_health",
      68,
    );
    if (contentVersion !== null && !/^pw1-[0-9a-f]{64}$/.test(contentVersion))
      throw new Error("invalid_predictive_weather_health");
    const materialization = object(item["materialization"], "invalid_predictive_weather_health");
    exact(
      materialization,
      ["state", "last_success_ts", "consecutive_failures", "last_error"],
      "invalid_predictive_weather_health",
    );
    const materializationState = String(materialization["state"]);
    if (!["healthy", "failed", "unavailable"].includes(materializationState))
      throw new Error("invalid_predictive_weather_health");
    return {
      source_id: text(item["source_id"], "invalid_predictive_weather_health", 80),
      state: healthState as PredictiveWeatherManifest["source_health"][number]["state"],
      availability_status: availability as "available" | "empty" | null,
      content_version: contentVersion,
      last_attempt_ts: nullableInteger(
        item["last_attempt_ts"],
        "invalid_predictive_weather_health",
      ),
      last_success_ts: nullableInteger(
        item["last_success_ts"],
        "invalid_predictive_weather_health",
      ),
      source_updated_at: nullableInteger(
        item["source_updated_at"],
        "invalid_predictive_weather_health",
      ),
      retrieved_at: nullableInteger(item["retrieved_at"], "invalid_predictive_weather_health"),
      cache_fresh_until: nullableInteger(
        item["cache_fresh_until"],
        "invalid_predictive_weather_health",
      ),
      consecutive_failures: integer(
        item["consecutive_failures"],
        "invalid_predictive_weather_health",
      ),
      last_error: nullableText(item["last_error"], "invalid_predictive_weather_health", 512),
      materialization: {
        state: materializationState as "healthy" | "failed" | "unavailable",
        last_success_ts: nullableInteger(
          materialization["last_success_ts"],
          "invalid_predictive_weather_health",
        ),
        consecutive_failures: nullableInteger(
          materialization["consecutive_failures"],
          "invalid_predictive_weather_health",
        ),
        last_error: nullableText(
          materialization["last_error"],
          "invalid_predictive_weather_health",
          512,
        ),
      },
    };
  });
  if (new Set(sourceHealth.map((item) => item.source_id)).size !== sourceHealth.length)
    throw new Error("invalid_predictive_weather_health");

  return {
    schema: 1,
    kind: "predictive_weather",
    registry_version: "representative-airport-points-v1",
    policy: "representative_point_weather_context_not_grid_alert_or_load_causality",
    generated_at: integer(root["generated_at"], "invalid_predictive_weather_manifest"),
    forecast: { state: forecastState, content_version: forecastContentVersion, points },
    alerts: {
      state: alertState,
      content_version: alertContentVersion,
      coverage: "texas_statewide_not_ercot_footprint",
      collection_updated_at: nullableInteger(
        alerts["collection_updated_at"],
        "invalid_predictive_weather_alerts",
      ),
      retrieved_at: nullableInteger(alerts["retrieved_at"], "invalid_predictive_weather_alerts"),
      cache_fresh_until: nullableInteger(
        alerts["cache_fresh_until"],
        "invalid_predictive_weather_alerts",
      ),
      truncated: alerts["truncated"],
      items,
    },
    source_health: sourceHealth,
  };
}

export function intervalAt(
  point: PredictiveWeatherPoint,
  layerName: PredictiveWeatherLayerName,
  targetTs: number,
): PredictiveWeatherInterval | null {
  return (
    point.layers
      .find((layer) => layer.key === layerName)
      ?.rows.find(
        (interval) => interval.valid_start <= targetTs && targetTs < interval.valid_end,
      ) ?? null
  );
}
