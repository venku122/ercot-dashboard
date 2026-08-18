import {
  ForecastPublicationCollector,
  HttpForecastReceiver,
  MAX_FORECAST_PUBLICATION_BYTES,
  forecastQueryWindow,
  forecastRuntimeConfig,
  type ForecastPublicClient,
  type ForecastReceiver,
} from "./ercot_public_load_collector.ts";
import {
  buildForecastPublicationPayload,
  ERCOT_PUBLIC_LOAD_SOURCES,
  parseErcotPublicLoadPage,
  type CompletePublicLoadRows,
  type ErcotPublicLoadProductId,
  type ForecastPublicationPayload,
} from "./ercot_public_load_sources.ts";
import type { ErcotPublicInventory, ErcotQuery } from "./ercot_api.ts";

type JsonObject = Record<string, unknown>;

const fixture = (name: string) => new URL(`./fixtures/ercot_public_load/${name}`, import.meta.url);

async function jsonFixture(name: string): Promise<JsonObject> {
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

async function assertRejects(callback: () => Promise<unknown>, expected: string) {
  try {
    await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected ${expected}, received ${message}`);
    return;
  }
  throw new Error(`expected ${expected}`);
}

function page(
  template: JsonObject,
  rows: unknown[][],
  currentPage: number,
  totalPages: number,
  totalRecords: number,
): JsonObject {
  const result = structuredClone(template);
  result.data = rows;
  result._meta = {
    currentPage,
    pageSize: Math.max(1, rows.length),
    totalPages,
    totalRecords,
  };
  return result;
}

function inventory(): ErcotPublicInventory {
  return {
    reports: Object.entries(ERCOT_PUBLIC_LOAD_SOURCES).map(([emilId, source]) => ({
      emilId,
      artifacts: [{ _links: { endpoint: { href: source.artifactHref } } }],
    })),
    raw: {},
  };
}

class FakeReceiver implements ForecastReceiver {
  readonly attempts: JsonObject[] = [];
  readonly ingested: ForecastPublicationPayload[] = [];
  readonly checkpoints = new Map<string, number>();

  async ingest(payload: ForecastPublicationPayload) {
    this.ingested.push(structuredClone(payload));
    return {
      content_hash: "a".repeat(64),
      row_count: payload.rows.length,
      status: this.ingested.length <= 2 ? ("inserted" as const) : ("unchanged" as const),
      vintage_key: `v1-${"b".repeat(64)}`,
    };
  }

  async loadCheckpoint(sourceId: string) {
    return this.checkpoints.get(sourceId) ?? null;
  }

  async sourceHealth(attempt: JsonObject) {
    this.attempts.push(structuredClone(attempt));
    const checkpoint = attempt.checkpoint;
    if (
      attempt.success === true &&
      typeof attempt.source_id === "string" &&
      checkpoint !== null &&
      typeof checkpoint === "object" &&
      Number.isInteger((checkpoint as JsonObject).last_successful_window_end)
    ) {
      this.checkpoints.set(
        attempt.source_id,
        (checkpoint as JsonObject).last_successful_window_end as number,
      );
    }
  }
}

async function normalPages() {
  const np565 = await jsonFixture("np3_565.sample.json");
  const first565 = structuredClone((np565.data as unknown[][])[0]!);
  const second565 = structuredClone(first565);
  second565[12] = "STLF";
  second565[13] = true;

  const np763 = await jsonFixture("np3_763.valid_empty.json");
  const np345 = await jsonFixture("np6_345.sample.json");
  const row345 = structuredClone((np345.data as unknown[][])[0]!);
  return new Map<string, JsonObject[]>([
    [
      ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref,
      [page(np565, [first565], 1, 2, 2), page(np565, [second565], 2, 2, 2)],
    ],
    [ERCOT_PUBLIC_LOAD_SOURCES["NP3-763-CD"].artifactHref, [np763]],
    [ERCOT_PUBLIC_LOAD_SOURCES["NP6-345-CD"].artifactHref, [page(np345, [row345], 1, 1, 1)]],
  ]);
}

class FakeClient implements ForecastPublicClient {
  readonly calls: Array<{ href: string; query: ErcotQuery }> = [];

  constructor(readonly pages: Map<string, JsonObject[]>) {}

  async publicReports() {
    return inventory();
  }

  async publicArtifact<T = unknown>(
    _report: JsonObject,
    advertisedHref: string,
    query: ErcotQuery = {},
  ): Promise<T> {
    this.calls.push({ href: advertisedHref, query: { ...query } });
    const pages = this.pages.get(advertisedHref);
    const pageNumber = Number(query.page ?? 1);
    if (!pages?.[pageNumber - 1]) throw new Error("fake_page_missing");
    return structuredClone(pages[pageNumber - 1]) as T;
  }
}

Deno.test("collector follows advertised links, completes pagination, groups vintages, and records valid-empty health", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const client = new FakeClient(await normalPages());
  const receiver = new FakeReceiver();
  const collector = new ForecastPublicationCollector(client, receiver, { now: () => now });

  assertEquals(await collector.collectOnce(), {
    failed: [],
    succeeded: ["NP3-565-CD", "NP3-763-CD", "NP6-345-CD"],
  });
  assertEquals(
    client.calls.filter((call) => call.href.includes("np3-565")).map((call) => call.query.page),
    [1, 2],
    "NP3-565 fetches every advertised page",
  );
  assert(
    client.calls.every(
      (call) =>
        call.href ===
        ERCOT_PUBLIC_LOAD_SOURCES[
          call.href.includes("np3-565")
            ? "NP3-565-CD"
            : call.href.includes("np3-763")
              ? "NP3-763-CD"
              : "NP6-345-CD"
        ].artifactHref,
    ),
    "only exact advertised artifacts are requested",
  );
  assert(receiver.ingested.length === 2, "valid-empty source is not ingested");
  const forecast = receiver.ingested.find(
    (payload) => payload.publication.product_id === "NP3-565-CD",
  );
  assert(forecast?.rows.length === 2, "two-page forecast is one atomic publication");
  assert(
    new Set(forecast.rows.map((row) => row.postedDatetime)).size === 1,
    "forecast payload has exactly one posted vintage",
  );
  assert(
    forecast.publication.publication_key === forecast.publication.raw_posted_datetime &&
      forecast.publication.publication_key_kind === "official_posted_datetime",
    "official posted identity is preserved",
  );
  const forecastHealth = receiver.attempts.find(
    (attempt) => attempt.source_id === ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].sourceId,
  );
  assert(forecastHealth, "forecast health recorded");
  const forecastDiagnostics = forecastHealth.diagnostics as JsonObject;
  assert(
    forecastHealth.source_timestamp_ts === forecast.publication.issued_at &&
      forecastHealth.data_timestamp_ts === forecast.publication.issued_at &&
      Number(forecastDiagnostics.target_min_ts) ===
        Math.min(...forecast.rows.map((row) => Number(row.target_ts))) &&
      Number(forecastDiagnostics.target_max_ts) ===
        Math.max(...forecast.rows.map((row) => Number(row.target_ts))),
    "forecast freshness uses issued time and diagnostics preserve target range",
  );
  const actual = receiver.ingested.find(
    (payload) => payload.publication.product_id === "NP6-345-CD",
  );
  assert(
    actual?.publication.publication_key_kind === "content_hash" &&
      !("publication_key" in actual.publication) &&
      !("issued_at" in actual.publication),
    "actual snapshot identity is receiver-derived",
  );
  const actualHealth = receiver.attempts.find(
    (attempt) => attempt.source_id === ERCOT_PUBLIC_LOAD_SOURCES["NP6-345-CD"].sourceId,
  );
  assert(actualHealth && actual, "actual health recorded");
  const actualTarget = Math.max(...actual.rows.map((row) => Number(row.target_ts)));
  assert(
    actualHealth.source_timestamp_ts === actualTarget &&
      actualHealth.data_timestamp_ts === actualTarget,
    "actual freshness uses its newest observed target",
  );
  const empty = receiver.attempts.find(
    (attempt) => attempt.source_id === ERCOT_PUBLIC_LOAD_SOURCES["NP3-763-CD"].sourceId,
  );
  assert(
    empty?.success === true && empty.row_count === 0 && empty.availability_status === "empty",
    "valid-empty is successful source health",
  );
  assert(
    client.calls.every((call) => Number(call.query.size) === 1_000 && Number(call.query.page) >= 1),
    "all requests are paginated and bounded",
  );
});

Deno.test("durable checkpoints bound overlap while receiver idempotence makes replay safe", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const receiver = new FakeReceiver();
  const sourceId = ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].sourceId;
  receiver.checkpoints.set(sourceId, now - 3_600);
  const pages = await normalPages();
  for (const payload of pages.get(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref)!) {
    (payload.data as unknown[][])[0]![0] = "2026-08-18T12:00:00";
  }
  const client = new FakeClient(pages);
  const collector = new ForecastPublicationCollector(client, receiver, {
    now: () => now,
    overlapSeconds: 7_200,
  });
  assert((await collector.collectOnce()).succeeded.includes("NP3-565-CD"), "first replay cycle");
  assert((await collector.collectOnce()).succeeded.includes("NP3-565-CD"), "second replay cycle");

  const starts = client.calls
    .filter((call) => call.href.includes("np3-565") && call.query.page === 1)
    .map((call) => call.query.postedDatetimeFrom);
  assertEquals(starts, ["2026-08-18T10:00:00", "2026-08-18T11:00:00"]);
  assert(receiver.ingested.length === 4, "bounded replay is submitted atomically");
  assert(
    receiver.attempts
      .filter((attempt) => attempt.source_id === sourceId)
      .every(
        (attempt) =>
          (attempt.checkpoint as JsonObject).last_successful_window_end === now &&
          (attempt.checkpoint as JsonObject).overlap_seconds === 7_200,
      ),
    "successful source health persists the reviewed checkpoint",
  );
});

Deno.test("overlap windows preserve the delivery union across Chicago midnight and DST", async () => {
  for (const scenario of [
    {
      expected: {
        deliveryDateFrom: "2026-08-18",
        deliveryDateTo: "2026-08-26",
        postedDatetimeFrom: "2026-08-18T21:30:00",
        postedDatetimeTo: "2026-08-19T00:30:00",
      },
      end: Date.parse("2026-08-19T05:30:00Z") / 1_000,
      start: Date.parse("2026-08-19T02:30:00Z") / 1_000,
    },
    {
      expected: {
        deliveryDateFrom: "2025-11-02",
        deliveryDateTo: "2025-11-09",
        postedDatetimeFrom: "2025-11-02T00:30:00",
        postedDatetimeTo: "2025-11-02T02:30:00",
      },
      end: Date.parse("2025-11-02T08:30:00Z") / 1_000,
      start: Date.parse("2025-11-02T05:30:00Z") / 1_000,
    },
  ]) {
    const query = forecastQueryWindow("NP3-565-CD", scenario.start, scenario.end);
    assertEquals(
      Object.fromEntries(Object.keys(scenario.expected).map((key) => [key, query[key]])),
      scenario.expected,
    );
  }
});

Deno.test("a partial pagination failure never ingests or advances that source", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const pages = await normalPages();
  pages.set(
    ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref,
    pages.get(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref)!.slice(0, 1),
  );
  const receiver = new FakeReceiver();
  const collector = new ForecastPublicationCollector(new FakeClient(pages), receiver, {
    now: () => now,
  });
  const result = await collector.collectOnce();
  assertEquals(result.failed, ["NP3-565-CD"]);
  assert(
    receiver.ingested.every((payload) => payload.publication.product_id !== "NP3-565-CD"),
    "sampled first page is never published",
  );
  assert(
    !receiver.checkpoints.has(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].sourceId),
    "failed source checkpoint is not advanced",
  );
});

Deno.test("advertised row and page totals above deployment caps fail on the first page", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const href = ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref;
  const sourceId = ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].sourceId;
  const source = await jsonFixture("np3_565.sample.json");
  const row = (source.data as unknown[][])[0]!;
  for (const oversized of [
    page(source, [row], 1, 101, 100_001),
    page(source, [row], 1, 101, 100_000),
  ]) {
    const pages = await normalPages();
    pages.set(href, [oversized]);
    const client = new FakeClient(pages);
    const receiver = new FakeReceiver();
    const result = await new ForecastPublicationCollector(client, receiver, {
      now: () => now,
    }).collectOnce();
    assertEquals(result.failed, ["NP3-565-CD"]);
    assert(
      client.calls.filter((call) => call.href === href).length === 1,
      "oversized metadata fails before accumulation",
    );
    assert(
      receiver.ingested.every((payload) => payload.publication.product_id !== "NP3-565-CD") &&
        !receiver.checkpoints.has(sourceId),
      "oversized source cannot ingest or advance its checkpoint",
    );
  }
});

Deno.test("returned rows must fall inside every requested source window", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const cases: Array<{
    fixtureName: string;
    mutate: (row: unknown[]) => void;
    productId: ErcotPublicLoadProductId;
  }> = [
    {
      fixtureName: "np3_565.sample.json",
      mutate: (row) => {
        row[1] = "2026-08-15";
      },
      productId: "NP3-565-CD",
    },
    {
      fixtureName: "np3_763.sample.json",
      mutate: (row) => {
        row[0] = "2026-08-15T07:00:55";
      },
      productId: "NP3-763-CD",
    },
    {
      fixtureName: "np6_345.sample.json",
      mutate: (row) => {
        row[0] = "2026-08-15";
      },
      productId: "NP6-345-CD",
    },
  ];
  for (const scenario of cases) {
    const source = await jsonFixture(scenario.fixtureName);
    const row = structuredClone((source.data as unknown[][])[0]!);
    scenario.mutate(row);
    const pages = await normalPages();
    pages.set(ERCOT_PUBLIC_LOAD_SOURCES[scenario.productId].artifactHref, [
      page(source, [row], 1, 1, 1),
    ]);
    const receiver = new FakeReceiver();
    const result = await new ForecastPublicationCollector(new FakeClient(pages), receiver, {
      now: () => now,
    }).collectOnce();
    assert(result.failed.includes(scenario.productId), `${scenario.productId} fails closed`);
    assert(
      receiver.ingested.every((payload) => payload.publication.product_id !== scenario.productId) &&
        !receiver.checkpoints.has(ERCOT_PUBLIC_LOAD_SOURCES[scenario.productId].sourceId),
      `${scenario.productId} wrong-window rows have no side effects`,
    );
  }
});

Deno.test("posted-time source bounds are inclusive at both exact endpoints", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const source = await jsonFixture("np3_565.sample.json");
  const lower = structuredClone((source.data as unknown[][])[0]!);
  lower[0] = "2026-08-16T13:00:00";
  lower[1] = "2026-08-16";
  const upper = structuredClone(lower);
  upper[0] = "2026-08-18T13:00:00";
  upper[1] = "2026-08-25";
  const pages = await normalPages();
  pages.set(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref, [
    page(source, [lower], 1, 2, 2),
    page(source, [upper], 2, 2, 2),
  ]);
  const receiver = new FakeReceiver();
  const result = await new ForecastPublicationCollector(new FakeClient(pages), receiver, {
    now: () => now,
  }).collectOnce();
  assert(result.succeeded.includes("NP3-565-CD"), "inclusive endpoint rows are ingested");
  assert(receiver.checkpoints.has(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].sourceId), "advanced");
});

Deno.test("representative maximum NP3-565 publication fits the reviewed one-MiB atomic cap", async () => {
  const source = await jsonFixture("np3_565.sample.json");
  const parsed = parseErcotPublicLoadPage(
    "NP3-565-CD",
    page(source, source.data as unknown[][], 1, 1, 1),
  );
  const base = parsed.rows[0]!;
  const models = ["A3", "A6", "E", "E1", "E2", "E3", "M", "X"];
  const rows = Array.from({ length: 1_536 }, (_unused, index) => ({
    ...base,
    deliveryDate: `2026-08-${String(18 + Math.floor(index / (24 * models.length))).padStart(2, "0")}`,
    hourEnding: `${(Math.floor(index / models.length) % 24) + 1}:00`,
    model: models[index % models.length],
  }));
  const complete: CompletePublicLoadRows = {
    fields: parsed.fields,
    productId: "NP3-565-CD",
    rows,
    totalRecords: rows.length,
  };
  const payload = await buildForecastPublicationPayload(complete, {
    queryWindow: {
      postedDatetimeFrom: "2026-08-18T06:00:00",
      postedDatetimeTo: "2026-08-18T07:00:00",
    },
    rawPostedDatetime: "2026-08-18T06:30:00",
    retrievedAt: Date.parse("2026-08-18T18:00:00Z") / 1_000,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  assert(bytes >= 430_000 && bytes <= 500_000, `frozen max-shape bytes changed: ${bytes}`);
  assert(bytes <= MAX_FORECAST_PUBLICATION_BYTES, "full immutable publication fits one MiB");
});

Deno.test("collector rejects an over-one-MiB publication without splitting or ingesting it", async () => {
  const now = Date.parse("2026-08-18T18:00:00Z") / 1_000;
  const pages = await normalPages();
  const source = await jsonFixture("np3_565.sample.json");
  const base = (source.data as unknown[][])[0]!;
  const rows = Array.from({ length: 2_000 }, (_unused, index) => {
    const row = structuredClone(base);
    row[2] = `${(index % 24) + 1}:00`;
    row[12] = `${"M".repeat(520)}-${index}`;
    return row;
  });
  pages.set(ERCOT_PUBLIC_LOAD_SOURCES["NP3-565-CD"].artifactHref, [
    page(source, rows.slice(0, 1_000), 1, 2, 2_000),
    page(source, rows.slice(1_000), 2, 2, 2_000),
  ]);
  const receiver = new FakeReceiver();
  const result = await new ForecastPublicationCollector(new FakeClient(pages), receiver, {
    now: () => now,
  }).collectOnce();
  assertEquals(result.failed, ["NP3-565-CD"]);
  assert(
    receiver.ingested.every((payload) => payload.publication.product_id !== "NP3-565-CD"),
    "oversize immutable publication is rejected, never split",
  );
});

Deno.test("HTTP receiver uses exact routes, authentication, and response contracts", async () => {
  const requests: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    const rawBody = request.method === "GET" ? "" : await request.clone().text();
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    requests.push({
      body,
      headers: request.headers,
      method: request.method,
      url,
    });
    if (url.includes("source-checkpoint")) {
      return Response.json({ checkpoint: { version: 1, last_successful_window_end: 123 } });
    }
    if (url.endsWith("/api/source-health")) return Response.json({ updated: 1 });
    return Response.json({
      status: "inserted",
      vintage_key: `v1-${"a".repeat(64)}`,
      content_hash: "b".repeat(64),
      row_count: 1,
    });
  };
  const receiver = new HttpForecastReceiver(
    "http://receiver:8080/api/forecast-publications/ingest",
    "test-api-key",
    fetcher,
  );
  const minimal = { publication: {}, rows: [{}] } as unknown as ForecastPublicationPayload;
  await receiver.ingest(minimal);
  await receiver.sourceHealth({ source_id: "source" });
  assert((await receiver.loadCheckpoint("source")) === 123, "checkpoint parsed");
  assertEquals(
    requests.map((request) => [new URL(request.url).pathname, request.method]),
    [
      ["/api/forecast-publications/ingest", "POST"],
      ["/api/source-health", "POST"],
      ["/api/source-checkpoint", "GET"],
    ],
  );
  assert(
    requests.every((request) => request.headers.get("X-API-Key") === "test-api-key"),
    "all receiver requests are authenticated",
  );
  await assertRejects(
    async () =>
      new HttpForecastReceiver("http://example.com/api/forecast-publications/ingest", "x"),
    "ercot_forecast_receiver_configuration_invalid",
  );
});

Deno.test("runtime is explicitly disabled and fails honest when any secret is absent", () => {
  const values = new Map<string, string>();
  const environment = { get: (name: string) => values.get(name) };
  assertEquals(forecastRuntimeConfig(environment), { enabled: false, reason: "disabled" });
  values.set("ERCOT_FORECAST_INGEST_ENABLED", "true");
  assertEquals(forecastRuntimeConfig(environment), {
    enabled: false,
    reason: "missing_environment",
  });
  Object.entries({
    ERCOT_API_USERNAME: "account",
    ERCOT_API_PASSWORD: "password",
    ERCOT_PUBLIC_API_SUBSCRIPTION_KEY: "public-key",
    ERCOT_ESR_API_SUBSCRIPTION_KEY: "esr-key",
    ERCOT_FORECAST_ENDPOINT: "http://receiver:8080/api/forecast-publications/ingest",
    METRICS_API_KEY: "metrics-key",
  }).forEach(([key, value]) => values.set(key, value));
  const config = forecastRuntimeConfig(environment);
  assert(config.enabled, "complete config enables collection");
  assert(config.credentials.username === "account", "credentials are passed without logging");
});
