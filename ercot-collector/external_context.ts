import { parseXlsx, sha256Hex, type Workbook } from "./long_horizon.ts";

export const EXTERNAL_CONTEXT_POLICY =
  "external_context_not_ercot_operational_authority_or_live_emissions_measurement";
export const EXTERNAL_CONTEXT_KIND = "external_context";
export const EGRID_DISCOVERY_URL = "https://www.epa.gov/egrid/summary-data";
export const EGRID_SHEETS = Object.freeze(["Contents", "Table 1", "Table 2", "Table 3", "Table 4"]);
export const EGRID_METRICS = Object.freeze([
  { metric_id: "co2", source_header: "CO₂", column: "D" },
  { metric_id: "ch4", source_header: "CH₄", column: "E" },
  { metric_id: "n2o", source_header: "N₂O", column: "F" },
  { metric_id: "co2e", source_header: "CO₂e", column: "G" },
  { metric_id: "annual_nox", source_header: "Annual NOₓ", column: "H" },
  { metric_id: "ozone_season_nox", source_header: "Ozone Season NOₓ", column: "I" },
  { metric_id: "so2", source_header: "SO₂", column: "J" },
]);

export type EgridDiscovery = Readonly<{
  artifact_url: string;
  data_year: number;
  released_on: string;
  revision: number;
}>;

function text(value: unknown, error: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value.trim();
}

/** Classifies a future optional EIA credential; this slice never starts EIA transport. */
export function configuredEiaKey(value: string | undefined): string | null {
  const key = value?.trim() ?? "";
  return !key || key === "DEMO_KEY" ? null : key;
}

export function parseEgridDiscovery(html: string): EgridDiscovery {
  if (new TextEncoder().encode(html).length > 2 * 1024 * 1024)
    throw new Error("external_context_egrid_discovery_size");
  const section = /<h2>eGRID with (\d{4}) Data<\/h2>([\s\S]*?)(?=<h2|$)/i.exec(html);
  if (!section) throw new Error("external_context_egrid_discovery_schema");
  const dataYear = Number(section[1]);
  const initial = /Released:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i.exec(section[2]!)?.[1];
  const revisions = [
    ...section[2]!.matchAll(/Revision\s+(\d+)\s+Released:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/gi),
  ];
  const artifact =
    /href="(https:\/\/www\.epa\.gov\/system\/files\/documents\/\d{4}-\d{2}\/summary_tables(?:_rev(\d+))?\.xlsx)"/i.exec(
      section[2]!,
    );
  if (!initial || !artifact || !Number.isInteger(dataYear) || dataYear < 2000 || dataYear > 2200)
    throw new Error("external_context_egrid_discovery_schema");
  const revision = artifact[2] ? Number(artifact[2]) : 0;
  const releaseText =
    revision === 0 ? initial : revisions.find((entry) => Number(entry[1]) === revision)?.[2];
  if (!releaseText) throw new Error("external_context_egrid_discovery_revision");
  const releasedOn = new Date(`${releaseText} 00:00:00 UTC`).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releasedOn))
    throw new Error("external_context_egrid_discovery_date");
  return { artifact_url: artifact[1]!, data_year: dataYear, released_on: releasedOn, revision };
}

function cell(workbook: Workbook, sheet: string, row: number, column: string): string | number {
  const value = workbook.get(sheet)?.get(row)?.get(column);
  if (value === undefined) throw new Error("external_context_egrid_workbook_schema");
  return value;
}

function exactCell(workbook: Workbook, row: number, column: string, expected: string): void {
  if (text(cell(workbook, "Table 1", row, column), "external_context_egrid_header") !== expected)
    throw new Error("external_context_egrid_header");
}

export function deriveEgridResource(
  workbook: Workbook,
  discovery: EgridDiscovery,
  retrievedAt: number,
  workbookSha256: string,
) {
  if (JSON.stringify([...workbook.keys()]) !== JSON.stringify(EGRID_SHEETS))
    throw new Error("external_context_egrid_sheets");
  exactCell(
    workbook,
    1,
    "B",
    "1. Subregion Output Emission Rates (eGRID2023)".replace("2023", String(discovery.data_year)),
  );
  exactCell(workbook, 2, "B", "eGRID subregion acronym");
  exactCell(workbook, 2, "C", "eGRID subregion name");
  exactCell(workbook, 2, "D", "Total output emission rates");
  exactCell(workbook, 3, "D", "lb/MWh");
  for (const metric of EGRID_METRICS) {
    exactCell(workbook, 4, metric.column, metric.source_header);
  }
  const matches = [...workbook.get("Table 1")!].filter(([, row]) => row.get("B") === "ERCT");
  if (matches.length !== 1 || matches[0]![1].get("C") !== "ERCOT All")
    throw new Error("external_context_egrid_erct");
  const row = matches[0]![1];
  const rates = EGRID_METRICS.map(({ column, ...metric }) => {
    const value = row.get(column);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("external_context_egrid_rate");
    return { ...metric, value: Object.is(value, -0) ? 0 : value, unit: "lb_mwh" };
  });
  const contents = workbook.get("Contents")!;
  const strings = [...contents.values()]
    .flatMap((row) => [...row.values()])
    .filter((v): v is string => typeof v === "string");
  const modelText = strings.find((value) => value.startsWith("eGRID R production model "));
  const modelMatch = /^eGRID R production model ([0-9]+(?:\.[0-9]+)*)\.$/.exec(modelText ?? "");
  if (!modelMatch) throw new Error("external_context_egrid_production_model");
  return {
    schema: 1,
    kind: EXTERNAL_CONTEXT_KIND,
    stream: "epa_egrid",
    publication: {
      ...discovery,
      retrieved_at: retrievedAt,
      source_page_url: EGRID_DISCOVERY_URL,
      workbook_sha256: `sha256:${workbookSha256}`,
      table_title: String(cell(workbook, "Table 1", 1, "B")),
      production_model: "eGRID R",
      production_version: modelMatch[1]!,
    },
    resource: { subregion: "ERCT", subregion_name: "ERCOT All", rates },
  };
}

export async function parseEgridWorkbook(
  bytes: Uint8Array,
  discovery: EgridDiscovery,
  retrievedAt: number,
) {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024)
    throw new Error("external_context_egrid_workbook_size");
  const hash = await sha256Hex(bytes);
  return deriveEgridResource(await parseXlsx(bytes), discovery, retrievedAt, hash);
}
