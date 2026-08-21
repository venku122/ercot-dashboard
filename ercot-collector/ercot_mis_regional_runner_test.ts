import {
  HttpRegionalRenewableTransport,
  regionalRenewableRuntimeConfig,
  runRegionalRenewableCycle,
  selectRegionalDocuments,
} from "./ercot_mis_regional_runner.ts";
import type { MisDocument } from "./ercot_mis_renewable_publications.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion_failed");
}
function document(docId: string, issuedAt: number): MisDocument {
  return {
    docId,
    issuedAt,
    publishDate: "2026-08-18T01:00:00-05:00",
    constructedName: `doc-${docId}.zip`,
    contentSize: 100,
  };
}

Deno.test("regional runner bootstraps recent documents then drains backlog with overlap", () => {
  const listed = Array.from({ length: 80 }, (_, index) =>
    document(String(index + 1), 1000 + index),
  );
  const bootstrap = selectRegionalDocuments(listed);
  assert(bootstrap.length === 48 && bootstrap[0]!.docId === "33" && bootstrap[47]!.docId === "80");
  const drain = selectRegionalDocuments(listed, { version: 1, issued_at: 1010, doc_id: "11" });
  assert(drain.length === 49 && drain[0]!.docId === "11" && drain[1]!.docId === "12");
});

Deno.test("regional runner compares huge document IDs without Number precision", () => {
  const selected = selectRegionalDocuments([
    document("99999999999999999999", 1000),
    document("10000000000000000000", 1000),
  ]);
  assert(selected[0]!.docId === "10000000000000000000");
  assert(selected[1]!.docId === "99999999999999999999");
});

Deno.test("regional runtime is disabled explicitly and fails closed when enabled incomplete", () => {
  const values = new Map<string, string>();
  assert(regionalRenewableRuntimeConfig({ get: (name) => values.get(name) }).enabled === false);
  values.set("ERCOT_REGIONAL_RENEWABLE_INGEST_ENABLED", "true");
  let failed = false;
  try {
    regionalRenewableRuntimeConfig({ get: (name) => values.get(name) });
  } catch {
    failed = true;
  }
  assert(failed);
});

Deno.test("regional cycle isolates one product failure and recovers next cycle", async () => {
  class Fake extends HttpRegionalRenewableTransport {
    failSolar = true;
    health: Array<Record<string, unknown>[]> = [];
    constructor() {
      super("http://receiver:8080/api/regional-renewable-publications/ingest", "key", fetch);
    }
    override async loadCheckpoint(sourceId: string) {
      return sourceId.endsWith("742")
        ? { version: 1 as const, issued_at: 1000, doc_id: "10" }
        : undefined;
    }
    override async list(productId: "NP4-742-CD" | "NP4-745-CD") {
      if (productId === "NP4-745-CD" && this.failSolar)
        throw new Error("ercot_mis_regional_list_failed");
      return [];
    }
    override async saveHealth(attempts: Record<string, unknown>[]) {
      this.health.push(attempts);
    }
  }
  const fake = new Fake();
  let failed = false;
  try {
    await runRegionalRenewableCycle(fake, 2000);
  } catch {
    failed = true;
  }
  assert(failed);
  assert(fake.health[0]![0]!.success === true && fake.health[0]![1]!.success === false);
  assert((fake.health[0]![0]!.checkpoint as { doc_id: string }).doc_id === "10");
  fake.failSolar = false;
  await runRegionalRenewableCycle(fake, 3000);
  assert(fake.health[1]!.every((attempt) => attempt.success === true));
});
