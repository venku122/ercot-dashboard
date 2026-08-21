export const NWS_WEATHER_SCHEMA = 1 as const;
export const NWS_WEATHER_POINTS = Object.freeze({
  KDFW: {
    label: "Dallas/Fort Worth",
    latitude: 32.8974,
    longitude: -97.022,
  },
  KAUS: { label: "Austin", latitude: 30.1831, longitude: -97.6806 },
  KHOU: { label: "Houston Hobby", latitude: 29.6458, longitude: -95.2821 },
  KSAT: { label: "San Antonio", latitude: 29.5443, longitude: -98.4839 },
} as const);
export type NwsPointId = keyof typeof NWS_WEATHER_POINTS;

export const NWS_GRID_LAYERS = Object.freeze({
  temperature: "wmoUnit:degC",
  apparentTemperature: "wmoUnit:degC",
  heatIndex: "wmoUnit:degC",
  windChill: "wmoUnit:degC",
  windSpeed: "wmoUnit:km_h-1",
  windGust: "wmoUnit:km_h-1",
} as const);
export type NwsGridLayer = keyof typeof NWS_GRID_LAYERS;

type Json = Record<string, unknown>;
function object(value: unknown, code: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Json;
}
function text(value: unknown, code: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > maximum) {
    throw new Error(code);
  }
  return value;
}
function optionalText(value: unknown, code: string, maximum = 32_768): string | null {
  return value === null || value === undefined ? null : text(value, code, maximum);
}
function epoch(value: unknown, code: string): number {
  const raw = text(value, code, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error(code);
  }
  const result = Date.parse(raw) / 1_000;
  if (!Number.isInteger(result)) throw new Error(code);
  return result;
}

export function validateNwsLinkedUrl(value: unknown, kind: "grid" | "point"): string {
  const raw = text(value, "nws_link_invalid", 512);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("nws_link_invalid");
  }
  const pattern =
    kind === "point"
      ? /^\/points\/-?\d{1,3}\.\d{1,4},-?\d{1,3}\.\d{1,4}$/
      : /^\/gridpoints\/[A-Z]{3}\/\d{1,3},\d{1,3}$/;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.weather.gov" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pattern.test(url.pathname)
  ) {
    throw new Error("nws_link_invalid");
  }
  return url.toString();
}

export type NwsPointMapping = {
  forecast_grid_data_url: string;
  grid_id: string;
  grid_x: number;
  grid_y: number;
  point_id: NwsPointId;
  time_zone: "America/Chicago";
};

export function pointUrl(pointId: NwsPointId): string {
  const point = NWS_WEATHER_POINTS[pointId];
  return validateNwsLinkedUrl(
    `https://api.weather.gov/points/${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
    "point",
  );
}

export function parseNwsPoint(pointId: NwsPointId, value: unknown): NwsPointMapping {
  const properties = object(object(value, "nws_point_invalid").properties, "nws_point_invalid");
  const gridId = text(properties.gridId, "nws_point_invalid", 3);
  const gridX = properties.gridX;
  const gridY = properties.gridY;
  if (!/^[A-Z]{3}$/.test(gridId) || !Number.isInteger(gridX) || !Number.isInteger(gridY)) {
    throw new Error("nws_point_invalid");
  }
  const linked = validateNwsLinkedUrl(properties.forecastGridData, "grid");
  if (properties.timeZone !== "America/Chicago") {
    throw new Error("nws_point_time_zone");
  }
  if (linked !== `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}`) {
    throw new Error("nws_point_link_mismatch");
  }
  return {
    forecast_grid_data_url: linked,
    grid_id: gridId,
    grid_x: Number(gridX),
    grid_y: Number(gridY),
    point_id: pointId,
    time_zone: "America/Chicago",
  };
}

export type NwsGridValue = {
  end_ts: number;
  start_ts: number;
  value: number | null;
};
export type NwsGridPayload = {
  layers: Record<NwsGridLayer, { unit: string; values: NwsGridValue[] }>;
  point_id: NwsPointId;
  source_updated_at: number;
};

function durationSeconds(value: string): number {
  const match = /^P(?:(\d{1,2})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,3})M)?(?:(\d{1,3})S)?)?$/.exec(value);
  if (!match) throw new Error("nws_grid_valid_time");
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 10 * 86_400) {
    throw new Error("nws_grid_valid_time");
  }
  return seconds;
}

function parseValidTime(value: unknown): [number, number] {
  const raw = text(value, "nws_grid_valid_time", 96);
  const parts = raw.split("/");
  if (parts.length !== 2) throw new Error("nws_grid_valid_time");
  const start = epoch(parts[0], "nws_grid_valid_time");
  return [start, start + durationSeconds(parts[1])];
}

export function parseNwsGridData(pointId: NwsPointId, value: unknown): NwsGridPayload {
  const properties = object(object(value, "nws_grid_invalid").properties, "nws_grid_invalid");
  const layers = {} as NwsGridPayload["layers"];
  let total = 0;
  for (const [name, expectedUnit] of Object.entries(NWS_GRID_LAYERS) as Array<
    [NwsGridLayer, string]
  >) {
    const source = object(properties[name], "nws_grid_layer_invalid");
    if (
      source.uom !== expectedUnit ||
      !Array.isArray(source.values) ||
      source.values.length > 512
    ) {
      throw new Error("nws_grid_layer_invalid");
    }
    const seen = new Set<string>();
    const values = source.values.map((entry) => {
      const row = object(entry, "nws_grid_value_invalid");
      const [start, end] = parseValidTime(row.validTime);
      const key = `${start}:${end}`;
      if (seen.has(key)) throw new Error("nws_grid_duplicate");
      seen.add(key);
      if (row.value !== null && (typeof row.value !== "number" || !Number.isFinite(row.value))) {
        throw new Error("nws_grid_value_invalid");
      }
      return {
        end_ts: end,
        start_ts: start,
        value: row.value as number | null,
      };
    });
    for (let index = 1; index < values.length; index++) {
      if (values[index].start_ts < values[index - 1].end_ts) {
        throw new Error("nws_grid_order");
      }
    }
    if (values.length > 0 && values[values.length - 1].end_ts - values[0].start_ts > 10 * 86_400) {
      throw new Error("nws_grid_span");
    }
    total += values.length;
    layers[name] = { unit: expectedUnit, values };
  }
  if (total > 3_072) throw new Error("nws_grid_cardinality");
  return {
    layers,
    point_id: pointId,
    source_updated_at: epoch(properties.updateTime, "nws_grid_update_time"),
  };
}

export type NwsTexasAlert = {
  affected_zones: string[];
  area_desc: string;
  certainty: string;
  description: string;
  effective: number;
  ends: number | null;
  event: string;
  expires: number;
  headline: string | null;
  id: string;
  instruction: string | null;
  message_type: string;
  onset: number | null;
  references: Array<{ identifier: string; sender: string; sent: number }>;
  response: string;
  sent: number;
  severity: string;
  source_url: string;
  urgency: string;
};

export type NwsAlertsSource = {
  collection_updated_at: number;
  items: NwsTexasAlert[];
  truncated: boolean;
};

const ALERT_ENUMS = {
  certainty: new Set(["Observed", "Likely", "Possible", "Unlikely", "Unknown"]),
  message_type: new Set(["Alert", "Update", "Cancel", "Ack", "Error"]),
  response: new Set([
    "Shelter",
    "Evacuate",
    "Prepare",
    "Execute",
    "Avoid",
    "Monitor",
    "Assess",
    "AllClear",
    "None",
  ]),
  severity: new Set(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]),
  urgency: new Set(["Immediate", "Expected", "Future", "Past", "Unknown"]),
};

export function parseNwsTexasAlerts(value: unknown): NwsAlertsSource {
  const root = object(value, "nws_alerts_invalid");
  if (!Array.isArray(root.features) || root.features.length > 1_000) {
    throw new Error("nws_alerts_invalid");
  }
  const seen = new Set<string>();
  let paginated = false;
  if (root.pagination !== null && root.pagination !== undefined) {
    const pagination = object(root.pagination, "nws_alerts_pagination");
    if (pagination.next !== null && pagination.next !== undefined) {
      const next = new URL(text(pagination.next, "nws_alerts_pagination", 2_048));
      if (
        next.protocol !== "https:" ||
        next.hostname !== "api.weather.gov" ||
        next.port ||
        !/^\/alerts(?:\/active)?$/.test(next.pathname) ||
        next.username ||
        next.password ||
        next.hash
      ) {
        throw new Error("nws_alerts_pagination");
      }
      paginated = true;
    }
  }
  const items = root.features.map((entry) => {
    const feature = object(entry, "nws_alert_invalid");
    const properties = object(feature.properties, "nws_alert_invalid");
    const id = text(properties.id ?? feature.id, "nws_alert_id", 512);
    if (!/^urn:oid:[A-Za-z0-9.]+$/.test(id) || seen.has(id)) {
      throw new Error("nws_alert_id");
    }
    seen.add(id);
    const sourceUrl = text(feature.id, "nws_alert_source_url", 512);
    const source = new URL(sourceUrl);
    if (
      source.protocol !== "https:" ||
      source.hostname !== "api.weather.gov" ||
      source.port ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !/^\/alerts\/urn:oid:[A-Za-z0-9.]+$/.test(source.pathname)
    ) {
      throw new Error("nws_alert_source_url");
    }
    if (!Array.isArray(properties.affectedZones) || properties.affectedZones.length > 512) {
      throw new Error("nws_alert_zones");
    }
    const affectedZones = properties.affectedZones.map((zone) => {
      const raw = text(zone, "nws_alert_zones", 512);
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.weather.gov" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/zones\/[a-z]+\/[A-Z0-9]+$/.test(url.pathname)
      ) {
        throw new Error("nws_alert_zones");
      }
      return url.toString();
    });
    if (new Set(affectedZones).size !== affectedZones.length) {
      throw new Error("nws_alert_zones");
    }
    if (!Array.isArray(properties.references) || properties.references.length > 32) {
      throw new Error("nws_alert_references");
    }
    const references = properties.references.map((entry) => {
      const reference = object(entry, "nws_alert_references");
      const linked = text(reference["@id"], "nws_alert_references", 1_024);
      const url = new URL(linked);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.weather.gov" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/alerts\/urn:oid:[A-Za-z0-9.]+$/.test(url.pathname)
      ) {
        throw new Error("nws_alert_references");
      }
      return {
        identifier: text(reference.identifier, "nws_alert_references", 512),
        sender: text(reference.sender, "nws_alert_references", 256),
        sent: epoch(reference.sent, "nws_alert_references"),
      };
    });
    if (properties.status !== "Actual") throw new Error("nws_alert_status");
    const effective = epoch(properties.effective, "nws_alert_effective");
    const expires = epoch(properties.expires, "nws_alert_expires");
    const ends = properties.ends === null ? null : epoch(properties.ends, "nws_alert_ends");
    const onset = properties.onset === null ? null : epoch(properties.onset, "nws_alert_onset");
    if (effective > expires || (onset !== null && ends !== null && onset > ends)) {
      throw new Error("nws_alert_time_order");
    }
    const output: NwsTexasAlert = {
      affected_zones: affectedZones.sort(),
      area_desc: text(properties.areaDesc, "nws_alert_area", 2_000),
      certainty: text(properties.certainty, "nws_alert_certainty", 64),
      description: text(properties.description, "nws_alert_description", 16_000),
      effective,
      ends,
      event: text(properties.event, "nws_alert_event", 160),
      expires,
      headline: optionalText(properties.headline, "nws_alert_headline", 2_000),
      id,
      instruction: optionalText(properties.instruction, "nws_alert_instruction", 16_000),
      message_type: text(properties.messageType, "nws_alert_message_type", 64),
      onset,
      references: references.sort(
        (left, right) => left.sent - right.sent || left.identifier.localeCompare(right.identifier),
      ),
      response: text(properties.response, "nws_alert_response", 64),
      sent: epoch(properties.sent, "nws_alert_sent"),
      severity: text(properties.severity, "nws_alert_severity", 64),
      source_url: source.toString(),
      urgency: text(properties.urgency, "nws_alert_urgency", 64),
    };
    for (const [key, allowed] of Object.entries(ALERT_ENUMS)) {
      if (!allowed.has(String(output[key as keyof NwsTexasAlert]))) {
        throw new Error("nws_alert_enum");
      }
    }
    return output;
  });
  items.sort((left, right) => left.effective - right.effective || left.id.localeCompare(right.id));
  return {
    collection_updated_at: epoch(root.updated, "nws_alerts_updated"),
    items: items.slice(0, 500),
    truncated: paginated || items.length > 500,
  };
}

export type NwsForecastPoint = {
  cache_fresh_until: number;
  label: string;
  latitude: number;
  layers: Array<{
    key: NwsGridLayer;
    rows: Array<{ valid_end: number; valid_start: number; value: number | null }>;
    unit: string;
  }>;
  longitude: number;
  mapping: Omit<NwsPointMapping, "point_id">;
  point_id: NwsPointId;
  retrieved_at: number;
  update_time: number;
};
export type NwsWeatherPublication =
  | {
      schema: typeof NWS_WEATHER_SCHEMA;
      stream: "forecast";
      points: NwsForecastPoint[];
    }
  | {
      cache_fresh_until: number;
      collection_updated_at: number;
      items: NwsTexasAlert[];
      retrieved_at: number;
      schema: typeof NWS_WEATHER_SCHEMA;
      stream: "alerts";
      truncated: boolean;
    };

export function buildNwsForecastPoint(
  mapping: NwsPointMapping,
  grid: NwsGridPayload,
  retrievedAt: number,
  cacheFreshUntil: number,
): NwsForecastPoint {
  const registry = NWS_WEATHER_POINTS[mapping.point_id];
  return {
    cache_fresh_until: cacheFreshUntil,
    label: registry.label,
    latitude: registry.latitude,
    layers: (Object.keys(NWS_GRID_LAYERS) as NwsGridLayer[]).map((key) => ({
      key,
      rows: grid.layers[key].values.map((row) => ({
        valid_end: row.end_ts,
        valid_start: row.start_ts,
        value: row.value,
      })),
      unit: grid.layers[key].unit,
    })),
    longitude: registry.longitude,
    mapping: {
      forecast_grid_data_url: mapping.forecast_grid_data_url,
      grid_id: mapping.grid_id,
      grid_x: mapping.grid_x,
      grid_y: mapping.grid_y,
      time_zone: mapping.time_zone,
    },
    point_id: mapping.point_id,
    retrieved_at: retrievedAt,
    update_time: grid.source_updated_at,
  };
}
