import {
  MARKET_PRODUCTS,
  MARKET_SPLIT_CONTRACTS,
  buildMarketMechanicsPublicationPayload,
  parseMarketMechanicsCsv,
} from "./ercot_mis_market_mechanics.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function throws(fn: () => unknown) {
  let failed = false;
  try {
    fn();
  } catch {
    failed = true;
  }
  assert(failed, "expected throw");
}

Deno.test("market mechanics freezes exact headers and preserves negative zero and repeated SCED", () => {
  const header = ["SCEDTimeStamp", "RepeatedHourFlag", "SystemLambda"].join(",");
  const first = parseMarketMechanicsCsv("NP6-322-CD", `${header}\n11/02/2025 01:30:00,N,-2.5`)[0]!;
  const second = parseMarketMechanicsCsv("NP6-322-CD", `${header}\n11/02/2025 01:30:00,Y,0`)[0]!;
  assert(second.target_ts - first.target_ts === 3600);
  assert(first.values.SystemLambda === -2.5 && second.values.SystemLambda === 0);
  throws(() =>
    parseMarketMechanicsCsv(
      "NP6-322-CD",
      `${header.replace("SCEDTimeStamp", "SCEDTimestamp")}\n11/02/2025 01:30:00,N,1`,
    ),
  );
  throws(() => parseMarketMechanicsCsv("NP6-322-CD", `${header}\n03/08/2026 02:30:00,N,1`));
});

Deno.test("SCED MCPC requires exact five-service same-SCED membership", () => {
  const header = "SCEDTimestamp,RepeatedHourFlag,ASType,MCPC";
  const rows = ["ECRS", "NSPIN", "REGDN", "REGUP", "RRS"]
    .map((type, index) => `08/18/2026 11:40:18,N,${type},${index}`)
    .join("\n");
  const parsed = parseMarketMechanicsCsv("NP6-332-CD", `${header}\n${rows}`);
  assert(parsed.length === 5 && new Set(parsed.map((row) => row.target_ts)).size === 1);
  throws(() =>
    parseMarketMechanicsCsv("NP6-332-CD", `${header}\n${rows.replace("RRS,4", "ECRS,4")}`),
  );
});

Deno.test("verified field fingerprints remain frozen", () => {
  assert(
    MARKET_PRODUCTS["NP6-323-CD"].fingerprint ===
      "2ed7613d5a98662cfbf7fa552faf9e6c753bb2d68fd254925a6df19c93ac372a",
  );
  assert(MARKET_PRODUCTS["NP6-328-CD"].fields.length === 8);
});

Deno.test("official October capped and uncapped lambda and MCPC remain distinct source fields", () => {
  for (const product of ["NP6-322-CD", "NP6-332-CD"] as const) {
    const csv = Deno.readTextFileSync(
      new URL(`./fixtures/${product}-capped-2026-10.csv`, import.meta.url),
    );
    const rows = parseMarketMechanicsCsv(product, csv);
    const payload = buildMarketMechanicsPublicationPayload(
      product,
      {
        docId: "1282210198",
        publishDate: "2026-10-03T22:45:23-05:00",
        issuedAt: 1791085523,
        constructedName: "public-fixture",
      },
      rows,
      1791085524,
    );
    assert(payload.publication.schema_fingerprint === MARKET_SPLIT_CONTRACTS[product].fingerprint);

    const names =
      product === "NP6-322-CD"
        ? ["CappedSystemLambda", "UncappedSystemLambda"]
        : ["CappedMCPC", "UncappedMCPC"];
    assert(JSON.stringify(Object.keys(rows[0]!.values)) === JSON.stringify(names));
    const unequal = csv.replace(
      product === "NP6-322-CD" ? "59.54911,59.54911" : "1.25,1.25",
      product === "NP6-322-CD" ? "59.54911,79.123" : "1.25,2.5",
    );
    const distinct = parseMarketMechanicsCsv(product, unequal)[0]!.values;
    assert(distinct[names[0]!] !== distinct[names[1]!]);
    throws(() => parseMarketMechanicsCsv(product, csv.replace("Uncapped", "Invented")));
  }
});
