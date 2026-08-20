import * as adapter from "./ercot_public_market_geography.ts";

type Product = "NP6-788-CD" | "NP6-905-CD" | "NP6-86-CD";
type Json = Record<string, unknown>;
const exported = adapter as unknown as Json;

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message = "values differ"): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function throws(fn: () => unknown, message = "expected throw"): void {
  let failed = false;
  try {
    fn();
  } catch {
    failed = true;
  }
  assert(failed, message);
}

const fixture = (name: string) =>
  new URL(`./fixtures/ercot_public_market_geography/${name}`, import.meta.url);

async function text(name: string): Promise<string> {
  return await Deno.readTextFile(fixture(name));
}

async function json(name: string): Promise<Json> {
  return JSON.parse(await text(name)) as Json;
}

function parse(product: Product, csv: string): Json[] {
  const value = exported.parsePublicMarketGeographyCsv;
  assert(typeof value === "function", "missing parsePublicMarketGeographyCsv export");
  return (value as (product: Product, csv: string) => Json[])(product, csv);
}

const CONSTRUCTED_NAMES: Record<Product, string> = {
  "NP6-788-CD":
    "cdr.00012300.0000000000000000.20251102.013100000.LMPSROSNODENP6788_20251102_013018_csv.zip",
  "NP6-905-CD":
    "cdr.00012301.0000000000000000.20251102.021600000.SPPHLZNP6905_20251102_0201_csv.zip",
  "NP6-86-CD": "cdr.00012302.0000000000000000.20251102.021500000.SCEDBTCNP686_csv.zip",
};

Deno.test("PR15 collector freezes exact products, headers, fingerprints, units, and safety bounds", async () => {
  const accepted = await json("contracts.json");
  const products = exported.MARKET_GEOGRAPHY_PRODUCTS as Json;
  assert(products, "missing product export");

  equal(Object.keys(products).sort(), ["NP6-788-CD", "NP6-86-CD", "NP6-905-CD"]);
  for (const product of Object.keys(products) as Product[]) {
    const actual = products[product] as Json;
    const expected = (accepted.products as Json)[product] as Json;
    equal(actual.reportTypeId, Number(expected.report_type_id), `${product} report`);
    equal(actual.sourceId, expected.source_id, `${product} source`);
    equal(actual.headers, expected.header, `${product} header`);
    equal(actual.fingerprint, expected.header_sha256, `${product} fingerprint`);
    equal(actual.maximumRows, expected.maximum_rows, `${product} row bound`);
  }
  equal(accepted.limits, {
    list_bytes: 4_194_304,
    list_candidates: 5_000,
    zip_bytes: 2_097_152,
    csv_bytes: 8_388_608,
    publications_per_product_run: 48,
  });
  equal(((accepted.products as Json)["NP6-788-CD"] as Json).unit, "$/MWh");
  equal(((accepted.products as Json)["NP6-905-CD"] as Json).unit, "$/MWh");
  equal(((accepted.products as Json)["NP6-86-CD"] as Json).units, {
    ShadowPrice: "$/MWh",
    MaxShadowPrice: "$/MWh",
    Limit: "MW",
    Value: "MW",
    ViolatedMW: "MW",
    FromStationkV: "kV",
    ToStationkV: "kV",
  });
  equal(accepted.attribution_policy, "coincident_constraint_not_point_price_attribution");
  equal(accepted.attribution_status, "unavailable_without_shift_factors");
});

Deno.test("NP6-788 keeps exact SCED identity, seconds, opaque point, and finite LMP", async () => {
  const csv = await text("np6_788.synthetic.csv");
  const rows = parse("NP6-788-CD", csv);
  equal(
    rows.map((row) => Object.keys(row).sort()),
    [
      ["lmp", "raw_sced_timestamp", "repeated_hour_flag", "settlement_point", "target_ts"],
      ["lmp", "raw_sced_timestamp", "repeated_hour_flag", "settlement_point", "target_ts"],
    ],
  );
  assert(rows[0]!.target_ts === rows[1]!.target_ts, "one file must contain one SCED");
  equal(rows[0]!.settlement_point, "HB_HOUSTON");
  equal(rows[1]!.lmp, -2.25);

  const repeated = parse(
    "NP6-788-CD",
    "SCEDTimestamp,RepeatedHourFlag,SettlementPoint,LMP\n11/02/2025 01:30:18,Y,HB_HOUSTON,1",
  )[0]!;
  assert(Number(repeated.target_ts) - Number(rows[0]!.target_ts) === 3600, "fall fold lost");
  throws(() =>
    parse(
      "NP6-788-CD",
      "SCEDTimestamp,RepeatedHourFlag,SettlementPoint,LMP\n03/08/2026 02:30:18,N,HB_HOUSTON,1",
    ),
  );
  throws(() =>
    parse("NP6-788-CD", csv.replace("SettlementPoint,LMP", "SettlementPoint,LMP,Extra")),
  );
  throws(() => parse("NP6-788-CD", `${csv.trim()}\n11/02/2025 01:35:18,N,HB_NORTH,1`));
  throws(() => parse("NP6-788-CD", csv.replace("-2.25", "NaN")));
});

Deno.test("NP6-905 treats type as identity and reconstructs the interval end through DST", async () => {
  const rows = parse("NP6-905-CD", await text("np6_905.synthetic.csv"));
  equal(
    rows.map((row) => row.settlement_point_type),
    ["LZ", "LZEW"],
  );
  equal(
    rows.map((row) => Object.keys(row).sort()),
    [
      [
        "delivery_hour",
        "delivery_interval",
        "raw_delivery_date",
        "raw_dst_flag",
        "repeated_hour_flag",
        "settlement_point",
        "settlement_point_price",
        "settlement_point_type",
        "target_ts",
      ],
      [
        "delivery_hour",
        "delivery_interval",
        "raw_delivery_date",
        "raw_dst_flag",
        "repeated_hour_flag",
        "settlement_point",
        "settlement_point_price",
        "settlement_point_type",
        "target_ts",
      ],
    ],
  );

  const fallN = Number(rows[0]!.target_ts);
  const fallY = Number(
    parse(
      "NP6-905-CD",
      "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag\n11/02/2025,2,1,LZ_HOUSTON,LZ,1,Y",
    )[0]!.target_ts,
  );
  assert(fallY - fallN === 3600, "fall market interval fold lost");

  const he24 = parse(
    "NP6-905-CD",
    "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag\n08/18/2026,24,4,LZ_HOUSTON,LZ,1,N",
  )[0]!;
  equal(he24.target_ts, Date.parse("2026-08-19T05:00:00Z") / 1000, "HE24 IE4 boundary");
  throws(() =>
    parse(
      "NP6-905-CD",
      "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag\n03/08/2026,3,1,LZ_HOUSTON,LZ,1,N",
    ),
  );
  throws(() =>
    parse(
      "NP6-905-CD",
      "DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag\n08/18/2026,1,5,LZ_HOUSTON,LZ,1,N",
    ),
  );
});

Deno.test("NP6-86 preserves reviewed constraint fields and never invents point attribution", async () => {
  const csv = await text("np6_86.synthetic.csv");
  const rows = parse("NP6-86-CD", csv);
  equal(rows.length, 1);
  equal(Object.keys(rows[0]!).sort(), [
    "cct_status",
    "constraint_id",
    "constraint_name",
    "contingency_name",
    "from_station",
    "from_station_kv",
    "limit_mw",
    "max_shadow_price",
    "raw_sced_timestamp",
    "repeated_hour_flag",
    "shadow_price",
    "target_ts",
    "to_station",
    "to_station_kv",
    "value_mw",
    "violated_mw",
  ]);
  equal(rows[0]!.constraint_id, "42");
  equal(rows[0]!.cct_status, "NONCOMP");
  for (const forbidden of [
    "cause",
    "driver",
    "contribution",
    "decomposition",
    "settlement_point",
  ]) {
    assert(!(forbidden in rows[0]!), `invented constraint field ${forbidden}`);
  }
  throws(() => parse("NP6-86-CD", csv.replace("NONCOMP", "UNKNOWN")));
});

Deno.test("collector publication payload retains official provenance and exact row wire shapes", async () => {
  const builder = exported.buildPublicMarketGeographyPublicationPayload;
  assert(
    typeof builder === "function",
    "missing buildPublicMarketGeographyPublicationPayload export",
  );
  const files: Record<Product, string> = {
    "NP6-788-CD": "np6_788.synthetic.csv",
    "NP6-905-CD": "np6_905.synthetic.csv",
    "NP6-86-CD": "np6_86.synthetic.csv",
  };
  for (const product of Object.keys(files) as Product[]) {
    const rows = parse(product, await text(files[product]!));
    const build = builder as (
      product: Product,
      document: Json,
      rows: Json[],
      retrievedAt: number,
    ) => Json;
    const payload = build(
      product,
      {
        docId: "123456789",
        publishDate: "2025-11-02T02:16:00-06:00",
        issuedAt: 1_762_071_360,
        constructedName: CONSTRUCTED_NAMES[product],
      },
      rows,
      1_762_071_420,
    ) as Json;
    const publication = payload.publication as Json;
    equal(publication.product_id, product);
    equal(publication.publication_key, "123456789");
    equal(publication.raw_publish_datetime, "2025-11-02T02:16:00-06:00");
    equal(publication.issued_at, 1_762_071_360);
    equal(payload.rows, rows);
    throws(() =>
      build(
        product,
        {
          docId: "123456789",
          publishDate: "2025-11-02T02:16:00-06:00",
          issuedAt: 1,
          constructedName: CONSTRUCTED_NAMES[product],
        },
        rows,
        1_762_071_420,
      ),
    );
    throws(() =>
      build(
        product,
        {
          docId: "123456789012345678901",
          publishDate: "2025-11-02T02:16:00-06:00",
          issuedAt: 1_762_071_360,
          constructedName: CONSTRUCTED_NAMES[product],
        },
        rows,
        1_762_071_420,
      ),
    );
    throws(() =>
      build(
        product,
        {
          docId: "123456789",
          publishDate: "2025-11-02T08:16:00Z",
          issuedAt: 1_762_071_360,
          constructedName: CONSTRUCTED_NAMES[product],
        },
        rows,
        1_762_071_420,
      ),
    );
  }
});
