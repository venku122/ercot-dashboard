export const ERCOT_PUBLIC_LOAD_PARSER_SCHEMA_VERSION = "ercot-public-wide-v1";

export type ErcotPublicLoadProductId = "NP3-565-CD" | "NP3-763-CD" | "NP6-345-CD";

export type ErcotPublicFieldDefinition = {
  name: string;
  dataType: "BOOLEAN" | "DATE" | "DATETIME" | "DOUBLE" | "VARCHAR";
};

type JsonObject = Record<string, unknown>;
type SourceValue = boolean | number | string;

export type ParsedPublicLoadPage = {
  fields: readonly ErcotPublicFieldDefinition[];
  meta: {
    currentPage: number;
    pageSize: number;
    raw: JsonObject;
    totalPages: number;
    totalRecords: number;
  };
  productId: ErcotPublicLoadProductId;
  rows: Array<Record<string, SourceValue>>;
};

export type CompletePublicLoadRows = {
  fields: readonly ErcotPublicFieldDefinition[];
  productId: ErcotPublicLoadProductId;
  rows: Array<Record<string, SourceValue>>;
  totalRecords: number;
};

export type ForecastPublicationPayload = {
  publication: {
    artifact_href: string;
    declared_unit: "MW";
    issued_at?: number;
    parser_schema_version: string;
    product_id: ErcotPublicLoadProductId;
    publication_key?: string;
    publication_key_kind: "content_hash" | "official_posted_datetime";
    published_at?: number;
    query_window: JsonObject;
    raw_posted_datetime?: string;
    retrieved_at: number;
    schema_fingerprint: string;
    source_id: string;
  };
  rows: Array<Record<string, SourceValue | number>>;
};

const CHICAGO_TIME_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const NP3_565_FIELDS = [
  ["postedDatetime", "DATETIME"],
  ["deliveryDate", "DATE"],
  ["hourEnding", "VARCHAR"],
  ["coast", "DOUBLE"],
  ["east", "DOUBLE"],
  ["farWest", "DOUBLE"],
  ["north", "DOUBLE"],
  ["northCentral", "DOUBLE"],
  ["southCentral", "DOUBLE"],
  ["southern", "DOUBLE"],
  ["west", "DOUBLE"],
  ["systemTotal", "DOUBLE"],
  ["model", "VARCHAR"],
  ["inUseFlag", "BOOLEAN"],
  ["DSTFlag", "BOOLEAN"],
] as const;

const NP3_763_FIELDS = [
  ["postedDatetime", "DATETIME"],
  ["deliveryDate", "DATE"],
  ["hourEnding", "DOUBLE"],
  ["capGenResSouth", "DOUBLE"],
  ["capGenResNorth", "DOUBLE"],
  ["capGenResWest", "DOUBLE"],
  ["capGenResHouston", "DOUBLE"],
  ["capLoadResSouth", "DOUBLE"],
  ["capLoadResNorth", "DOUBLE"],
  ["capLoadResWest", "DOUBLE"],
  ["capLoadResHouston", "DOUBLE"],
  ["offAvailMWSouth", "DOUBLE"],
  ["offAvailMWNorth", "DOUBLE"],
  ["offAvailMWWest", "DOUBLE"],
  ["offAvailMWHouston", "DOUBLE"],
  ["availCapGen", "DOUBLE"],
  ["availCapRes", "DOUBLE"],
  ["capGenRes", "DOUBLE"],
  ["capLoadRes", "DOUBLE"],
  ["offAvailMW", "DOUBLE"],
  ["capREGUP", "DOUBLE"],
  ["capREGDN", "DOUBLE"],
  ["capRRS", "DOUBLE"],
  ["capECRS", "DOUBLE"],
  ["capNSPIN", "DOUBLE"],
  ["capREGUPRRS", "DOUBLE"],
  ["capREGUPRRSECRS", "DOUBLE"],
  ["capREGUPRRSECRSNSPIN", "DOUBLE"],
  ["repeatHourFlag", "BOOLEAN"],
] as const;

const NP6_345_FIELDS = [
  ["operatingDay", "DATE"],
  ["hourEnding", "VARCHAR"],
  ["coast", "DOUBLE"],
  ["east", "DOUBLE"],
  ["farWest", "DOUBLE"],
  ["north", "DOUBLE"],
  ["northC", "DOUBLE"],
  ["southern", "DOUBLE"],
  ["southC", "DOUBLE"],
  ["west", "DOUBLE"],
  ["total", "DOUBLE"],
  ["DSTFlag", "BOOLEAN"],
] as const;

function definitions(
  values: readonly (readonly [string, ErcotPublicFieldDefinition["dataType"]])[],
): readonly ErcotPublicFieldDefinition[] {
  return Object.freeze(values.map(([name, dataType]) => Object.freeze({ name, dataType })));
}

export const ERCOT_PUBLIC_LOAD_SOURCES = Object.freeze({
  "NP3-565-CD": Object.freeze({
    artifactHref: "https://api.ercot.com/api/public-reports/np3-565-cd/lf_by_model_weather_zone",
    fields: definitions(NP3_565_FIELDS),
    queryFields: Object.freeze([
      "deliveryDateFrom",
      "deliveryDateTo",
      "postedDatetimeFrom",
      "postedDatetimeTo",
      "hourEnding",
      "model",
      "inUseFlag",
      "DSTFlag",
      "page",
      "size",
      "sort",
      "dir",
    ]),
    sourceId: "ercot_public_np3_565_weather_zone_forecast",
  }),
  "NP3-763-CD": Object.freeze({
    artifactHref: "https://api.ercot.com/api/public-reports/np3-763-cd/st_sys_adequacy",
    fields: definitions(NP3_763_FIELDS),
    queryFields: Object.freeze([
      "postedDatetimeFrom",
      "postedDatetimeTo",
      "deliveryDateFrom",
      "deliveryDateTo",
      "hourEndingFrom",
      "hourEndingTo",
      "page",
      "size",
    ]),
    sourceId: "ercot_public_np3_763_system_adequacy",
  }),
  "NP6-345-CD": Object.freeze({
    artifactHref: "https://api.ercot.com/api/public-reports/np6-345-cd/act_sys_load_by_wzn",
    fields: definitions(NP6_345_FIELDS),
    queryFields: Object.freeze([
      "operatingDayFrom",
      "operatingDayTo",
      "hourEnding",
      "DSTFlag",
      "page",
      "size",
      "sort",
      "dir",
    ]),
    sourceId: "ercot_public_np6_345_weather_zone_actual_load",
  }),
});

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(): never {
  throw new Error("ercot_public_load_schema_invalid");
}

function rowError(): never {
  throw new Error("ercot_public_load_row_invalid");
}

function metadataInteger(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) schemaError();
  return value as number;
}

function exactDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function exactDatetime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value;
}

function hourEndingText(value: unknown): value is string {
  return typeof value === "string" && /^(?:0?[1-9]|1\d|2[0-4]):00$/.test(value);
}

function parseValue(
  productId: ErcotPublicLoadProductId,
  field: ErcotPublicFieldDefinition,
  value: unknown,
): SourceValue {
  if (field.dataType === "BOOLEAN") {
    if (typeof value !== "boolean") rowError();
    return value;
  }
  if (field.dataType === "DATE") {
    if (!exactDate(value)) rowError();
    return value;
  }
  if (field.dataType === "DATETIME") {
    if (!exactDatetime(value)) rowError();
    return value;
  }
  if (field.dataType === "VARCHAR") {
    if (field.name === "hourEnding") {
      if (!hourEndingText(value)) rowError();
    } else if (typeof value !== "string" || value.length === 0) {
      rowError();
    }
    return value as string;
  }
  if (productId === "NP3-763-CD" && field.name === "hourEnding") {
    // ERCOT declares DOUBLE but the verified live row is HH:MM text. Preserve
    // that reviewed representation rather than coercing it to a number.
    if (!hourEndingText(value)) rowError();
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) rowError();
  return value;
}

export function parseErcotPublicLoadPage(
  productId: ErcotPublicLoadProductId,
  payload: unknown,
): ParsedPublicLoadPage {
  if (!isObject(payload) || !Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    schemaError();
  }
  const expected = ERCOT_PUBLIC_LOAD_SOURCES[productId].fields;
  if (payload.fields.length !== expected.length) schemaError();
  payload.fields.forEach((rawField, index) => {
    const field = expected[index]!;
    if (
      !isObject(rawField) ||
      rawField.name !== field.name ||
      rawField.dataType !== field.dataType
    ) {
      schemaError();
    }
  });
  if (!isObject(payload._meta)) schemaError();
  const currentPage = metadataInteger(payload._meta.currentPage, 0);
  const totalPages = metadataInteger(payload._meta.totalPages, 0);
  const pageSize = metadataInteger(payload._meta.pageSize, 1);
  const totalRecords = metadataInteger(payload._meta.totalRecords, 0);
  if (payload.data.length > pageSize || totalRecords < payload.data.length) schemaError();
  const rows = payload.data.map((rawRow) => {
    if (!Array.isArray(rawRow) || rawRow.length !== expected.length) rowError();
    const row: Record<string, SourceValue> = {};
    expected.forEach((field, index) => {
      row[field.name] = parseValue(productId, field, rawRow[index]);
    });
    return row;
  });
  return {
    fields: expected,
    meta: { currentPage, pageSize, raw: { ...payload._meta }, totalPages, totalRecords },
    productId,
    rows,
  };
}

export function encodeErcotPublicLoadQuery(
  productId: ErcotPublicLoadProductId,
  values: Record<string, boolean | number | string | null | undefined>,
): string {
  const allowed = new Set(ERCOT_PUBLIC_LOAD_SOURCES[productId].queryFields);
  const parameters = new URLSearchParams();
  for (const key of Object.keys(values).sort()) {
    if (!allowed.has(key)) throw new Error("ercot_public_load_query_field_not_allowed");
    const value = values[key];
    if (value === null || value === undefined) continue;
    if (
      !["boolean", "number", "string"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length === 0) ||
      ((key === "page" || key === "size") && (!Number.isInteger(value) || (value as number) < 1))
    ) {
      throw new Error("ercot_public_load_query_value_invalid");
    }
    parameters.append(key, String(value));
  }
  return parameters.toString();
}

export function requireCompleteErcotPublicLoadPages(
  productId: ErcotPublicLoadProductId,
  pages: readonly ParsedPublicLoadPage[],
): CompletePublicLoadRows {
  if (pages.length === 0 || pages.some((page) => page.productId !== productId)) {
    throw new Error("ercot_public_load_pagination_incomplete");
  }
  const first = pages[0]!;
  if (first.meta.totalRecords === 0) {
    if (pages.length !== 1 || first.rows.length !== 0 || ![0, 1].includes(first.meta.totalPages)) {
      throw new Error("ercot_public_load_pagination_incomplete");
    }
    return { fields: first.fields, productId, rows: [], totalRecords: 0 };
  }
  const indexBase = first.meta.currentPage === 0 ? 0 : 1;
  const expectedPageCount = Math.ceil(first.meta.totalRecords / first.meta.pageSize);
  if (
    first.meta.currentPage !== indexBase ||
    first.meta.totalPages !== pages.length ||
    first.meta.totalPages !== expectedPageCount
  ) {
    throw new Error("ercot_public_load_pagination_incomplete");
  }
  const rows: Array<Record<string, SourceValue>> = [];
  for (const [index, page] of pages.entries()) {
    const terminal = index === pages.length - 1;
    const expectedRows = terminal
      ? first.meta.totalRecords - first.meta.pageSize * (pages.length - 1)
      : first.meta.pageSize;
    if (
      page.meta.currentPage !== indexBase + index ||
      page.meta.totalPages !== first.meta.totalPages ||
      page.meta.totalRecords !== first.meta.totalRecords ||
      page.meta.pageSize !== first.meta.pageSize ||
      page.rows.length !== expectedRows
    ) {
      throw new Error("ercot_public_load_pagination_incomplete");
    }
    rows.push(...page.rows);
  }
  if (rows.length !== first.meta.totalRecords) {
    throw new Error("ercot_public_load_pagination_incomplete");
  }
  return { fields: first.fields, productId, rows, totalRecords: rows.length };
}

/** SHA-256 of compact UTF-8 JSON ordered `[name,dataType]` pairs. */
export async function ercotPublicLoadSchemaFingerprint(
  productId: ErcotPublicLoadProductId,
): Promise<string> {
  const canonical = JSON.stringify(
    ERCOT_PUBLIC_LOAD_SOURCES[productId].fields.map((field) => [field.name, field.dataType]),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dateParts(value: string): { day: number; month: number; year: number } {
  if (!exactDate(value)) throw new Error("ercot_public_load_target_timestamp_invalid");
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return { day, month, year };
}

function nextDate(value: string): string {
  const { year, month, day } = dateParts(value);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function chicagoParts(timestampMs: number): Record<string, string> {
  return Object.fromEntries(
    CHICAGO_TIME_PARTS.formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function chicagoMidnightEpoch(dateText: string): number {
  const { year, month, day } = dateParts(dateText);
  const center = Date.UTC(year, month - 1, day);
  for (let offsetHours = -12; offsetHours <= 14; offsetHours += 1) {
    const candidate = center + offsetHours * 3_600_000;
    const parts = chicagoParts(candidate);
    if (
      parts.year === String(year).padStart(4, "0") &&
      parts.month === String(month).padStart(2, "0") &&
      parts.day === String(day).padStart(2, "0") &&
      parts.hour === "00" &&
      parts.minute === "00" &&
      parts.second === "00"
    ) {
      return candidate / 1_000;
    }
  }
  throw new Error("ercot_public_load_target_timestamp_invalid");
}

export function ercotChicagoPostedDatetimeTs(value: string): number {
  if (!exactDatetime(value)) throw new Error("ercot_public_load_posted_datetime_invalid");
  const [dateText, timeText] = value.split("T") as [string, string];
  const { year, month, day } = dateParts(dateText);
  const [hour, minute, second] = timeText.split(":").map(Number) as [number, number, number];
  const center = Date.UTC(year, month - 1, day, hour, minute, second);
  const candidates: number[] = [];
  for (let offsetHours = -12; offsetHours <= 14; offsetHours += 1) {
    const candidate = center + offsetHours * 3_600_000;
    const parts = chicagoParts(candidate);
    if (
      parts.year === String(year).padStart(4, "0") &&
      parts.month === String(month).padStart(2, "0") &&
      parts.day === String(day).padStart(2, "0") &&
      parts.hour === String(hour).padStart(2, "0") &&
      parts.minute === String(minute).padStart(2, "0") &&
      parts.second === String(second).padStart(2, "0")
    ) {
      candidates.push(candidate / 1_000);
    }
  }
  if (candidates.length !== 1) {
    throw new Error("ercot_public_load_posted_datetime_invalid");
  }
  return candidates[0]!;
}

function hourEndingNumber(value: SourceValue | undefined): number {
  if (!hourEndingText(value)) throw new Error("ercot_public_load_target_timestamp_invalid");
  const hour = Number(value.split(":", 1)[0]);
  if (!Number.isInteger(hour) || hour < 1 || hour > 24) {
    throw new Error("ercot_public_load_target_timestamp_invalid");
  }
  return hour;
}

/**
 * Converts ERCOT's reviewed America/Chicago market-day hour sequence to UTC.
 * NP3-763 uses the documented repeat flag convention; its live fall-history
 * pair was not available in the verification window.
 */
export function ercotMarketHourEndingTargetTs(
  productId: ErcotPublicLoadProductId,
  row: Readonly<Record<string, SourceValue>>,
): number {
  const dateField = productId === "NP6-345-CD" ? "operatingDay" : "deliveryDate";
  const flagField = productId === "NP3-763-CD" ? "repeatHourFlag" : "DSTFlag";
  const dateText = row[dateField];
  const repeat = row[flagField];
  if (typeof dateText !== "string" || typeof repeat !== "boolean") {
    throw new Error("ercot_public_load_target_timestamp_invalid");
  }
  const hour = hourEndingNumber(row.hourEnding);
  const start = chicagoMidnightEpoch(dateText);
  const end = chicagoMidnightEpoch(nextDate(dateText));
  const durationHours = (end - start) / 3_600;
  if (![23, 24, 25].includes(durationHours)) {
    throw new Error("ercot_public_load_target_timestamp_invalid");
  }

  let sequenceOffset: number;
  if (durationHours === 24) {
    if (repeat) throw new Error("ercot_public_load_target_timestamp_invalid");
    sequenceOffset = hour;
  } else if (durationHours === 23) {
    if (repeat || hour === 2) throw new Error("ercot_public_load_target_timestamp_invalid");
    sequenceOffset = hour === 1 ? 1 : hour - 1;
  } else {
    if (repeat && hour !== 2) {
      throw new Error("ercot_public_load_target_timestamp_invalid");
    }
    sequenceOffset = hour === 1 ? 1 : hour === 2 ? (repeat ? 3 : 2) : hour + 1;
  }
  const target = start + sequenceOffset * 3_600;
  if (target > end || (hour === 24 && target !== end)) {
    throw new Error("ercot_public_load_target_timestamp_invalid");
  }
  return target;
}

export async function buildForecastPublicationPayload(
  complete: CompletePublicLoadRows,
  options: {
    queryWindow: JsonObject;
    rawPostedDatetime?: string;
    retrievedAt: number;
  },
): Promise<ForecastPublicationPayload> {
  if (
    !Number.isInteger(options.retrievedAt) ||
    options.retrievedAt <= 0 ||
    !isObject(options.queryWindow) ||
    complete.rows.length === 0 ||
    complete.totalRecords !== complete.rows.length
  ) {
    throw new Error("ercot_public_load_publication_invalid");
  }
  const expected = ERCOT_PUBLIC_LOAD_SOURCES[complete.productId].fields;
  if (
    complete.fields.length !== expected.length ||
    complete.fields.some(
      (field, index) =>
        field.name !== expected[index]!.name || field.dataType !== expected[index]!.dataType,
    )
  ) {
    throw new Error("ercot_public_load_publication_invalid");
  }
  const expectedKeys = new Set(expected.map((field) => field.name));
  for (const row of complete.rows) {
    const keys = Object.keys(row);
    if (keys.length !== expected.length || keys.some((key) => !expectedKeys.has(key))) {
      throw new Error("ercot_public_load_publication_invalid");
    }
    expected.forEach((field) => parseValue(complete.productId, field, row[field.name]));
  }
  encodeErcotPublicLoadQuery(
    complete.productId,
    options.queryWindow as Record<string, boolean | number | string | null | undefined>,
  );
  const postedValues = new Set(
    complete.rows
      .map((row) => row.postedDatetime)
      .filter((value): value is string => typeof value === "string"),
  );
  if (postedValues.size > 1) throw new Error("ercot_public_load_mixed_publication_vintages");
  if (postedValues.size === 1 && options.rawPostedDatetime !== [...postedValues][0]) {
    throw new Error("ercot_public_load_publication_invalid");
  }
  const forecast = complete.productId !== "NP6-345-CD";
  if (
    forecast !== (postedValues.size === 1) ||
    (!forecast && options.rawPostedDatetime !== undefined)
  ) {
    throw new Error("ercot_public_load_publication_invalid");
  }
  const rows = complete.rows.map((row) => {
    const targetTs = ercotMarketHourEndingTargetTs(complete.productId, row);
    if (!Number.isInteger(targetTs) || targetTs <= 0) {
      throw new Error("ercot_public_load_target_timestamp_invalid");
    }
    return { ...row, target_ts: targetTs };
  });
  const source = ERCOT_PUBLIC_LOAD_SOURCES[complete.productId];
  const issuedAt = forecast
    ? ercotChicagoPostedDatetimeTs(options.rawPostedDatetime as string)
    : undefined;
  return {
    publication: {
      source_id: source.sourceId,
      product_id: complete.productId,
      publication_key_kind: forecast ? "official_posted_datetime" : "content_hash",
      ...(forecast ? { publication_key: options.rawPostedDatetime } : {}),
      ...(issuedAt === undefined ? {} : { issued_at: issuedAt }),
      ...(options.rawPostedDatetime === undefined
        ? {}
        : { raw_posted_datetime: options.rawPostedDatetime }),
      retrieved_at: options.retrievedAt,
      artifact_href: source.artifactHref,
      declared_unit: "MW",
      query_window: { ...options.queryWindow },
      parser_schema_version: ERCOT_PUBLIC_LOAD_PARSER_SCHEMA_VERSION,
      schema_fingerprint: await ercotPublicLoadSchemaFingerprint(complete.productId),
    },
    rows,
  };
}
