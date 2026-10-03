import {
  buildForecastPublicationPayload,
  encodeErcotPublicLoadQuery,
  ercotChicagoPostedDatetimeTs,
  ercotMarketHourEndingTargetTs,
  ercotPublicLoadSchemaFingerprint,
  parseErcotPublicLoadPage,
  requireCompleteErcotPublicLoadPages,
  type ErcotPublicLoadProductId,
} from "./ercot_public_load_sources.ts";

const fixture = (name: string) => new URL(`./fixtures/ercot_public_load/${name}`, import.meta.url);

async function jsonFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(fixture(name)));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function assertThrows(callback: () => unknown, expected: string) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected ${expected}, received ${message}`);
    return;
  }
  throw new Error(`expected ${expected}`);
}

function oneRowPage(
  fixturePayload: Record<string, unknown>,
  currentPage: number,
  totalPages: number,
  totalRecords: number,
  row: unknown[],
) {
  const payload = structuredClone(fixturePayload);
  payload.data = [row];
  payload._meta = { currentPage, pageSize: 1, totalPages, totalRecords };
  return payload;
}

Deno.test("verified Public load schemas preserve exact positional rows and live totals", async () => {
  const np565 = parseErcotPublicLoadPage("NP3-565-CD", await jsonFixture("np3_565.sample.json"));
  assert(np565.fields.length === 15 && np565.rows.length === 1, "NP3-565 width");
  assert(np565.meta.totalRecords === 33_600, "NP3-565 live total");
  assertEquals(
    np565.rows[0],
    {
      postedDatetime: "2026-08-18T06:30:00",
      deliveryDate: "2026-08-18",
      hourEnding: "1:00",
      coast: 101,
      east: 102,
      farWest: 103,
      north: 104,
      northCentral: 105,
      southCentral: 106,
      southern: 107,
      west: 108,
      systemTotal: 936,
      model: "A3",
      inUseFlag: false,
      DSTFlag: false,
    },
    "NP3-565 named row",
  );

  const np763 = parseErcotPublicLoadPage("NP3-763-CD", await jsonFixture("np3_763.sample.json"));
  assert(np763.fields.length === 29 && np763.rows.length === 1, "NP3-763 width");
  assert(np763.meta.totalRecords === 1_032_697, "NP3-763 live total");
  assert(np763.fields[2]?.dataType === "DOUBLE", "live declared hour type");
  assert(np763.rows[0]?.hourEnding === "01:00", "live hour text preserved");
  assert(np763.rows[0]?.capREGUPRRSECRSNSPIN === 125, "last capacity measure");
  assert(np763.rows[0]?.repeatHourFlag === false, "repeat flag preserved");

  const np345 = parseErcotPublicLoadPage("NP6-345-CD", await jsonFixture("np6_345.sample.json"));
  assert(np345.fields.length === 12 && np345.rows.length === 1, "NP6-345 width");
  assert(np345.meta.totalRecords === 24, "NP6-345 live total");
  assert(np345.rows[0]?.operatingDay === "2026-08-17", "operating day raw");
  assert(np345.rows[0]?.DSTFlag === false, "DST raw");
});

Deno.test("schema order, declared types, positional width, and row types fail closed", async () => {
  const source = await jsonFixture("np3_763.sample.json");
  for (const mutate of [
    (payload: Record<string, unknown>) => {
      const fields = payload.fields as Array<Record<string, unknown>>;
      [fields[0], fields[1]] = [fields[1]!, fields[0]!];
    },
    (payload: Record<string, unknown>) => {
      (payload.fields as Array<Record<string, unknown>>)[2]!.dataType = "VARCHAR";
    },
    (payload: Record<string, unknown>) => {
      (payload.data as unknown[][])[0]!.pop();
    },
    (payload: Record<string, unknown>) => {
      (payload.data as unknown[][])[0]![3] = "101";
    },
    (payload: Record<string, unknown>) => {
      (payload.data as unknown[][])[0]![2] = 1;
    },
  ]) {
    const payload = structuredClone(source);
    mutate(payload);
    assertThrows(() => parseErcotPublicLoadPage("NP3-763-CD", payload), "ercot_public_load_");
  }
});

Deno.test("NP3-763 valid empty keeps every verified bounded filter echo", async () => {
  const page = parseErcotPublicLoadPage(
    "NP3-763-CD",
    await jsonFixture("np3_763.valid_empty.json"),
  );
  const complete = requireCompleteErcotPublicLoadPages("NP3-763-CD", [page]);
  assert(complete.totalRecords === 0 && complete.rows.length === 0, "valid empty accepted");
  const query = page.meta.raw.query as Record<string, unknown>;
  const parameters = query.parameters as Record<string, unknown>;
  assert(query.parameterCount === 6, "six exact bounded filters");
  assertEquals(query.sortedBy, [], "no invented sort");
  assertEquals(
    Object.fromEntries(
      [
        "postedDatetimeFrom",
        "postedDatetimeTo",
        "deliveryDateFrom",
        "deliveryDateTo",
        "hourEndingFrom",
        "hourEndingTo",
      ].map((key) => [key, parameters[key]]),
    ),
    {
      postedDatetimeFrom: "2024-01-01T00:00:00",
      postedDatetimeTo: "2024-01-01T00:05:00",
      deliveryDateFrom: "2024-01-01",
      deliveryDateTo: "2024-01-01",
      hourEndingFrom: "01:00",
      hourEndingTo: "01:00",
    },
  );
  assertEquals(
    encodeErcotPublicLoadQuery("NP3-763-CD", {
      postedDatetimeFrom: "2024-01-01T00:00:00",
      postedDatetimeTo: "2024-01-01T00:05:00",
      deliveryDateFrom: "2024-01-01",
      deliveryDateTo: "2024-01-01",
      hourEndingFrom: "01:00",
      hourEndingTo: "01:00",
      page: 1,
      size: 1,
    }),
    "deliveryDateFrom=2024-01-01&deliveryDateTo=2024-01-01&hourEndingFrom=01%3A00&hourEndingTo=01%3A00&page=1&postedDatetimeFrom=2024-01-01T00%3A00%3A00&postedDatetimeTo=2024-01-01T00%3A05%3A00&size=1",
    "exact encoded filters",
  );
  assertThrows(
    () => encodeErcotPublicLoadQuery("NP3-763-CD", { invented: "value" }),
    "ercot_public_load_query_field_not_allowed",
  );
});

Deno.test("pagination refuses a sampled first page and accepts a complete ordered set", async () => {
  const source = await jsonFixture("np3_565.sample.json");
  const sampled = parseErcotPublicLoadPage("NP3-565-CD", source);
  assertThrows(
    () => requireCompleteErcotPublicLoadPages("NP3-565-CD", [sampled]),
    "ercot_public_load_pagination_incomplete",
  );

  const originalRow = (source.data as unknown[][])[0]!;
  const firstRow = structuredClone(originalRow);
  firstRow[0] = "2025-11-01T06:30:00";
  firstRow[1] = "2025-11-02";
  firstRow[2] = "2:00";
  firstRow[12] = "A3";
  firstRow[13] = false;
  firstRow[14] = false;
  const secondRow = structuredClone(firstRow);
  secondRow[12] = "STLF";
  secondRow[13] = true;
  secondRow[14] = true;
  const pages = [
    parseErcotPublicLoadPage("NP3-565-CD", oneRowPage(source, 1, 2, 2, firstRow)),
    parseErcotPublicLoadPage("NP3-565-CD", oneRowPage(source, 2, 2, 2, secondRow)),
  ];
  const complete = requireCompleteErcotPublicLoadPages("NP3-565-CD", pages);
  assert(complete.rows.length === 2, "both pages retained");
  assertEquals(
    complete.rows.map((row) => [row.model, row.inUseFlag, row.DSTFlag]),
    [
      ["A3", false, false],
      ["STLF", true, true],
    ],
    "models and in-use rows are not filtered",
  );

  const payload = await buildForecastPublicationPayload(complete, {
    queryWindow: { deliveryDateFrom: "2025-11-02", deliveryDateTo: "2025-11-02" },
    rawPostedDatetime: "2025-11-01T06:30:00",
    retrievedAt: 1_762_000_000,
  });
  assertEquals(
    payload.rows.map((row) => row.target_ts),
    [1_762_066_800, 1_762_070_400],
    "caller-supplied resolver keeps repeated hour distinct",
  );
  assert(payload.publication.declared_unit === "MW", "reviewed source unit");
  assert(!("vintage_key" in payload.publication), "receiver derives vintage key");
  assert(
    payload.publication.publication_key_kind === "official_posted_datetime" &&
      payload.publication.publication_key === "2025-11-01T06:30:00",
    "official posted identity",
  );
  assertEquals(
    payload.publication.issued_at,
    Date.parse("2025-11-01T11:30:00Z") / 1_000,
    "issued time derived from unambiguous Chicago posted time",
  );
  assert(
    Object.keys(payload.rows[0]!).length === 16 && "target_ts" in payload.rows[0]!,
    "exact source keys plus target_ts",
  );
});

Deno.test("pagination rejects short, shifted, empty, and mutating page snapshots", async () => {
  const source = await jsonFixture("np3_565.sample.json");
  const row = (source.data as unknown[][])[0]!;
  const pageWith = (
    rows: unknown[][],
    currentPage: number,
    totalPages: number,
    totalRecords: number,
    pageSize: number,
  ) => {
    const payload = structuredClone(source);
    payload.data = rows;
    payload._meta = { currentPage, pageSize, totalPages, totalRecords };
    return parseErcotPublicLoadPage("NP3-565-CD", payload);
  };
  const shortThenShifted = [pageWith([row], 1, 2, 3, 2), pageWith([row, row], 2, 2, 3, 2)];
  assertThrows(
    () => requireCompleteErcotPublicLoadPages("NP3-565-CD", shortThenShifted),
    "ercot_public_load_pagination_incomplete",
  );
  const emptyNonterminal = [pageWith([], 1, 2, 2, 1), pageWith([row], 2, 2, 2, 1)];
  assertThrows(
    () => requireCompleteErcotPublicLoadPages("NP3-565-CD", emptyNonterminal),
    "ercot_public_load_pagination_incomplete",
  );
  const mutatedTotal = [pageWith([row], 1, 2, 2, 1), pageWith([row], 2, 2, 3, 1)];
  assertThrows(
    () => requireCompleteErcotPublicLoadPages("NP3-565-CD", mutatedTotal),
    "ercot_public_load_pagination_incomplete",
  );
});

Deno.test("schema fingerprints freeze ordered receiver name and declared-type pairs", async () => {
  const expected: Record<ErcotPublicLoadProductId, string> = {
    "NP3-565-CD": "b5969c5ca165d78a4db53d2e549ee557bf2dc527251ca843fcd1a8ecb273c12e",
    "NP3-763-CD": "7ab50540a9d1e25999ada90fab00de34c75f0a8e3eeb2fdb1877f9d9d1ddfafc",
    "NP6-345-CD": "7102e5159262c2f02f1b5c049e3d0e7fa977785ee8461b9c5c9fcf783559e4c3",
  };
  for (const productId of Object.keys(expected) as ErcotPublicLoadProductId[]) {
    assertEquals(await ercotPublicLoadSchemaFingerprint(productId), expected[productId]);
  }
});

Deno.test("actual load uses receiver-derived content identity and empty is not publishable", async () => {
  const source = await jsonFixture("np6_345.sample.json");
  const row = (source.data as unknown[][])[0]!;
  const page = parseErcotPublicLoadPage("NP6-345-CD", oneRowPage(source, 1, 1, 1, row));
  const complete = requireCompleteErcotPublicLoadPages("NP6-345-CD", [page]);
  const payload = await buildForecastPublicationPayload(complete, {
    queryWindow: { operatingDayFrom: "2026-08-17", operatingDayTo: "2026-08-17" },
    retrievedAt: 1_787_040_000,
  });
  assert(payload.publication.publication_key_kind === "content_hash", "actual snapshot kind");
  assert(!("publication_key" in payload.publication), "receiver derives actual key");
  assert(!("issued_at" in payload.publication), "actual issued time not invented");
  assert(!("published_at" in payload.publication), "actual published time not invented");

  const emptyPage = parseErcotPublicLoadPage(
    "NP3-763-CD",
    await jsonFixture("np3_763.valid_empty.json"),
  );
  const empty = requireCompleteErcotPublicLoadPages("NP3-763-CD", [emptyPage]);
  try {
    await buildForecastPublicationPayload(empty, {
      queryWindow: {},
      retrievedAt: 1_787_040_000,
    });
    throw new Error("expected valid empty publication rejection");
  } catch (error) {
    assert(
      error instanceof Error && error.message === "ercot_public_load_publication_invalid",
      "valid empty is not ingested",
    );
  }
});

Deno.test("posted datetime conversion requires one exact America/Chicago instant", () => {
  assertEquals(
    ercotChicagoPostedDatetimeTs("2026-08-18T06:30:00"),
    Date.parse("2026-08-18T11:30:00Z") / 1_000,
  );
  assertEquals(
    ercotChicagoPostedDatetimeTs("2026-08-18T07:00:55"),
    Date.parse("2026-08-18T12:00:55Z") / 1_000,
  );
  for (const invalid of ["2026-03-08T02:30:00", "2025-11-02T01:30:00", "2026-02-30T12:00:00"]) {
    assertThrows(
      () => ercotChicagoPostedDatetimeTs(invalid),
      "ercot_public_load_posted_datetime_invalid",
    );
  }
});

Deno.test("market-day HE conversion has exact normal, spring, fall, and HE24 goldens", () => {
  const target = (
    productId: ErcotPublicLoadProductId,
    date: string,
    hourEnding: string,
    repeated = false,
  ) =>
    ercotMarketHourEndingTargetTs(productId, {
      ...(productId === "NP6-345-CD" ? { operatingDay: date } : { deliveryDate: date }),
      hourEnding,
      ...(productId === "NP3-763-CD" ? { repeatHourFlag: repeated } : { DSTFlag: repeated }),
    });

  assertEquals(
    target("NP6-345-CD", "2026-02-01", "01:00"),
    Date.parse("2026-02-01T07:00:00Z") / 1_000,
  );
  assertEquals(
    target("NP6-345-CD", "2026-02-01", "24:00"),
    Date.parse("2026-02-02T06:00:00Z") / 1_000,
  );
  assertEquals(
    target("NP3-565-CD", "2026-03-08", "1:00"),
    Date.parse("2026-03-08T07:00:00Z") / 1_000,
  );
  assertEquals(
    target("NP3-565-CD", "2026-03-08", "3:00"),
    Date.parse("2026-03-08T08:00:00Z") / 1_000,
  );
  assertEquals(
    target("NP3-565-CD", "2026-03-08", "24:00"),
    Date.parse("2026-03-09T05:00:00Z") / 1_000,
  );
  assertEquals(
    [
      target("NP6-345-CD", "2025-11-02", "1:00"),
      target("NP6-345-CD", "2025-11-02", "2:00", false),
      target("NP6-345-CD", "2025-11-02", "2:00", true),
      target("NP6-345-CD", "2025-11-02", "3:00"),
      target("NP6-345-CD", "2025-11-02", "24:00"),
    ],
    [
      "2025-11-02T06:00:00Z",
      "2025-11-02T07:00:00Z",
      "2025-11-02T08:00:00Z",
      "2025-11-02T09:00:00Z",
      "2025-11-03T06:00:00Z",
    ].map((value) => Date.parse(value) / 1_000),
  );

  for (const invalid of [
    () => target("NP3-565-CD", "2026-03-08", "2:00"),
    () => target("NP3-565-CD", "2026-03-08", "3:00", true),
    () => target("NP6-345-CD", "2026-02-01", "2:00", true),
    () => target("NP6-345-CD", "2025-11-02", "3:00", true),
    () => target("NP6-345-CD", "2025-11-02", "25:00"),
  ]) {
    assertThrows(invalid, "ercot_public_load_target_timestamp_invalid");
  }
});
