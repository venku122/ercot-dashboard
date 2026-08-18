import {
  parseRegionalRenewableCsv,
  REGIONAL_RENEWABLE_PRODUCTS,
  regionalSchemaFingerprint,
} from "./ercot_mis_regional_renewables.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(productId: "NP4-742-CD" | "NP4-745-CD", secondNull = false): string {
  const config = REGIONAL_RENEWABLE_PRODUCTS[productId];
  const row = (hour: string, nullable: boolean) =>
    config.headers
      .map((header) => {
        if (header === "DELIVERY_DATE") return "08/18/2026";
        if (header === "HOUR_ENDING") return hour;
        if (header === "DSTFlag") return "N";
        if (
          nullable &&
          (header === "SYSTEM_WIDE_GEN" ||
            header.startsWith("GEN_") ||
            header === "SYSTEM_WIDE_HSL")
        )
          return "";
        return header === "SYSTEM_WIDE_GEN" || header.startsWith("GEN_") ? "100" : "120";
      })
      .join(",");
  return `${config.headers.join(",")}\n${row("01", false)}\n${row("02", secondNull)}\n`;
}

Deno.test("regional hourly contracts preserve exact taxonomies and nullable future GEN", () => {
  const wind = parseRegionalRenewableCsv("NP4-742-CD", fixture("NP4-742-CD", true));
  const solar = parseRegionalRenewableCsv("NP4-745-CD", fixture("NP4-745-CD", true));
  assert(
    JSON.stringify(Object.keys(wind[0]!.regions)) ===
      JSON.stringify(["panhandle", "coastal", "south", "west", "north"]),
  );
  assert(
    JSON.stringify(Object.keys(solar[0]!.regions)) ===
      JSON.stringify([
        "center-west",
        "north-west",
        "far-west",
        "far-east",
        "south-east",
        "center-east",
      ]),
  );
  assert(wind[1]!.system.gen_mw === null && wind[1]!.regions.panhandle!.gen_mw === null);
  assert(wind[1]!.system.forecast_mw === 120);
});

Deno.test("regional schemas freeze exact ordered-header fingerprints", async () => {
  for (const productId of ["NP4-742-CD", "NP4-745-CD"] as const) {
    assert(
      (await regionalSchemaFingerprint(productId)) ===
        REGIONAL_RENEWABLE_PRODUCTS[productId].fingerprint,
    );
  }
});

Deno.test("regional parser rejects drift, bad order, and unexpected required null", () => {
  const valid = fixture("NP4-742-CD");
  let failures = 0;
  for (const invalid of [
    valid.replace("DELIVERY_DATE", "delivery_date"),
    valid.replace("08/18/2026,02", "08/18/2026,01"),
    valid.replace(",120,", ",,"),
  ]) {
    try {
      parseRegionalRenewableCsv("NP4-742-CD", invalid);
    } catch {
      failures++;
    }
  }
  assert(failures === 3);
});

Deno.test("regional parser requires one coherent historical-to-future null transition", () => {
  const coherent = fixture("NP4-742-CD", true);
  const mixed = coherent.replace("08/18/2026,02,,", "08/18/2026,02,100,");
  const reappeared = `${coherent.trimEnd()}\n${coherent.split("\n")[1]!.replace(",01,", ",03,")}\n`;
  for (const invalid of [mixed, reappeared]) {
    let failed = false;
    try {
      parseRegionalRenewableCsv("NP4-742-CD", invalid);
    } catch {
      failed = true;
    }
    assert(failed);
  }
});
