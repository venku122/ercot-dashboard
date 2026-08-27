import {
  buildMarketMechanicsPublicationPayload,
  MARKET_PRODUCTS,
  parseMarketMechanicsCsv,
  type MarketProductId,
} from "./ercot_mis_market_mechanics.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const CONSTRUCTED_NAMES: Record<MarketProductId, string> = {
  "NP6-322-CD":
    "cdr.00013114.0000000000000000.20260818.124500000.SCEDSYSLAMBDANP6322_20260818_124500_csv.zip",
  "NP6-323-CD":
    "cdr.00013221.0000000000000000.20260818.124500000.RTSCEDpriceAdderNP6323_20260818_124500_csv.zip",
  "NP6-328-CD":
    "cdr.00024887.0000000000000000.20260818.124500000.TotASResCapabilityNP6328_20260818_124500_csv.zip",
  "NP6-332-CD": "cdr.00024891.0000000000000000.20260818.124500000.SCEDMCPCNP6332_csv.zip",
};

function csv(product: MarketProductId): string {
  const contract = MARKET_PRODUCTS[product];
  const prefix = [contract.timestamp, "RepeatedHourFlag"];
  if (product === "NP6-332-CD") {
    const header = [...prefix, "ASType", ...contract.fields].join(",");
    const rows = ["ECRS", "NSPIN", "REGDN", "REGUP", "RRS"].map(
      (asType, index) => `08/18/2026 11:40:18,N,${asType},${index + 1}`,
    );
    return [header, ...rows].join("\n");
  }
  const header = [...prefix, ...contract.fields].join(",");
  const values = contract.fields.map((_field, index) => String(index + 1));
  return `${header}\n08/18/2026 11:40:18,N,${values.join(",")}`;
}

Deno.test("collector publication rows match the receiver's exact per-product wire shape", () => {
  for (const product of Object.keys(MARKET_PRODUCTS) as MarketProductId[]) {
    const rows = parseMarketMechanicsCsv(product, csv(product));
    const payload = buildMarketMechanicsPublicationPayload(
      product,
      {
        docId: "123456789",
        publishDate: "2026-08-18T12:45:00-05:00",
        issuedAt: 1_787_075_100,
        constructedName: CONSTRUCTED_NAMES[product],
      },
      rows,
      1_787_075_160,
    );
    const expectedKeys = [
      "raw_sced_timestamp",
      "repeated_hour_flag",
      "target_ts",
      "values",
      ...(product === "NP6-332-CD" ? ["as_type"] : []),
    ].sort();
    for (const row of payload.rows) {
      equal(Object.keys(row).sort(), expectedKeys);
    }
    equal(payload.publication.product_id, product);
    equal(payload.publication.source_id, MARKET_PRODUCTS[product].sourceId);
    equal(payload.publication.publication_key, "123456789");
    equal(payload.publication.raw_publish_datetime, "2026-08-18T12:45:00-05:00");
  }
});
