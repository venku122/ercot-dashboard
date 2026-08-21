import { ercotMarketHourEndingTargetTs } from "./ercot_public_load_sources.ts";

export type RenewableProductId = "NP4-732-CD" | "NP4-737-CD";

export type MisDocument = {
  docId: string;
  publishDate: string;
  issuedAt: number;
  constructedName: string;
  contentSize: number;
};

export type RenewableRow = {
  target_ts: number;
  delivery_date: string;
  hour_ending: string;
  dst_flag: boolean;
  raw_delivery_date: string;
  raw_hour_ending: string;
  raw_dst_flag: string;
  forecast_mw: number;
  actual_hsl_mw: number | null;
};

export type RenewablePublicationPayload = {
  publication: {
    source_id: "ercot_mis_np4_732" | "ercot_mis_np4_737";
    product_id: RenewableProductId;
    publication_key_kind: "official_mis_document";
    publication_key: string;
    issued_at: number;
    raw_publish_datetime: string;
    document_id: string;
    constructed_name: string;
    artifact_href: string;
    retrieved_at: number;
    schema_fingerprint: string;
    parser_schema_version: "ercot-mis-renewable-v1";
    declared_unit: "MW";
  };
  rows: RenewableRow[];
};

const WIND_HEADERS = Object.freeze(
  "DELIVERY_DATE,HOUR_ENDING,SYSTEM_WIDE_GEN,COP_HSL_SYSTEM_WIDE,STWPF_SYSTEM_WIDE,WGRPP_SYSTEM_WIDE,GEN_LZ_SOUTH_HOUSTON,COP_HSL_LZ_SOUTH_HOUSTON,STWPF_LZ_SOUTH_HOUSTON,WGRPP_LZ_SOUTH_HOUSTON,GEN_LZ_WEST,COP_HSL_LZ_WEST,STWPF_LZ_WEST,WGRPP_LZ_WEST,GEN_LZ_NORTH,COP_HSL_LZ_NORTH,STWPF_LZ_NORTH,WGRPP_LZ_NORTH,SYSTEM_WIDE_HSL,DSTFlag".split(
    ",",
  ),
);
const SOLAR_HEADERS = Object.freeze(
  "DELIVERY_DATE,HOUR_ENDING,SYSTEM_WIDE_GEN,COP_HSL_SYSTEM_WIDE,STPPF_SYSTEM_WIDE,PVGRPP_SYSTEM_WIDE,SYSTEM_WIDE_HSL,DSTFlag".split(
    ",",
  ),
);

export const RENEWABLE_PRODUCTS = Object.freeze({
  "NP4-732-CD": {
    reportTypeId: 13028,
    sourceId: "ercot_mis_np4_732" as const,
    headers: WIND_HEADERS,
    forecastField: "STWPF_SYSTEM_WIDE",
    nullableNumericFields: Object.freeze([
      "SYSTEM_WIDE_GEN",
      "GEN_LZ_SOUTH_HOUSTON",
      "GEN_LZ_WEST",
      "GEN_LZ_NORTH",
      "SYSTEM_WIDE_HSL",
    ]),
  },
  "NP4-737-CD": {
    reportTypeId: 13483,
    sourceId: "ercot_mis_np4_737" as const,
    headers: SOLAR_HEADERS,
    forecastField: "STPPF_SYSTEM_WIDE",
    nullableNumericFields: Object.freeze(["SYSTEM_WIDE_GEN", "SYSTEM_WIDE_HSL"]),
  },
});

function compareDocId(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

const MAX_LIST_DOCUMENTS = 500;
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 512;
const MAX_CELL_BYTES = 128;
const MAX_RENEWABLE_MW = 1_000_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`ercot_mis_${field}_invalid`);
  }
  return value;
}

function documentObjects(value: unknown, result: Record<string, unknown>[], depth = 0): void {
  if (depth > 12) throw new Error("ercot_mis_document_list_depth");
  if (Array.isArray(value)) {
    for (const child of value) documentObjects(child, result, depth + 1);
  } else if (object(value)) {
    if ("DocID" in value) result.push(value);
    else for (const child of Object.values(value)) documentObjects(child, result, depth + 1);
  }
}

function issueEpoch(raw: string): number {
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    throw new Error("ercot_mis_publish_date_invalid");
  }
  const epoch = Date.parse(normalized.replace(" ", "T")) / 1000;
  if (!Number.isInteger(epoch)) throw new Error("ercot_mis_publish_date_invalid");
  return epoch;
}

/** Strictly selects the public CSV ZIP artifact; the list also contains XML siblings. */
export function parseMisDocumentList(value: unknown, expectedReportTypeId?: number): MisDocument[] {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_LIST_BYTES) {
    throw new Error("ercot_mis_document_list_size");
  }
  const candidates: Record<string, unknown>[] = [];
  documentObjects(value, candidates);
  if (candidates.length > MAX_LIST_DOCUMENTS) throw new Error("ercot_mis_document_limit");
  const documents = candidates.flatMap((entry): MisDocument[] => {
    if (
      expectedReportTypeId !== undefined &&
      entry.ReportTypeID !== undefined &&
      Number(entry.ReportTypeID) !== expectedReportTypeId
    ) {
      throw new Error("ercot_mis_report_type_mismatch");
    }
    if (entry.SecurityStatus !== "P" || String(entry.Extension).toLowerCase() !== "zip") return [];
    const friendly = boundedText(entry.FriendlyName, "friendly_name");
    if (!/_csv(?:\.zip)?$/i.test(friendly)) return [];
    const docId = boundedText(String(entry.DocID), "document_id", 64);
    if (!/^\d+$/.test(docId)) throw new Error("ercot_mis_document_id_invalid");
    const publishDate = boundedText(entry.PublishDate, "publish_date", 64);
    const constructedName = boundedText(entry.ConstructedName, "constructed_name");
    if (!/^[A-Za-z0-9_.-]+\.zip$/i.test(constructedName)) {
      throw new Error("ercot_mis_constructed_name_invalid");
    }
    const contentSize = Number(entry.ContentSize);
    if (!Number.isInteger(contentSize) || contentSize <= 0 || contentSize > MAX_DOCUMENT_BYTES) {
      throw new Error("ercot_mis_document_size_invalid");
    }
    return [
      { docId, publishDate, issuedAt: issueEpoch(publishDate), constructedName, contentSize },
    ];
  });
  const unique = new Map<string, MisDocument>();
  for (const document of documents) {
    if (unique.has(document.docId)) throw new Error("ercot_mis_duplicate_document");
    unique.set(document.docId, document);
  }
  return [...unique.values()].sort(
    (left, right) => left.issuedAt - right.issuedAt || compareDocId(left.docId, right.docId),
  );
}

function csvRecords(text: string): string[][] {
  if (new TextEncoder().encode(text).length > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("ercot_mis_csv_size_invalid");
  }
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
    else if (char === '"') throw new Error("ercot_mis_csv_quote_invalid");
    else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\n") {
      record.push(cell.replace(/\r$/, ""));
      records.push(record);
      record = [];
      cell = "";
    } else cell += char;
    if (cell.length > MAX_CELL_BYTES) throw new Error("ercot_mis_csv_cell_invalid");
  }
  if (quoted) throw new Error("ercot_mis_csv_quote_invalid");
  if (cell !== "" || record.length) {
    record.push(cell.replace(/\r$/, ""));
    records.push(record);
  }
  return records.filter((row) => !(row.length === 1 && row[0] === ""));
}

function dateText(value: string): string {
  let result = value;
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (us) result = `${us[3]}-${us[1]}-${us[2]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new Error("ercot_mis_delivery_date_invalid");
  }
  const [year, month, day] = result.split("-").map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (roundTrip !== result) throw new Error("ercot_mis_delivery_date_invalid");
  return result;
}

function hourText(value: string): string {
  const match = /^(\d{1,2})(?::00)?$/.exec(value);
  const hour = match ? Number(match[1]) : 0;
  if (hour < 1 || hour > 24) throw new Error("ercot_mis_hour_ending_invalid");
  return `${String(hour).padStart(2, "0")}:00`;
}

function dstFlag(value: string): boolean {
  if (value === "N") return false;
  if (value === "Y") return true;
  throw new Error("ercot_mis_dst_flag_invalid");
}

function number(value: string, nullable = false): number | null {
  if (nullable && value === "") return null;
  if (value.trim() !== value || value === "") throw new Error("ercot_mis_numeric_invalid");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RENEWABLE_MW) {
    throw new Error("ercot_mis_numeric_invalid");
  }
  return Object.is(parsed, -0) ? 0 : parsed;
}

export async function renewableSchemaFingerprint(productId: RenewableProductId): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(RENEWABLE_PRODUCTS[productId].headers));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parses one official artifact into normalized storage rows. Raw GEN is deliberately ignored. */
export function parseRenewableCsv(productId: RenewableProductId, text: string): RenewableRow[] {
  const config = RENEWABLE_PRODUCTS[productId];
  const records = csvRecords(text);
  if (records.length < 2 || records.length - 1 > MAX_ROWS)
    throw new Error("ercot_mis_row_count_invalid");
  if (
    records[0]!.length !== config.headers.length ||
    records[0]!.some((v, i) => v !== config.headers[i])
  ) {
    throw new Error("ercot_mis_schema_mismatch");
  }
  const rows = records.slice(1).map((values) => {
    if (values.length !== config.headers.length) throw new Error("ercot_mis_row_width_invalid");
    const source = Object.fromEntries(
      config.headers.map((header, index) => [header, values[index]!]),
    ) as Record<string, string>;
    const delivery = dateText(source.DELIVERY_DATE!);
    const hour = hourText(source.HOUR_ENDING!);
    const repeat = dstFlag(source.DSTFlag!);
    const nullable = new Set<string>(config.nullableNumericFields);
    for (const field of config.headers) {
      if (!["DELIVERY_DATE", "HOUR_ENDING", "DSTFlag"].includes(field)) {
        number(source[field]!, nullable.has(field));
      }
    }
    const forecast = number(source[config.forecastField]!);
    const actual = number(source.SYSTEM_WIDE_HSL!, true);
    return {
      target_ts: ercotMarketHourEndingTargetTs("NP6-345-CD", {
        operatingDay: delivery,
        hourEnding: hour,
        DSTFlag: repeat,
      }),
      delivery_date: delivery,
      hour_ending: hour,
      dst_flag: repeat,
      raw_delivery_date: source.DELIVERY_DATE!,
      raw_hour_ending: source.HOUR_ENDING!,
      raw_dst_flag: source.DSTFlag!,
      forecast_mw: forecast!,
      actual_hsl_mw: actual,
    };
  });
  for (let index = 1; index < rows.length; index++) {
    if (rows[index]!.target_ts <= rows[index - 1]!.target_ts) {
      throw new Error("ercot_mis_target_order_invalid");
    }
  }
  return rows;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded single-entry ZIP extraction; rejects encrypted, multi-file and path-bearing archives. */
export async function extractSingleCsvZip(bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES)
    throw new Error("ercot_mis_zip_size_invalid");
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || u16(bytes, eocd + 10) !== 1 || u16(bytes, eocd + 8) !== 1) {
    throw new Error("ercot_mis_zip_entries_invalid");
  }
  const central = u32(bytes, eocd + 16);
  if (u32(bytes, central) !== 0x02014b50) throw new Error("ercot_mis_zip_invalid");
  const flags = u16(bytes, central + 8);
  const method = u16(bytes, central + 10);
  const expectedCrc = u32(bytes, central + 16);
  const compressedSize = u32(bytes, central + 20);
  const uncompressedSize = u32(bytes, central + 24);
  const nameLength = u16(bytes, central + 28);
  const localOffset = u32(bytes, central + 42);
  if ((flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("ercot_mis_zip_entry_invalid");
  }
  const name = new TextDecoder().decode(bytes.slice(central + 46, central + 46 + nameLength));
  if (!/^[A-Za-z0-9_.-]+\.csv$/i.test(name)) throw new Error("ercot_mis_zip_name_invalid");
  if (u32(bytes, localOffset) !== 0x04034b50) throw new Error("ercot_mis_zip_invalid");
  if (u16(bytes, localOffset + 6) !== flags || u16(bytes, localOffset + 8) !== method) {
    throw new Error("ercot_mis_zip_invalid");
  }
  const localNameLength = u16(bytes, localOffset + 26);
  const localName = new TextDecoder().decode(
    bytes.slice(localOffset + 30, localOffset + 30 + localNameLength),
  );
  if (localName !== name) throw new Error("ercot_mis_zip_invalid");
  const dataStart = localOffset + 30 + localNameLength + u16(bytes, localOffset + 28);
  if (dataStart + compressedSize > bytes.length) throw new Error("ercot_mis_zip_invalid");
  const compressed = bytes.slice(dataStart, dataStart + compressedSize);
  let plain: Uint8Array;
  if (method === 0) plain = compressed;
  else {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    plain = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (plain.length !== uncompressedSize || plain.length > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("ercot_mis_zip_length_invalid");
  }
  if (crc32(plain) !== expectedCrc) throw new Error("ercot_mis_zip_crc_invalid");
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

export async function buildRenewablePublicationPayload(
  productId: RenewableProductId,
  document: MisDocument,
  rows: RenewableRow[],
  retrievedAt: number,
): Promise<RenewablePublicationPayload> {
  if (
    !Number.isInteger(retrievedAt) ||
    retrievedAt <= 0 ||
    retrievedAt < document.issuedAt ||
    rows.length === 0 ||
    rows.length > MAX_ROWS
  ) {
    throw new Error("ercot_mis_publication_invalid");
  }
  const config = RENEWABLE_PRODUCTS[productId];
  return {
    publication: {
      source_id: config.sourceId,
      product_id: productId,
      publication_key_kind: "official_mis_document",
      publication_key: document.docId,
      issued_at: document.issuedAt,
      raw_publish_datetime: document.publishDate,
      document_id: document.docId,
      constructed_name: document.constructedName,
      artifact_href: `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=${document.docId}`,
      retrieved_at: retrievedAt,
      schema_fingerprint: await renewableSchemaFingerprint(productId),
      parser_schema_version: "ercot-mis-renewable-v1",
      declared_unit: "MW",
    },
    rows,
  };
}

export type RenewableCollectorTransport = {
  list(reportTypeId: number): Promise<unknown>;
  download(document: MisDocument): Promise<Uint8Array>;
  ingest(payload: RenewablePublicationPayload): Promise<void>;
};

export type RenewableHighWater = { issuedAt: number; docId: string };
export type RenewableCollectorCheckpoint = {
  highWater?: Partial<Record<RenewableProductId, RenewableHighWater>>;
  overlapDocIds?: readonly string[];
};

export type RenewableProductCycleResult = {
  backlogCount: number;
  bootstrapTruncated: boolean;
  newestIssuedAt?: number;
  processedDocuments: number;
  rowCount: number;
};

function afterHighWater(document: MisDocument, highWater: RenewableHighWater): boolean {
  return (
    document.issuedAt > highWater.issuedAt ||
    (document.issuedAt === highWater.issuedAt && compareDocId(document.docId, highWater.docId) > 0)
  );
}

/** One bounded, oldest-first cycle. Caller persists the returned overlap DocIDs. */
export async function collectRenewablePublications(
  transport: RenewableCollectorTransport,
  options: {
    checkpoint?: RenewableCollectorCheckpoint;
    retrievedAt: number;
    maximumDocuments?: number;
  },
): Promise<{
  processed: string[];
  checkpoint: RenewableCollectorCheckpoint;
  backlogCount: number;
  bootstrapTruncated: boolean;
  rowCount: number;
  products: Record<RenewableProductId, RenewableProductCycleResult>;
}> {
  const maximum = options.maximumDocuments ?? 48;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 168)
    throw new Error("ercot_mis_cycle_limit_invalid");
  const overlap = new Set(options.checkpoint?.overlapDocIds ?? []);
  const newDocuments: Array<{ productId: RenewableProductId; document: MisDocument }> = [];
  const replayDocuments: Array<{ productId: RenewableProductId; document: MisDocument }> = [];
  let bootstrapTruncated = false;
  const productBootstrap: Record<RenewableProductId, boolean> = {
    "NP4-732-CD": false,
    "NP4-737-CD": false,
  };
  const perProductMaximum = Math.max(1, Math.floor(maximum / 2));
  for (const productId of Object.keys(RENEWABLE_PRODUCTS) as RenewableProductId[]) {
    const config = RENEWABLE_PRODUCTS[productId];
    const documents = parseMisDocumentList(
      await transport.list(config.reportTypeId),
      config.reportTypeId,
    );
    const highWater = options.checkpoint?.highWater?.[productId];
    const fresh = highWater
      ? documents.filter((document) => afterHighWater(document, highWater))
      : documents.slice(-perProductMaximum);
    if (!highWater && documents.length > fresh.length) {
      bootstrapTruncated = true;
      productBootstrap[productId] = true;
    }
    newDocuments.push(...fresh.map((document) => ({ productId, document })));
    if (highWater) {
      replayDocuments.push(
        ...documents
          .filter((document) => overlap.has(document.docId) && !afterHighWater(document, highWater))
          .slice(-4)
          .map((document) => ({ productId, document })),
      );
    }
  }
  const byAge = (a: { document: MisDocument }, b: { document: MisDocument }) =>
    a.document.issuedAt - b.document.issuedAt || compareDocId(a.document.docId, b.document.docId);
  newDocuments.sort(byAge);
  replayDocuments.sort(byAge);
  const freshCycle = newDocuments.slice(0, maximum);
  const freshKeys = new Set(freshCycle.map((item) => `${item.productId}:${item.document.docId}`));
  const cycle = [
    ...freshCycle,
    ...replayDocuments
      .filter((item) => !freshKeys.has(`${item.productId}:${item.document.docId}`))
      .slice(0, maximum - freshCycle.length),
  ];
  const processed: string[] = [];
  let rowCount = 0;
  const productRows: Record<RenewableProductId, number> = {
    "NP4-732-CD": 0,
    "NP4-737-CD": 0,
  };
  const productDocuments: Record<RenewableProductId, number> = {
    "NP4-732-CD": 0,
    "NP4-737-CD": 0,
  };
  const highWater = { ...options.checkpoint?.highWater };
  const nextOverlap = [...(options.checkpoint?.overlapDocIds ?? [])];
  for (const item of cycle) {
    const bytes = await transport.download(item.document);
    if (bytes.length !== item.document.contentSize)
      throw new Error("ercot_mis_download_size_mismatch");
    const rows = parseRenewableCsv(item.productId, await extractSingleCsvZip(bytes));
    await transport.ingest(
      await buildRenewablePublicationPayload(
        item.productId,
        item.document,
        rows,
        options.retrievedAt,
      ),
    );
    processed.push(item.document.docId);
    rowCount += rows.length;
    productRows[item.productId] += rows.length;
    productDocuments[item.productId] += 1;
    nextOverlap.push(item.document.docId);
    const prior = highWater[item.productId];
    if (!prior || afterHighWater(item.document, prior)) {
      highWater[item.productId] = { issuedAt: item.document.issuedAt, docId: item.document.docId };
    }
  }
  const products = Object.fromEntries(
    (Object.keys(RENEWABLE_PRODUCTS) as RenewableProductId[]).map((productId) => {
      const freshTotal = newDocuments.filter((item) => item.productId === productId).length;
      const freshProcessed = freshCycle.filter((item) => item.productId === productId).length;
      const newestIssuedAt = highWater[productId]?.issuedAt;
      return [
        productId,
        {
          backlogCount: Math.max(0, freshTotal - freshProcessed),
          bootstrapTruncated: productBootstrap[productId],
          ...(newestIssuedAt === undefined ? {} : { newestIssuedAt }),
          processedDocuments: productDocuments[productId],
          rowCount: productRows[productId],
        },
      ];
    }),
  ) as Record<RenewableProductId, RenewableProductCycleResult>;
  return {
    processed,
    checkpoint: { highWater, overlapDocIds: [...new Set(nextOverlap)].slice(-96) },
    backlogCount: Math.max(0, newDocuments.length - freshCycle.length),
    bootstrapTruncated,
    rowCount,
    products,
  };
}
