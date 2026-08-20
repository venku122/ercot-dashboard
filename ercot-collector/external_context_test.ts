import {
  deriveEgridResource,
  EGRID_SHEETS,
  EXTERNAL_CONTEXT_POLICY,
  parseEgridDiscovery,
  type EgridDiscovery,
} from "./external_context.ts";
import { runExternalContextCycle, startExternalContext } from "./external_context_runner.ts";
import type { Sheet, Workbook } from "./long_horizon.ts";

function assert(value: unknown, message = "assertion_failed"): asserts value {
  if (!value) throw new Error(message);
}
const row = (value: Record<string, string | number>) => new Map(Object.entries(value));
const discovery: EgridDiscovery = {
  artifact_url: "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx",
  data_year: 2023,
  released_on: "2025-06-12",
  revision: 2,
};

function workbook(rate = 733.862): Workbook {
  const result = new Map<string, Sheet>(EGRID_SHEETS.map((name) => [name, new Map()]));
  result.set("Contents", new Map([[15, row({ B: "eGRID R production model 1.0.2." })]]));
  result.set(
    "Table 1",
    new Map([
      [1, row({ B: "1. Subregion Output Emission Rates (eGRID2023)" })],
      [
        2,
        row({
          B: "eGRID subregion acronym",
          C: "eGRID subregion name",
          D: "Total output emission rates",
        }),
      ],
      [3, row({ D: "lb/MWh" })],
      [
        4,
        row({
          D: "CO₂",
          E: "CH₄",
          F: "N₂O",
          G: "CO₂e",
          H: "Annual NOₓ",
          I: "Ozone Season NOₓ",
          J: "SO₂",
        }),
      ],
      [
        9,
        row({
          B: "ERCT",
          C: "ERCOT All",
          D: rate,
          E: 0.043,
          F: 0.006,
          G: 736.629,
          H: 0.443,
          I: 0.488,
          J: 0.319,
        }),
      ],
    ]),
  );
  return result;
}

Deno.test("eGRID discovery and exact ERCT total-output registry are strict", () => {
  const html = `<h2>eGRID with 2023 Data</h2><p>Released: January 15, 2025<br>Revision 1 Released: January 17, 2025<br>Revision 2 Released: June 12, 2025</p><a href="https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx">XLSX</a><h2>Next</h2>`;
  assert(JSON.stringify(parseEgridDiscovery(html)) === JSON.stringify(discovery));
  const result = deriveEgridResource(workbook(), discovery, 1_787_200_000, "1".repeat(64));
  assert(result.resource.rates.length === 7);
  assert(result.resource.rates[0]!.metric_id === "co2");
  assert(result.resource.rates[0]!.value === 733.862);
  assert(result.publication.production_model === "eGRID R");
  assert(result.publication.production_version === "1.0.2");
  assert(EXTERNAL_CONTEXT_POLICY.includes("not_ercot_operational_authority"));
});

Deno.test("eGRID fails closed on workbook and value drift", () => {
  const wrongOrder = new Map([...workbook()].reverse());
  let rejected = 0;
  for (const candidate of [wrongOrder, workbook(-1)]) {
    try {
      deriveEgridResource(candidate, discovery, 1_787_200_000, "1".repeat(64));
    } catch {
      rejected++;
    }
  }
  assert(rejected === 2);
});

Deno.test("external context runner is disabled by default with zero requests", async () => {
  let calls = 0;
  await startExternalContext({
    environment: { get: () => undefined },
    fetcher: (() => {
      calls++;
      throw new Error("unexpected_fetch");
    }) as typeof fetch,
  });
  assert(calls === 0);
});

Deno.test("receiver credentials cannot be sent in URL userinfo or arbitrary plaintext", async () => {
  for (const endpoint of [
    "https://user:password@example.com/api/external-context/ingest",
    "http://evil.example/api/external-context/ingest",
  ]) {
    let calls = 0;
    let rejected = false;
    try {
      await runExternalContextCycle(endpoint, "receiver-secret", 1_787_200_000, {
        environment: { get: () => undefined },
        fetcher: (() => {
          calls++;
          throw new Error("unexpected_fetch");
        }) as typeof fetch,
      });
    } catch {
      rejected = true;
    }
    assert(rejected && calls === 0);
  }
});
