import {
  HttpMisRenewableTransport,
  renewableRuntimeConfig,
  runRenewableCycle,
  type RenewableRuntimeTransport,
} from "./ercot_mis_renewable_runner.ts";
import type { RenewablePublicationPayload } from "./ercot_mis_renewable_publications.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(fn: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message === expected,
      `expected ${expected}, got ${error}`,
    );
    return;
  }
  throw new Error(`expected ${expected}`);
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message === expected,
      `expected ${expected}, got ${error}`,
    );
    return;
  }
  throw new Error(`expected ${expected}`);
}

Deno.test("renewable runtime is disabled by default and fails honest without receiver credentials", () => {
  const values = new Map<string, string>();
  const disabled = renewableRuntimeConfig({ get: (name) => values.get(name) });
  assert(!disabled.enabled && disabled.reason === "disabled");
  values.set("ERCOT_RENEWABLE_INGEST_ENABLED", "true");
  const missing = renewableRuntimeConfig({ get: (name) => values.get(name) });
  assert(!missing.enabled && missing.reason === "missing_environment");
  values.set("ERCOT_RENEWABLE_ENDPOINT", "http://receiver:8080/api/renewable-publications/ingest");
  values.set("METRICS_API_KEY", "synthetic-test-key");
  const config = renewableRuntimeConfig({ get: (name) => values.get(name) });
  assert(config.enabled && config.endpoint.endsWith("/api/renewable-publications/ingest"));
});

Deno.test("HTTP transport uses exact public list query and never sends receiver secret to ERCOT", async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(Response.json({ ListDocsByRptType: { RespData: [] } }));
  };
  const transport = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    fakeFetch,
  );
  await transport.list(13028);
  assert(requests.length === 1);
  assert(
    requests[0]!.url ===
      "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId=13028",
  );
  assert(requests[0]!.headers.get("X-API-Key") === null);
  await assertRejects(() => transport.list(999), "ercot_mis_report_type_invalid");
});

Deno.test("HTTP list body is bounded before JSON parsing", async () => {
  const transport = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    () => Promise.resolve(new Response("{}", { headers: { "Content-Length": "1048577" } })),
  );
  await assertRejects(() => transport.list(13028), "ercot_mis_http_failed_size");
});

Deno.test("HTTP ingest requires the exact authenticated route and strict receiver result", async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(
      Response.json({
        status: "inserted",
        vintage_key: `rv1-${"a".repeat(64)}`,
        content_hash: "b".repeat(64),
        row_count: 1,
      }),
    );
  };
  const transport = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    fakeFetch,
  );
  const payload = {
    publication: {},
    rows: [{ target_ts: 1 }],
  } as unknown as RenewablePublicationPayload;
  await transport.ingest(payload);
  assert(requests[0]!.url === "http://receiver:8080/api/renewable-publications/ingest");
  assert(requests[0]!.headers.get("X-API-Key") === "synthetic-test-key");
  assert(requests[0]!.redirect === "error");
});

Deno.test("receiver key cannot be configured over non-local plaintext HTTP", () => {
  assertThrows(
    () =>
      new HttpMisRenewableTransport(
        "http://example.com/api/renewable-publications/ingest",
        "synthetic-test-key",
      ),
    "ercot_mis_receiver_config_invalid",
  );
  new HttpMisRenewableTransport(
    "https://receiver.example/api/renewable-publications/ingest",
    "synthetic-test-key",
  );
});

Deno.test("loaded checkpoint is strict and bounded before it controls collection", async () => {
  const transport = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    () =>
      Promise.resolve(
        Response.json({
          checkpoint: {
            version: 1,
            highWater: { "NP4-732-CD": { issuedAt: 1_787_000_000, docId: "100" } },
            overlapDocIds: ["99", "100"],
          },
        }),
      ),
  );
  const checkpoint = await transport.loadCheckpoint();
  assert(checkpoint?.highWater?.["NP4-732-CD"]?.docId === "100");
  const invalid = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    () =>
      Promise.resolve(
        Response.json({
          checkpoint: {
            version: 1,
            highWater: { "NP4-732-CD": { issuedAt: -1, docId: "not-numeric" } },
            overlapDocIds: [],
          },
        }),
      ),
  );
  await assertRejects(() => invalid.loadCheckpoint(), "ercot_mis_checkpoint_response_invalid");
});

Deno.test("failed health is redacted, checkpoint does not advance, and next cycle recovers", async () => {
  let fail = true;
  const saved: number[] = [];
  const failures: string[] = [];
  const transport: RenewableRuntimeTransport = {
    loadCheckpoint() {
      return Promise.resolve(undefined);
    },
    list() {
      if (fail) throw new Error("secret-content-must-not-escape");
      return Promise.resolve({ docs: [] });
    },
    download() {
      throw new Error("unexpected download");
    },
    ingest() {
      throw new Error("unexpected ingest");
    },
    saveHealth(input) {
      saved.push(input.attemptedAt);
      assert(Object.values(input.products).every((product) => product.rowCount === 0));
      assert(
        Object.values(input.products).every((product) => product.newestIssuedAt === undefined),
      );
      return Promise.resolve();
    },
    saveFailure(_attemptedAt, error) {
      failures.push(error);
      return Promise.resolve();
    },
  };
  await assertRejects(() => runRenewableCycle(transport, 1_787_000_000), "ercot_mis_cycle_failed");
  assert(failures.join(",") === "ercot_mis_cycle_failed");
  assert(saved.join(",") === "");
  fail = false;
  await runRenewableCycle(transport, 1_787_003_600);
  assert(saved.length === 1);
});

Deno.test("successful health freshness comes from official publication high-water", async () => {
  const newest: number[] = [];
  const transport: RenewableRuntimeTransport = {
    loadCheckpoint() {
      return Promise.resolve({
        highWater: {
          "NP4-732-CD": { issuedAt: 1_787_000_000, docId: "100" },
          "NP4-737-CD": { issuedAt: 1_787_003_600, docId: "200" },
        },
        overlapDocIds: [],
      });
    },
    list() {
      return Promise.resolve({ docs: [] });
    },
    download() {
      throw new Error("unexpected download");
    },
    ingest() {
      throw new Error("unexpected ingest");
    },
    saveHealth(input) {
      for (const product of Object.values(input.products)) {
        if (product.newestIssuedAt !== undefined) newest.push(product.newestIssuedAt);
      }
      return Promise.resolve();
    },
    saveFailure() {
      throw new Error("unexpected failure health");
    },
  };
  await runRenewableCycle(transport, 1_787_007_200);
  assert(newest.sort().join(",") === "1787000000,1787003600");
});

Deno.test("success health emits both manifest source IDs with product-specific freshness", async () => {
  const bodies: unknown[] = [];
  const transport = new HttpMisRenewableTransport(
    "http://receiver:8080/api/renewable-publications/ingest",
    "synthetic-test-key",
    async (input, init) => {
      bodies.push(await new Request(input, init).json());
      return Response.json({ updated: 2 });
    },
  );
  await transport.saveHealth({
    attemptedAt: 1_787_007_200,
    checkpoint: {
      highWater: {
        "NP4-732-CD": { issuedAt: 1_787_000_000, docId: "100" },
        "NP4-737-CD": { issuedAt: 1_787_003_600, docId: "200" },
      },
      overlapDocIds: ["100", "200"],
    },
    products: {
      "NP4-732-CD": {
        backlogCount: 3,
        bootstrapTruncated: false,
        newestIssuedAt: 1_787_000_000,
        processedDocuments: 1,
        rowCount: 216,
      },
      "NP4-737-CD": {
        backlogCount: 0,
        bootstrapTruncated: true,
        newestIssuedAt: 1_787_003_600,
        processedDocuments: 2,
        rowCount: 432,
      },
    },
  });
  const attempts = bodies[0] as Array<Record<string, unknown>>;
  assert(
    attempts.map((attempt) => attempt.source_id).join(",") ===
      "ercot_mis_np4_732,ercot_mis_np4_737",
  );
  assert(
    attempts.map((attempt) => attempt.source_timestamp_ts).join(",") === "1787000000,1787003600",
  );
  assert(attempts.map((attempt) => attempt.row_count).join(",") === "216,432");
  await transport.saveFailure(1_787_010_800, "ercot_mis_download_failed");
  const failures = bodies[1] as Array<Record<string, unknown>>;
  assert(
    failures.map((attempt) => attempt.source_id).join(",") ===
      "ercot_mis_np4_732,ercot_mis_np4_737",
  );
  assert(failures.every((attempt) => attempt.success === false && !("checkpoint" in attempt)));
});
