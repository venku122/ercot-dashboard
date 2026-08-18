import { ercotMarketHourEndingTargetTs } from "./ercot_public_load_sources.ts";
import type { MisDocument } from "./ercot_mis_renewable_publications.ts";

export type RegionalRenewableProductId = "NP4-742-CD" | "NP4-745-CD";
// PR13 intentionally uses the verified hourly products. NP4-743/746 5-minute
// collection remains deferred until its separate strict source contract lands.
export type RegionalMeasure = {
  gen_mw: number | null;
  cop_hsl_mw: number;
  forecast_mw: number;
  resource_plan_mw: number;
};
export type RegionalRenewableRow = {
  target_ts: number;
  delivery_date: string;
  hour_ending: string;
  dst_flag: boolean;
  raw_delivery_date: string;
  raw_hour_ending: string;
  raw_dst_flag: string;
  system: RegionalMeasure & { system_wide_hsl_mw: number | null };
  regions: Record<string, RegionalMeasure>;
};
export type RegionalRenewablePublicationPayload = {
  publication: {
    source_id: "ercot_mis_np4_742" | "ercot_mis_np4_745";
    product_id: RegionalRenewableProductId;
    publication_key_kind: "official_mis_document";
    publication_key: string;
    issued_at: number;
    raw_publish_datetime: string;
    document_id: string;
    constructed_name: string;
    artifact_href: string;
    retrieved_at: number;
    schema_fingerprint: string;
    parser_schema_version: "ercot-mis-regional-v1";
    declared_unit: "MW";
  };
  rows: RegionalRenewableRow[];
};

const WIND_REGIONS = ["panhandle", "coastal", "south", "west", "north"] as const;
const SOLAR_REGIONS = [
  "center-west",
  "north-west",
  "far-west",
  "far-east",
  "south-east",
  "center-east",
] as const;
const WIND_HEADERS = [
  "DELIVERY_DATE",
  "HOUR_ENDING",
  "SYSTEM_WIDE_GEN",
  "COP_HSL_SYSTEM_WIDE",
  "STWPF_SYSTEM_WIDE",
  "WGRPP_SYSTEM_WIDE",
  "GEN_PANHANDLE",
  "COP_HSL_PANHANDLE",
  "STWPF_PANHANDLE",
  "WGRPP_PANHANDLE",
  "GEN_COASTAL",
  "COP_HSL_COASTAL",
  "STWPF_COASTAL",
  "WGRPP_COASTAL",
  "GEN_SOUTH",
  "COP_HSL_SOUTH",
  "STWPF_SOUTH",
  "WGRPP_SOUTH",
  "GEN_WEST",
  "COP_HSL_WEST",
  "STWPF_WEST",
  "WGRPP_WEST",
  "GEN_NORTH",
  "COP_HSL_NORTH",
  "STWPF_NORTH",
  "WGRPP_NORTH",
  "SYSTEM_WIDE_HSL",
  "DSTFlag",
] as const;
const SOLAR_HEADERS = [
  "DELIVERY_DATE",
  "HOUR_ENDING",
  "SYSTEM_WIDE_GEN",
  "COP_HSL_SYSTEM_WIDE",
  "STPPF_SYSTEM_WIDE",
  "PVGRPP_SYSTEM_WIDE",
  "GEN_CenterWest",
  "COP_HSL_CenterWest",
  "STPPF_CenterWest",
  "PVGRPP_CenterWest",
  "GEN_NorthWest",
  "COP_HSL_NorthWest",
  "STPPF_NorthWest",
  "PVGRPP_NorthWest",
  "GEN_FarWest",
  "COP_HSL_FarWest",
  "STPPF_FarWest",
  "PVGRPP_FarWest",
  "GEN_FarEast",
  "COP_HSL_FarEast",
  "STPPF_FarEast",
  "PVGRPP_FarEast",
  "GEN_SouthEast",
  "COP_HSL_SouthEast",
  "STPPF_SouthEast",
  "PVGRPP_SouthEast",
  "GEN_CenterEast",
  "COP_HSL_CenterEast",
  "STPPF_CenterEast",
  "PVGRPP_CenterEast",
  "SYSTEM_WIDE_HSL",
  "DSTFlag",
] as const;

export const REGIONAL_RENEWABLE_PRODUCTS = Object.freeze({
  "NP4-742-CD": {
    reportTypeId: 14787,
    sourceId: "ercot_mis_np4_742" as const,
    headers: WIND_HEADERS,
    regions: WIND_REGIONS,
    sourceRegions: ["PANHANDLE", "COASTAL", "SOUTH", "WEST", "NORTH"] as const,
    forecast: "STWPF",
    plan: "WGRPP",
    fingerprint: "19cd7f070b74ac47bc1678b3804015a994def81971bce1fb327d6e941be15b22",
  },
  "NP4-745-CD": {
    reportTypeId: 21809,
    sourceId: "ercot_mis_np4_745" as const,
    headers: SOLAR_HEADERS,
    regions: SOLAR_REGIONS,
    sourceRegions: [
      "CenterWest",
      "NorthWest",
      "FarWest",
      "FarEast",
      "SouthEast",
      "CenterEast",
    ] as const,
    forecast: "STPPF",
    plan: "PVGRPP",
    fingerprint: "6e18bdac7331a4b544205a9010601b130d92e5f5c5ac4e74e2cbd001de276954",
  },
});

function csv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error("regional_csv_size");
  const rows = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  if (rows.some((row) => row.some((cell) => cell.includes('"'))))
    throw new Error("regional_csv_quote");
  return rows;
}
function numberCell(value: string, nullable = false): number | null {
  if (nullable && value === "") return null;
  if (value === "" || value.trim() !== value) throw new Error("regional_numeric");
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1_000_000)
    throw new Error("regional_numeric");
  return Object.is(result, -0) ? 0 : result;
}
function dateCell(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) throw new Error("regional_date");
  const result = `${match[3]}-${match[1]}-${match[2]}`;
  if (new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result)
    throw new Error("regional_date");
  return result;
}

export function parseRegionalRenewableCsv(
  productId: RegionalRenewableProductId,
  text: string,
): RegionalRenewableRow[] {
  const config = REGIONAL_RENEWABLE_PRODUCTS[productId];
  const records = csv(text);
  if (records.length < 2 || records.length > 513) throw new Error("regional_row_count");
  if (
    records[0]!.length !== config.headers.length ||
    records[0]!.some((v, i) => v !== config.headers[i])
  )
    throw new Error("regional_schema");
  const rows = records.slice(1).map((values) => {
    if (values.length !== config.headers.length) throw new Error("regional_width");
    const source = Object.fromEntries(
      config.headers.map((key, index) => [key, values[index]!]),
    ) as Record<string, string>;
    const delivery = dateCell(source.DELIVERY_DATE!);
    if (
      !/^\d{2}$/.test(source.HOUR_ENDING!) ||
      Number(source.HOUR_ENDING) < 1 ||
      Number(source.HOUR_ENDING) > 24
    )
      throw new Error("regional_hour");
    if (!/^[NY]$/.test(source.DSTFlag!)) throw new Error("regional_dst");
    const hour = `${source.HOUR_ENDING}:00`;
    const dst = source.DSTFlag === "Y";
    const measure = (prefix: string): RegionalMeasure => ({
      gen_mw: numberCell(source[`GEN_${prefix}`]!, true),
      cop_hsl_mw: numberCell(source[`COP_HSL_${prefix}`]!)!,
      forecast_mw: numberCell(source[`${config.forecast}_${prefix}`]!)!,
      resource_plan_mw: numberCell(source[`${config.plan}_${prefix}`]!)!,
    });
    const regions = Object.fromEntries(
      config.regions.map((region, i) => [region, measure(config.sourceRegions[i]!)]),
    );
    const system = {
      gen_mw: numberCell(source.SYSTEM_WIDE_GEN!, true),
      cop_hsl_mw: numberCell(source.COP_HSL_SYSTEM_WIDE!)!,
      forecast_mw: numberCell(source[`${config.forecast}_SYSTEM_WIDE`]!)!,
      resource_plan_mw: numberCell(source[`${config.plan}_SYSTEM_WIDE`]!)!,
    } as RegionalMeasure & { system_wide_hsl_mw: number | null };
    system.system_wide_hsl_mw = numberCell(source.SYSTEM_WIDE_HSL!, true);
    const nullableValues = [
      system.gen_mw,
      system.system_wide_hsl_mw,
      ...Object.values(regions).map((region) => region.gen_mw),
    ];
    const nullCount = nullableValues.filter((value) => value === null).length;
    if (nullCount !== 0 && nullCount !== nullableValues.length)
      throw new Error("regional_generation_null_pattern");
    return {
      target_ts: ercotMarketHourEndingTargetTs("NP6-345-CD", {
        operatingDay: delivery,
        hourEnding: hour,
        DSTFlag: dst,
      }),
      delivery_date: delivery,
      hour_ending: hour,
      dst_flag: dst,
      raw_delivery_date: source.DELIVERY_DATE!,
      raw_hour_ending: source.HOUR_ENDING!,
      raw_dst_flag: source.DSTFlag!,
      system,
      regions,
    };
  });
  for (let i = 1; i < rows.length; i++)
    if (rows[i]!.target_ts <= rows[i - 1]!.target_ts) throw new Error("regional_target_order");
  let futureNullsStarted = false;
  for (const row of rows) {
    const isFutureNull = row.system.gen_mw === null;
    if (futureNullsStarted && !isFutureNull) throw new Error("regional_generation_reappeared");
    futureNullsStarted ||= isFutureNull;
  }
  return rows;
}

export async function regionalSchemaFingerprint(
  productId: RegionalRenewableProductId,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(REGIONAL_RENEWABLE_PRODUCTS[productId].headers),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildRegionalRenewablePublicationPayload(
  productId: RegionalRenewableProductId,
  document: MisDocument,
  rows: RegionalRenewableRow[],
  retrievedAt: number,
): Promise<RegionalRenewablePublicationPayload> {
  if (
    !Number.isInteger(retrievedAt) ||
    retrievedAt <= 0 ||
    retrievedAt < document.issuedAt ||
    rows.length === 0 ||
    rows.length > 512
  )
    throw new Error("ercot_mis_regional_publication_invalid");
  const config = REGIONAL_RENEWABLE_PRODUCTS[productId];
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
      schema_fingerprint: await regionalSchemaFingerprint(productId),
      parser_schema_version: "ercot-mis-regional-v1",
      declared_unit: "MW",
    },
    rows,
  };
}
