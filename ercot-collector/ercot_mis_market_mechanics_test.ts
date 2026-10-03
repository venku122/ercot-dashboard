import { MARKET_PRODUCTS, parseMarketMechanicsCsv } from "./ercot_mis_market_mechanics.ts";

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
