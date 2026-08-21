export const MARKET_PRODUCTS = {
  "NP6-322-CD": {
    reportTypeId: "13114",
    sourceId: "ercot_mis_np6_322",
    timestamp: "SCEDTimeStamp",
    fields: ["SystemLambda"],
    fingerprint: "1f1e80cd151a9ee69ab84bb170d06d0142f4689758f11b6c74e0b4038295f4cf",
  },
  "NP6-323-CD": {
    reportTypeId: "13221",
    sourceId: "ercot_mis_np6_323",
    timestamp: "SCEDTimestamp",
    fields: [
      "SystemLambda",
      "RTRDPA",
      "RTRDPARUS",
      "RTRDPARDS",
      "RTRDPARRS",
      "RTRDPAECRS",
      "RTRDPANSS",
      "RTRRUC",
      "RTRRMR",
      "RTDNCLR",
      "RTDERS",
      "RTDCTIEIMPORT",
      "RTDCTIEEXPORT",
      "RTBLTIMPORT",
      "RTBLTEXPORT",
      "RTOLLSL",
      "RTOLHSL",
      "RTDLL",
    ],
    fingerprint: "2ed7613d5a98662cfbf7fa552faf9e6c753bb2d68fd254925a6df19c93ac372a",
  },
  "NP6-328-CD": {
    reportTypeId: "24887",
    sourceId: "ercot_mis_np6_328",
    timestamp: "SCEDTimestamp",
    fields: [
      "CapREGUPTotal",
      "CapREGDNTotal",
      "CapRRSTotal",
      "CapECRSTotal",
      "CapNSPINTotal",
      "CapREGUP_RRSTotal",
      "CapREGUP_RRS_ECRSTotal",
      "CapREGUP_RRS_ECRS_NSPINTotal",
    ],
    fingerprint: "e7ef7efcfd834c0df0c1d9bf2fb0dd0b3a9ce86f315c048113c26d1f7b26cd0e",
  },
  "NP6-332-CD": {
    reportTypeId: "24891",
    sourceId: "ercot_mis_np6_332",
    timestamp: "SCEDTimestamp",
    fields: ["MCPC"],
    fingerprint: "64f337f48540aa3d10a80c884eaa7514e94ed72c965cbc63390cac59bff5a8f7",
  },
} as const;
export type MarketProductId = keyof typeof MARKET_PRODUCTS;
const AS_TYPES = ["ECRS", "NSPIN", "REGDN", "REGUP", "RRS"];
export type MarketMechanicsRow = ReturnType<typeof parseMarketMechanicsCsv>[number];
export type MarketMechanicsPublicationPayload = {
  publication: {
    source_id: string;
    product_id: MarketProductId;
    publication_key_kind: "official_mis_document";
    publication_key: string;
    issued_at: number;
    retrieved_at: number;
    raw_publish_datetime: string;
    document_id: string;
    constructed_name: string;
    artifact_href: string;
    schema_fingerprint: string;
    parser_schema_version: "ercot-mis-market-v1";
  };
  rows: MarketMechanicsRow[];
};

function numberValue(value: string): number {
  if (value === "" || value.trim() !== value) throw new Error("market_numeric");
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 1_000_000) throw new Error("market_numeric");
  return Object.is(result, -0) ? 0 : result;
}

function targetTs(raw: string, repeated: boolean): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) throw new Error("market_timestamp");
  const parts = match.slice(1).map(Number);
  const [month, day, year, hour, minute, second] = parts;
  const utcWall = Date.UTC(year!, month! - 1, day, hour, minute, second);
  const expected = `${month!.toString().padStart(2, "0")}/${day!.toString().padStart(2, "0")}/${year} ${hour!.toString().padStart(2, "0")}:${minute!.toString().padStart(2, "0")}:${second!.toString().padStart(2, "0")}`;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const candidates = [utcWall + 5 * 3600000, utcWall + 6 * 3600000]
    .filter((epoch) => {
      const values = Object.fromEntries(
        formatter.formatToParts(epoch).map((part) => [part.type, part.value]),
      );
      return (
        `${values.month}/${values.day}/${values.year} ${values.hour}:${values.minute}:${values.second}` ===
        expected
      );
    })
    .sort();
  const unique = [...new Set(candidates)];
  if (!unique.length || (repeated && unique.length !== 2)) throw new Error("market_timestamp");
  return Math.floor((repeated ? unique.at(-1)! : unique[0]!) / 1000);
}

export function parseMarketMechanicsCsv(product: MarketProductId, text: string) {
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("market_csv_size");
  const config = MARKET_PRODUCTS[product];
  const lines = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  const headers = [
    config.timestamp,
    "RepeatedHourFlag",
    ...(product === "NP6-332-CD" ? ["ASType"] : []),
    ...config.fields,
  ];
  if (
    JSON.stringify(lines[0]) !== JSON.stringify(headers) ||
    lines.length < 2 ||
    lines.length > 10001
  )
    throw new Error("market_csv_contract");
  const rows = lines.slice(1).map((cells) => {
    if (
      cells.length !== headers.length ||
      cells.some((cell) => cell.length > 128 || cell.includes('"'))
    )
      throw new Error("market_csv_contract");
    const raw = cells[0]!;
    if (!/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(raw)) throw new Error("market_timestamp");
    if (!["Y", "N"].includes(cells[1]!)) throw new Error("market_repeat_flag");
    const offset = product === "NP6-332-CD" ? 3 : 2;
    const asType = product === "NP6-332-CD" ? cells[2]! : "";
    if (product === "NP6-332-CD" && !AS_TYPES.includes(asType)) throw new Error("market_as_type");
    const repeated = cells[1] === "Y";
    return {
      target_ts: targetTs(raw, repeated),
      raw_sced_timestamp: raw,
      repeated_hour_flag: repeated,
      ...(product === "NP6-332-CD" ? { as_type: asType } : {}),
      values: Object.fromEntries(
        config.fields.map((field, index) => [field, numberValue(cells[offset + index]!)]),
      ),
    };
  });
  if (
    product === "NP6-332-CD" &&
    (rows.length !== 5 ||
      new Set(rows.map((row) => row.as_type)).size !== 5 ||
      new Set(rows.map((row) => `${row.target_ts}:${row.repeated_hour_flag}`)).size !== 1)
  )
    throw new Error("market_as_membership");
  if (product !== "NP6-322-CD" && product !== "NP6-332-CD" && rows.length !== 1)
    throw new Error("market_row_count");
  if (product === "NP6-322-CD" && rows.length > 12) throw new Error("market_row_count");
  return rows;
}

export function buildMarketMechanicsPublicationPayload(
  product: MarketProductId,
  document: {
    docId: string;
    publishDate: string;
    issuedAt: number;
    constructedName: string;
  },
  rows: MarketMechanicsRow[],
  retrievedAt: number,
): MarketMechanicsPublicationPayload {
  const normalizedPublishDate = document.publishDate.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const derivedIssuedAt = Date.parse(normalizedPublishDate) / 1000;
  if (
    !/^\d{1,20}$/.test(document.docId) ||
    !Number.isInteger(document.issuedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00$/.test(normalizedPublishDate) ||
    !Number.isInteger(derivedIssuedAt) ||
    derivedIssuedAt !== document.issuedAt ||
    !Number.isInteger(retrievedAt) ||
    retrievedAt < document.issuedAt ||
    rows.length === 0
  )
    throw new Error("ercot_mis_market_publication_invalid");
  const config = MARKET_PRODUCTS[product];
  return {
    publication: {
      source_id: config.sourceId,
      product_id: product,
      publication_key_kind: "official_mis_document",
      publication_key: document.docId,
      issued_at: document.issuedAt,
      retrieved_at: retrievedAt,
      raw_publish_datetime: document.publishDate,
      document_id: document.docId,
      constructed_name: document.constructedName,
      artifact_href: `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=${document.docId}`,
      schema_fingerprint: config.fingerprint,
      parser_schema_version: "ercot-mis-market-v1",
    },
    rows,
  };
}
