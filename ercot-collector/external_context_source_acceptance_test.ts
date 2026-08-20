import {
  configuredEiaKey,
  deriveEgridResource,
  EGRID_METRICS,
  EGRID_SHEETS,
  parseEgridDiscovery,
  type EgridDiscovery,
} from "./external_context.ts";
import type { Workbook } from "./long_horizon.ts";

function assert(condition: unknown, message = "assertion_failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(operation: () => unknown, expected: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error && thrown.message === expected, `expected_${expected}`);
}

function discovery(revision = 2): EgridDiscovery {
  return {
    artifact_url: `https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev${revision}.xlsx`,
    data_year: 2023,
    released_on: "2025-06-12",
    revision,
  };
}

function workbook(): Workbook {
  const sheets = new Map<string, Map<number, Map<string, string | number>>>();
  for (const name of EGRID_SHEETS) sheets.set(name, new Map());
  sheets.get("Contents")!.set(
    1,
    new Map([
      ["A", "Produced on 03/27/2025 with"],
      ["B", "eGRID R production model 1.0.2."],
    ]),
  );
  const table = sheets.get("Table 1")!;
  table.set(1, new Map([["B", "1. Subregion Output Emission Rates (eGRID2023)"]]));
  table.set(
    2,
    new Map([
      ["B", "eGRID subregion acronym"],
      ["C", "eGRID subregion name"],
      ["D", "Total output emission rates"],
    ]),
  );
  table.set(3, new Map([["D", "lb/MWh"]]));
  table.set(4, new Map(EGRID_METRICS.map((metric) => [metric.column, metric.source_header])));
  table.set(
    5,
    new Map<string, string | number>([
      ["B", "ERCT"],
      ["C", "ERCOT All"],
      ...EGRID_METRICS.map((metric, index) => [metric.column, index + 0.25] as const),
    ]),
  );
  return sheets;
}

Deno.test("missing blank and DEMO_KEY are disabled before any EIA request", () => {
  let upstreamCalls = 0;
  const wouldCollect = (raw: string | undefined) => {
    const key = configuredEiaKey(raw);
    if (key !== null) upstreamCalls += 1;
    return key;
  };

  for (const raw of [undefined, "", "   ", "DEMO_KEY"]) {
    assert(wouldCollect(raw) === null);
  }
  assert(upstreamCalls === 0, "disabled_key_made_upstream_call");
  assert(wouldCollect("  individual-production-key  ") === "individual-production-key");
  assert(Number(upstreamCalls) === 1);
});

Deno.test("eGRID discovery freezes explicit release revision and exact EPA artifact", () => {
  const html = `
    <h2>eGRID with 2023 Data</h2>
    Released: January 15, 2025
    Revision 1 Released: January 17, 2025
    Revision 2 Released: June 12, 2025
    <a href="https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx">Summary</a>
    <h2>Older release</h2>`;
  const selected = parseEgridDiscovery(html);
  assert(JSON.stringify(selected) === JSON.stringify(discovery()));

  assertThrows(
    () => parseEgridDiscovery(html.replace("Revision 2 Released: June 12, 2025", "")),
    "external_context_egrid_discovery_revision",
  );
  assertThrows(
    () => parseEgridDiscovery(html.replace("www.epa.gov", "example.com")),
    "external_context_egrid_discovery_schema",
  );
  assertThrows(
    () => parseEgridDiscovery("x".repeat(2 * 1024 * 1024 + 1)),
    "external_context_egrid_discovery_size",
  );
});

Deno.test("eGRID workbook emits only ordered ERCT total-output lb per MWh factors", () => {
  const payload = deriveEgridResource(workbook(), discovery(), 1_999_000_000, "a".repeat(64));
  assert(payload.kind === "external_context");
  assert(payload.stream === "epa_egrid");
  assert(payload.publication.source_page_url === "https://www.epa.gov/egrid/summary-data");
  assert(payload.publication.production_model === "eGRID R");
  assert(payload.publication.production_version === "1.0.2");
  assert(payload.publication.workbook_sha256 === `sha256:${"a".repeat(64)}`);
  assert(payload.resource.subregion === "ERCT");
  assert(payload.resource.subregion_name === "ERCOT All");
  assert(
    JSON.stringify(payload.resource.rates.map((row) => row.metric_id)) ===
      JSON.stringify(EGRID_METRICS.map((row) => row.metric_id)),
  );
  assert(payload.resource.rates.every((row) => row.unit === "lb_mwh"));
  const encoded = JSON.stringify(payload);
  assert(!encoded.includes("Produced on"), "presentation_timestamp_leaked");
  assert(!encoded.includes("DEMO_KEY"), "credential_leaked");
});

Deno.test("eGRID workbook fails closed on sheet table unit row and metric drift", () => {
  const wrongSheets = new Map(workbook());
  wrongSheets.delete("Table 4");
  assertThrows(
    () => deriveEgridResource(wrongSheets, discovery(), 1_999_000_000, "a".repeat(64)),
    "external_context_egrid_sheets",
  );

  const wrongUnit = workbook() as Map<string, Map<number, Map<string, string | number>>>;
  wrongUnit.get("Table 1")!.get(3)!.set("D", "kg/MWh");
  assertThrows(
    () => deriveEgridResource(wrongUnit, discovery(), 1_999_000_000, "a".repeat(64)),
    "external_context_egrid_header",
  );

  const duplicate = workbook() as Map<string, Map<number, Map<string, string | number>>>;
  duplicate.get("Table 1")!.set(6, new Map(duplicate.get("Table 1")!.get(5)!));
  assertThrows(
    () => deriveEgridResource(duplicate, discovery(), 1_999_000_000, "a".repeat(64)),
    "external_context_egrid_erct",
  );

  const negative = workbook() as Map<string, Map<number, Map<string, string | number>>>;
  negative.get("Table 1")!.get(5)!.set("D", -0.01);
  assertThrows(
    () => deriveEgridResource(negative, discovery(), 1_999_000_000, "a".repeat(64)),
    "external_context_egrid_rate",
  );

  const modelDrift = workbook() as Map<string, Map<number, Map<string, string | number>>>;
  modelDrift.get("Contents")!.get(1)!.set("B", "unreviewed production model");
  assertThrows(
    () => deriveEgridResource(modelDrift, discovery(), 1_999_000_000, "a".repeat(64)),
    "external_context_egrid_production_model",
  );
});
