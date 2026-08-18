import { ErcotApiError } from "./ercot_api.ts";
import {
  collectErcotPages,
  compareSourceParity,
  encodeErcotQuery,
  estimateStorageCost,
  parseErcotProductCatalog,
  reconcileCatalogWithOpenApi,
  sourceProvenance,
} from "./ercot_api_catalog.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = "values differ") {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${message}: expected ${right}, received ${left}`);
}

async function assertRejects(callback: () => Promise<unknown>, code: string) {
  try {
    await callback();
  } catch (error) {
    assert(error instanceof ErcotApiError, `expected ErcotApiError, received ${String(error)}`);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

function assertThrows(callback: () => unknown, code: string) {
  try {
    callback();
  } catch (error) {
    assert(error instanceof ErcotApiError, `expected ErcotApiError, received ${String(error)}`);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

const fixture = (name: string) => new URL(`./fixtures/ercot_api/${name}`, import.meta.url);

async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(fixture(name)));
}

Deno.test("catalog preserves exact live artifact endpoint relations and verification date", async () => {
  const catalog = parseErcotProductCatalog(await jsonFixture("public_reports.catalog.json"), {
    apiBaseUrl: "https://api.test/api/",
    verifiedAt: "2026-08-18",
  });
  assert(catalog.productCount === 2, "two products");
  assert(catalog.artifacts.length === 3, "one entry per artifact");
  assertEquals(
    catalog.artifacts.map((artifact) => artifact.endpointHref),
    [
      "/api/public-reports/np3-565-cd/actual_loads_by_forecast_zone",
      "https://api.test/api/public-reports/np3-565-cd/seven_day_load_forecast",
      "/api/public-reports/np3-763-cd/capacity_forecast",
    ],
  );
  assert(
    !catalog.artifacts.some((artifact) => artifact.endpointHref.includes("archive")),
    "archive and self links are excluded",
  );
  assert(
    catalog.artifacts.every((artifact) => artifact.verifiedAt === "2026-08-18"),
    "dated",
  );
});

Deno.test("catalog rejects malformed identity, relation, date, origin, and namespace", async () => {
  const baseProduct = {
    emilId: "TEST",
    reportName: "Test",
    status: "Active",
    artifacts: [{ name: "Artifact", _links: { endpoint: { href: "/api/test" } } }],
  };
  const envelope = (product: unknown) => ({ _embedded: { products: [product] } });
  const options = { apiBaseUrl: "https://api.test/api/", verifiedAt: "2026-08-18" };
  assertThrows(
    () => parseErcotProductCatalog(envelope({ ...baseProduct, emilId: "" }), options),
    "ercot_catalog_emil_id_invalid",
  );
  assertThrows(
    () =>
      parseErcotProductCatalog(
        envelope({ ...baseProduct, artifacts: [{ name: "Artifact", _links: {} }] }),
        options,
      ),
    "ercot_public_artifact_schema_invalid",
  );
  assertThrows(
    () =>
      parseErcotProductCatalog(
        envelope({
          ...baseProduct,
          artifacts: [
            {
              name: "Artifact",
              _links: { endpoint: { href: "https://outside.test/api/test" } },
            },
          ],
        }),
        options,
      ),
    "ercot_catalog_endpoint_outside_api",
  );
  assertThrows(
    () =>
      parseErcotProductCatalog(
        envelope({
          ...baseProduct,
          artifacts: [{ name: "Artifact", _links: { endpoint: { href: "/api/../admin" } } }],
        }),
        options,
      ),
    "ercot_catalog_endpoint_outside_api",
  );
  assertThrows(
    () => parseErcotProductCatalog(envelope(baseProduct), { ...options, verifiedAt: "today" }),
    "ercot_catalog_verification_date_invalid",
  );
});

Deno.test("guarded pagination follows only advertised same-API next links", async () => {
  const pages = new Map<string, unknown>([
    [
      "https://api.test/api/data?page=1",
      { data: [1, 2], _links: { next: { href: "/api/data?page=2" } } },
    ],
    [
      "https://api.test/api/data?page=2",
      { data: [3], _links: { next: { href: "https://api.test/api/data?page=3" } } },
    ],
    ["https://api.test/api/data?page=3", { data: [4], _links: {} }],
  ]);
  const result = await collectErcotPages<number>(
    "/api/data?page=1",
    async (url) => pages.get(url.toString()),
    { apiBaseUrl: "https://api.test/api/" },
  );
  assertEquals(result.items, [1, 2, 3, 4]);
  assert(result.pages === 3 && result.hrefs.length === 3, "three bounded pages");

  const metadataResult = await collectErcotPages<number>(
    "/api/metadata?page=1",
    async (url) => {
      const page = Number(url.searchParams.get("page"));
      return { data: [page], _meta: { currentPage: page, totalPages: 2 } };
    },
    { apiBaseUrl: "https://api.test/api/" },
  );
  assertEquals(metadataResult.items, [1, 2], "metadata pagination");

  const zeroBased = await collectErcotPages<number>(
    "/api/zero?page=0",
    async (url) => {
      const page = Number(url.searchParams.get("page"));
      return {
        data: [page],
        _meta: { currentPage: page, pageSize: 1, totalPages: 2, totalRecords: 2 },
      };
    },
    { apiBaseUrl: "https://api.test/api/" },
  );
  assertEquals(zeroBased.items, [0, 1], "zero-based metadata remains zero-based");

  await assertRejects(
    () =>
      collectErcotPages(
        "/api/data",
        async () => ({ data: [], _links: { next: { href: "https://evil.test/api/data" } } }),
        { apiBaseUrl: "https://api.test/api/" },
      ),
    "ercot_catalog_endpoint_outside_api",
  );
});

Deno.test("pagination rejects cycles, malformed pages, and configured limits", async () => {
  await assertRejects(
    () =>
      collectErcotPages(
        "/api/data",
        async () => ({ data: [], _links: { next: { href: "/api/data" } } }),
        { apiBaseUrl: "https://api.test/api/" },
      ),
    "ercot_pagination_cycle",
  );
  await assertRejects(
    () =>
      collectErcotPages("/api/data", async () => ({ rows: [] }), {
        apiBaseUrl: "https://api.test/api/",
      }),
    "ercot_pagination_page_invalid",
  );
  await assertRejects(
    () =>
      collectErcotPages("/api/data", async () => ({ data: [1, 2] }), {
        apiBaseUrl: "https://api.test/api/",
        maxItems: 1,
      }),
    "ercot_pagination_item_limit_exceeded",
  );
  await assertRejects(
    () =>
      collectErcotPages(
        "/api/one",
        async () => ({ data: [], _links: { next: { href: "/api/two" } } }),
        { apiBaseUrl: "https://api.test/api/", maxPages: 1 },
      ),
    "ercot_pagination_page_limit_exceeded",
  );
  await assertRejects(
    () =>
      collectErcotPages(
        "/api/data?page=1",
        async (url) => {
          const page = Number(url.searchParams.get("page"));
          return {
            data: page === 1 ? [1] : [],
            _meta: { currentPage: page, totalPages: 3, totalRecords: 2 },
          };
        },
        { apiBaseUrl: "https://api.test/api/" },
      ),
    "ercot_pagination_unexpected_empty_page",
  );
  await assertRejects(
    () =>
      collectErcotPages(
        "/api/data?page=1",
        async (url) => {
          const page = Number(url.searchParams.get("page"));
          return {
            data: [page],
            _meta: { currentPage: page, totalPages: page === 1 ? 2 : 3 },
          };
        },
        { apiBaseUrl: "https://api.test/api/" },
      ),
    "ercot_pagination_metadata_inconsistent",
  );
});

Deno.test("query helper permits only documented fields with bounded values", () => {
  const encoded = encodeErcotQuery(
    { z: [2, 1], operatingDayFrom: "2026-08-18", omitted: undefined },
    ["omitted", "operatingDayFrom", "z"],
  );
  assert(encoded === "operatingDayFrom=2026-08-18&z=2&z=1", "stable encoded query");
  assertThrows(
    () => encodeErcotQuery({ invented: "value" }, ["known"]),
    "ercot_query_field_not_allowed",
  );
  assertThrows(() => encodeErcotQuery({ z: [1, 2] }, ["z"], 1), "ercot_query_value_limit_exceeded");
});

Deno.test("OpenAPI reconciliation reports matched, live-only, and spec-only paths", async () => {
  const catalog = parseErcotProductCatalog(await jsonFixture("public_reports.catalog.json"), {
    apiBaseUrl: "https://api.test/api/",
    verifiedAt: "2026-08-18",
  });
  const result = reconcileCatalogWithOpenApi(catalog, await jsonFixture("openapi.catalog.json"));
  assert(result.matched.length === 2, "two live artifacts in spec");
  assert(result.liveOnly.length === 1, "one live-only artifact");
  assertEquals(result.specOnlyPaths, ["/spec-only/example"]);
  assertEquals(result.matched[0]!.queryParameters, ["operatingDayFrom", "operatingDayTo"]);
  assertEquals(result.matched[1]!.queryParameters, ["page", "postedDatetimeFrom"]);
  assertEquals(result.matched[0]!.methods, ["get"]);
});

Deno.test("OpenAPI reconciliation rejects malformed documents", async () => {
  const catalog = parseErcotProductCatalog(await jsonFixture("public_reports.catalog.json"), {
    apiBaseUrl: "https://api.test/api/",
    verifiedAt: "2026-08-18",
  });
  assertThrows(
    () => reconcileCatalogWithOpenApi(catalog, { paths: {} }),
    "ercot_openapi_document_invalid",
  );
});

Deno.test("provenance binds a source to its exact catalog artifact", async () => {
  const catalog = parseErcotProductCatalog(await jsonFixture("public_reports.catalog.json"), {
    apiBaseUrl: "https://api.test/api/",
    verifiedAt: "2026-08-18",
  });
  const provenance = sourceProvenance({
    artifact: catalog.artifacts[0]!,
    sourceId: "ercot_public_np3_565",
    sourceName: "ERCOT Public API NP3-565",
    sourcePublicationTimestamp: 1_787_040_000,
  });
  assert(provenance.emilId === "NP3-565-CD", "EMIL identity");
  assert(provenance.artifactPath.includes("actual_loads"), "exact artifact path");
  assert(provenance.verifiedAt === "2026-08-18", "schema verification date");
  assertThrows(
    () => sourceProvenance({ ...provenance, artifact: catalog.artifacts[0]!, sourceId: "" }),
    "ercot_provenance_source_id_invalid",
  );
});

Deno.test("parity diagnostics compare timestamp, category, units, and values with bounded output", () => {
  const api = [
    { ts: 1, zone: "NORTH", unit: "MW", value: 100.05 },
    { ts: 2, zone: "NORTH", unit: "MW", value: 110 },
    { ts: 3, zone: "NORTH", unit: "MW", value: 120 },
  ];
  const reference = [
    { ts: 1, zone: "NORTH", unit: "MW", value: 100 },
    { ts: 2, zone: "NORTH", unit: "kW", value: 110 },
    { ts: 4, zone: "NORTH", unit: "MW", value: 130 },
  ];
  const result = compareSourceParity(api, reference, {
    categoryFields: ["zone"],
    maximumDiagnostics: 2,
    timestampField: "ts",
    tolerance: 0.1,
    unitField: "unit",
    valueField: "value",
  });
  assert(result.matched === 1, "tolerant match");
  assert(result.aligned === 2, "two aligned keys");
  assert(result.missingApi === 1 && result.missingReference === 1, "missing-side counts");
  assert(result.unitMismatches === 1, "unit mismatch count");
  assert(result.valueComparisons === 1 && result.valueMismatches === 0, "numeric comparisons");
  assert(Math.abs((result.maximumAbsoluteDelta ?? 0) - 0.05) < 1e-9, "maximum delta");
  assert(Math.abs((result.meanAbsoluteDelta ?? 0) - 0.05) < 1e-9, "mean delta");
  assert(result.mismatches.length === 2 && result.truncated, "bounded diagnostics");
  assertEquals(
    result.mismatches.map((entry) => entry.reason),
    ["unit", "missing_reference"],
  );
  assertThrows(
    () =>
      compareSourceParity([{ ts: 1, value: "bad" }], [{ ts: 1, value: 1 }], {
        timestampField: "ts",
        valueField: "value",
      }),
    "ercot_parity_value_invalid",
  );
  assertThrows(
    () =>
      compareSourceParity(
        [
          { ts: 1, value: 1 },
          { ts: 1, value: 2 },
        ],
        [],
        {
          timestampField: "ts",
          valueField: "value",
        },
      ),
    "ercot_parity_duplicate_key",
  );
});

Deno.test("cardinality estimator exposes daily, retention, 30-day, and annual costs", () => {
  const estimate = estimateStorageCost({
    bytesPerRow: 100,
    indexOverheadRatio: 0.5,
    publicationsPerDay: 24,
    retentionDays: 90,
    rowsPerPublication: 10,
  });
  assert(estimate.rowsPerDay === 240, "rows/day");
  assert(estimate.rawBytesPerDay === 24_000, "raw bytes/day");
  assert(estimate.bytesPerDayWithIndexes === 36_000, "indexed bytes/day");
  assert(estimate.thirtyDayBytesWithIndexes === 1_080_000, "30-day bytes");
  assert(estimate.bytesPerYearWithIndexes === 13_140_000, "annual bytes");
  assert(estimate.retainedRows === 21_600, "retained rows");
  assert(estimate.retainedBytesWithIndexes === 3_240_000, "retained bytes");
  assertThrows(
    () =>
      estimateStorageCost({
        bytesPerRow: 0,
        publicationsPerDay: 1,
        retentionDays: 1,
        rowsPerPublication: 1,
      }),
    "ercot_storage_estimate_input_invalid",
  );
});
