export const MARKET_GEOGRAPHY_PRODUCTS = Object.freeze({
  "NP6-788-CD": {
    reportTypeId: 12300,
    sourceId: "ercot_mis_np6_788",
    headers: Object.freeze(["SCEDTimestamp", "RepeatedHourFlag", "SettlementPoint", "LMP"]),
    fingerprint: "2ab04e739fba30bc2ee527b4927af212669c8932056745ddfe3bdad29e80ce9c",
    maximumRows: 5_000,
  },
  "NP6-905-CD": {
    reportTypeId: 12301,
    sourceId: "ercot_mis_np6_905",
    headers: Object.freeze([
      "DeliveryDate",
      "DeliveryHour",
      "DeliveryInterval",
      "SettlementPointName",
      "SettlementPointType",
      "SettlementPointPrice",
      "DSTFlag",
    ]),
    fingerprint: "4e6f1ec046967794271f9fd4c2f880b0382f561502c24e0f883aa0be0cc21974",
    maximumRows: 5_000,
  },
  "NP6-86-CD": {
    reportTypeId: 12302,
    sourceId: "ercot_mis_np6_86",
    headers: Object.freeze([
      "SCEDTimeStamp",
      "RepeatedHourFlag",
      "ConstraintID",
      "ConstraintName",
      "ContingencyName",
      "ShadowPrice",
      "MaxShadowPrice",
      "Limit",
      "Value",
      "ViolatedMW",
      "FromStation",
      "ToStation",
      "FromStationkV",
      "ToStationkV",
      "CCTStatus",
    ]),
    fingerprint: "732f368c6be8e87cb0806a57c5ac510b4944011ea22c72bf354de0c48bd89ee7",
    maximumRows: 10_000,
  },
});

export type MarketGeographyProductId = keyof typeof MARKET_GEOGRAPHY_PRODUCTS;

export type MarketGeographyRow =
  | {
      raw_sced_timestamp: string;
      repeated_hour_flag: boolean;
      target_ts: number;
      settlement_point: string;
      lmp: number;
    }
  | {
      raw_delivery_date: string;
      delivery_hour: number;
      delivery_interval: number;
      raw_dst_flag: string;
      repeated_hour_flag: boolean;
      target_ts: number;
      settlement_point: string;
      settlement_point_type: string;
      settlement_point_price: number;
    }
  | {
      raw_sced_timestamp: string;
      repeated_hour_flag: boolean;
      target_ts: number;
      constraint_id: string;
      constraint_name: string;
      contingency_name: string;
      shadow_price: number;
      max_shadow_price: number;
      limit_mw: number;
      value_mw: number;
      violated_mw: number;
      from_station: string;
      to_station: string;
      from_station_kv: number;
      to_station_kv: number;
      cct_status: "COMP" | "NONCOMP";
    };

export type MarketGeographyPublicationPayload = {
  publication: {
    source_id: string;
    product_id: MarketGeographyProductId;
    publication_key_kind: "official_mis_document";
    publication_key: string;
    issued_at: number;
    retrieved_at: number;
    raw_publish_datetime: string;
    document_id: string;
    constructed_name: string;
    artifact_href: string;
    schema_fingerprint: string;
    parser_schema_version: "ercot-market-geography-v1";
  };
  rows: MarketGeographyRow[];
};

const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_CELL_LENGTH = 2_048;

function csvRecords(text: string): string[][] {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES)
    throw new Error("market_geography_csv_size");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === '"') throw new Error("market_geography_csv_quote");
    else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\n") {
      record.push(cell.replace(/\r$/, ""));
      records.push(record);
      record = [];
      cell = "";
    } else cell += char;
    if (cell.length > MAX_CELL_LENGTH) throw new Error("market_geography_csv_cell");
  }
  if (quoted) throw new Error("market_geography_csv_quote");
  if (cell !== "" || record.length) {
    record.push(cell.replace(/\r$/, ""));
    records.push(record);
  }
  return records.filter((row) => !(row.length === 1 && row[0] === ""));
}

function finite(value: string): number {
  if (value === "" || value.trim() !== value) throw new Error("market_geography_numeric");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("market_geography_numeric");
  return Object.is(parsed, -0) ? 0 : parsed;
}

function bounded(value: string, field: string, maximum = 512): string {
  if (value === "" || value.trim() !== value || value.length > maximum)
    throw new Error(`market_geography_${field}`);
  return value;
}

function repeatedFlag(value: string): boolean {
  if (value === "N") return false;
  if (value === "Y") return true;
  throw new Error("market_geography_repeat_flag");
}

const CHICAGO = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function centralCandidates(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const expected = `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return [...new Set([wall + 5 * 3_600_000, wall + 6 * 3_600_000])]
    .filter((epoch) => {
      const parts = Object.fromEntries(
        CHICAGO.formatToParts(epoch).map((part) => [part.type, part.value]),
      );
      return (
        `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}` ===
        expected
      );
    })
    .sort((left, right) => left - right);
}

function centralTarget(raw: string, repeated: boolean): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) throw new Error("market_geography_timestamp");
  const [, month, day, year, hour, minute, second] = match.map(Number);
  const candidates = centralCandidates(year!, month!, day!, hour!, minute!, second!);
  if (!candidates.length || (repeated && candidates.length !== 2))
    throw new Error("market_geography_timestamp");
  return Math.floor((repeated ? candidates.at(-1)! : candidates[0]!) / 1000);
}

export function marketIntervalTargetTs(
  rawDeliveryDate: string,
  deliveryHour: number,
  deliveryInterval: number,
  repeated: boolean,
): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDeliveryDate);
  if (!match || !Number.isInteger(deliveryHour) || deliveryHour < 1 || deliveryHour > 24)
    throw new Error("market_geography_delivery_interval");
  if (!Number.isInteger(deliveryInterval) || deliveryInterval < 1 || deliveryInterval > 4)
    throw new Error("market_geography_delivery_interval");
  const [, month, day, year] = match.map(Number);
  const wall = new Date(
    Date.UTC(year!, month! - 1, day!, 0, (deliveryHour - 1) * 60 + deliveryInterval * 15),
  );
  const normalizedDate = `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
  if (
    new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !==
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  )
    throw new Error("market_geography_delivery_interval");
  const candidates = centralCandidates(
    wall.getUTCFullYear(),
    wall.getUTCMonth() + 1,
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    0,
  );
  if (!normalizedDate || !candidates.length || (repeated && candidates.length !== 2))
    throw new Error("market_geography_delivery_interval");
  return Math.floor((repeated ? candidates.at(-1)! : candidates[0]!) / 1000);
}

function rowObject(headers: readonly string[], cells: string[]): Record<string, string> {
  if (headers.length !== cells.length) throw new Error("market_geography_row_width");
  return Object.fromEntries(headers.map((header, index) => [header, cells[index]!]));
}

export function parsePublicMarketGeographyCsv(
  product: MarketGeographyProductId,
  text: string,
): MarketGeographyRow[] {
  const config = MARKET_GEOGRAPHY_PRODUCTS[product];
  const records = csvRecords(text);
  if (
    records.length < 2 ||
    records.length - 1 > config.maximumRows ||
    JSON.stringify(records[0]) !== JSON.stringify(config.headers)
  )
    throw new Error("market_geography_csv_contract");
  const rows = records.slice(1).map((cells): MarketGeographyRow => {
    const row = rowObject(config.headers, cells);
    if (product === "NP6-788-CD") {
      const raw = bounded(row.SCEDTimestamp!, "timestamp", 32);
      const repeated = repeatedFlag(row.RepeatedHourFlag!);
      return {
        raw_sced_timestamp: raw,
        repeated_hour_flag: repeated,
        target_ts: centralTarget(raw, repeated),
        settlement_point: bounded(row.SettlementPoint!, "settlement_point", 256),
        lmp: finite(row.LMP!),
      };
    }
    if (product === "NP6-905-CD") {
      const deliveryHour = Number(row.DeliveryHour);
      const deliveryInterval = Number(row.DeliveryInterval);
      const repeated = repeatedFlag(row.DSTFlag!);
      return {
        raw_delivery_date: bounded(row.DeliveryDate!, "delivery_date", 16),
        delivery_hour: deliveryHour,
        delivery_interval: deliveryInterval,
        raw_dst_flag: row.DSTFlag!,
        repeated_hour_flag: repeated,
        target_ts: marketIntervalTargetTs(
          row.DeliveryDate!,
          deliveryHour,
          deliveryInterval,
          repeated,
        ),
        settlement_point: bounded(row.SettlementPointName!, "settlement_point", 256),
        settlement_point_type: bounded(row.SettlementPointType!, "settlement_point_type", 32),
        settlement_point_price: finite(row.SettlementPointPrice!),
      };
    }
    const raw = bounded(row.SCEDTimeStamp!, "timestamp", 32);
    const repeated = repeatedFlag(row.RepeatedHourFlag!);
    const constraintId = bounded(row.ConstraintID!, "constraint_id", 64);
    if (!/^-?\d+(?:\.\d+)?$/.test(constraintId)) throw new Error("market_geography_constraint_id");
    const cctStatus = row.CCTStatus;
    if (cctStatus !== "COMP" && cctStatus !== "NONCOMP")
      throw new Error("market_geography_cct_status");
    return {
      raw_sced_timestamp: raw,
      repeated_hour_flag: repeated,
      target_ts: centralTarget(raw, repeated),
      constraint_id: constraintId,
      constraint_name: bounded(row.ConstraintName!, "constraint_name"),
      contingency_name: bounded(row.ContingencyName!, "contingency_name"),
      shadow_price: finite(row.ShadowPrice!),
      max_shadow_price: finite(row.MaxShadowPrice!),
      limit_mw: finite(row.Limit!),
      value_mw: finite(row.Value!),
      violated_mw: finite(row.ViolatedMW!),
      from_station: bounded(row.FromStation!, "from_station", 256),
      to_station: bounded(row.ToStation!, "to_station", 256),
      from_station_kv: finite(row.FromStationkV!),
      to_station_kv: finite(row.ToStationkV!),
      cct_status: cctStatus,
    };
  });
  if (
    (product === "NP6-788-CD" || product === "NP6-905-CD") &&
    new Set(rows.map((row) => row.target_ts)).size !== 1
  )
    throw new Error("market_geography_snapshot_mixed");
  const identities = rows.map((row) => {
    if ("lmp" in row) return `${row.target_ts}\0${row.settlement_point}`;
    if ("settlement_point_price" in row)
      return `${row.target_ts}\0${row.settlement_point}\0${row.settlement_point_type}`;
    return [
      row.target_ts,
      row.constraint_id,
      row.constraint_name,
      row.contingency_name,
      row.from_station,
      row.to_station,
      row.from_station_kv,
      row.to_station_kv,
    ].join("\0");
  });
  if (new Set(identities).size !== identities.length)
    throw new Error("market_geography_duplicate_row");
  return rows;
}

export function buildPublicMarketGeographyPublicationPayload(
  product: MarketGeographyProductId,
  document: {
    docId: string;
    publishDate: string;
    issuedAt: number;
    constructedName: string;
  },
  rows: MarketGeographyRow[],
  retrievedAt: number,
): MarketGeographyPublicationPayload {
  const normalized = document.publishDate.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const issuedAt = Date.parse(normalized.replace(" ", "T")) / 1000;
  const config = MARKET_GEOGRAPHY_PRODUCTS[product];
  if (
    !/^\d{1,20}$/.test(document.docId) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00$/.test(normalized) ||
    !Number.isInteger(document.issuedAt) ||
    !Number.isInteger(issuedAt) ||
    issuedAt !== document.issuedAt ||
    !Number.isInteger(retrievedAt) ||
    retrievedAt < issuedAt ||
    rows.length === 0
  )
    throw new Error("market_geography_publication_invalid");
  return {
    publication: {
      source_id: config.sourceId,
      product_id: product,
      publication_key_kind: "official_mis_document",
      publication_key: document.docId,
      issued_at: issuedAt,
      retrieved_at: retrievedAt,
      raw_publish_datetime: document.publishDate,
      document_id: document.docId,
      constructed_name: document.constructedName,
      artifact_href: `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=${document.docId}`,
      schema_fingerprint: config.fingerprint,
      parser_schema_version: "ercot-market-geography-v1",
    },
    rows,
  };
}
