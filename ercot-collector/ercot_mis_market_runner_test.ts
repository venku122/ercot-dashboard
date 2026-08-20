import {
  marketMechanicsRuntimeConfig,
  parseMarketDocumentList,
  runMarketMechanicsCycle,
  selectMarketDocuments,
  type HttpMarketMechanicsTransport,
  type MarketCheckpoint,
} from "./ercot_mis_market_runner.ts";
import { MARKET_PRODUCTS, type MarketProductId } from "./ercot_mis_market_mechanics.ts";
import type { MisDocument } from "./ercot_mis_renewable_publications.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function set16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function set32(bytes: Uint8Array, offset: number, value: number): void {
  set16(bytes, offset, value);
  set16(bytes, offset + 2, value >>> 16);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  const filename = new TextEncoder().encode("market.csv");
  const local = new Uint8Array(30 + filename.length + data.length);
  set32(local, 0, 0x04034b50);
  set16(local, 4, 20);
  set32(local, 14, crc32(data));
  set32(local, 18, data.length);
  set32(local, 22, data.length);
  set16(local, 26, filename.length);
  local.set(filename, 30);
  local.set(data, 30 + filename.length);
  const central = new Uint8Array(46 + filename.length);
  set32(central, 0, 0x02014b50);
  set16(central, 4, 20);
  set16(central, 6, 20);
  set32(central, 16, crc32(data));
  set32(central, 20, data.length);
  set32(central, 24, data.length);
  set16(central, 28, filename.length);
  central.set(filename, 46);
  const eocd = new Uint8Array(22);
  set32(eocd, 0, 0x06054b50);
  set16(eocd, 8, 1);
  set16(eocd, 10, 1);
  set32(eocd, 12, central.length);
  set32(eocd, 16, local.length);
  const output = new Uint8Array(local.length + central.length + eocd.length);
  output.set(local);
  output.set(central, local.length);
  output.set(eocd, local.length + central.length);
  return output;
}

function entry(index: number, csv: boolean) {
  const id = String(1_000_000 + index);
  return {
    DocID: id,
    ReportTypeID: "24891",
    SecurityStatus: "P",
    Extension: "zip",
    FriendlyName: csv ? "SCEDMCPCNP6332_csv" : "SCEDMCPCNP6332_xml",
    ConstructedName: `cdr.00024891.0000000000000000.20260818.115519595.SCEDMCPCNP6332_${csv ? "csv" : "xml"}.zip`,
    PublishDate: "2026-08-18T11:55:19-05:00",
    ContentSize: 512,
  };
}

Deno.test("market list admits bounded live cardinality and filters XML siblings", () => {
  const documents = Array.from({ length: 4_340 }, (_, index) => entry(index, index % 2 === 0));
  const parsed = parseMarketDocumentList(
    { ListDocsByRptTypeRes: { DocumentList: documents } },
    "NP6-332-CD",
  );
  equal(parsed.length, 2_170);
});

Deno.test("checkpoint selection drains newer oldest-first and idle downloads zero", () => {
  const documents: MisDocument[] = Array.from({ length: 70 }, (_, index) => ({
    docId: String(10 ** 15 + index),
    publishDate: "2026-08-18T11:55:19-05:00",
    issuedAt: 1_000 + index,
    constructedName: "x",
    contentSize: 1,
  }));
  const first = selectMarketDocuments(documents);
  equal(first.length, 48);
  equal(first[0]?.issuedAt, 1_022);
  const prior = {
    version: 2 as const,
    issued_at: 1_069,
    doc_id: documents[69]!.docId,
    gap_count: 0,
    gap_digest: null,
  };
  equal(selectMarketDocuments(documents, prior), []);
});

Deno.test("enabled runtime fails closed without endpoint and key", () => {
  let failed = false;
  try {
    marketMechanicsRuntimeConfig({
      get: (name) => (name === "ERCOT_MARKET_MECHANICS_INGEST_ENABLED" ? "true" : undefined),
    });
  } catch (error) {
    failed = error instanceof Error && error.message === "ercot_mis_market_runtime_config_missing";
  }
  equal(failed, true);
});

Deno.test("one product failure does not suppress other product health", async () => {
  const attempts: Record<string, unknown>[][] = [];
  const transport = {
    loadCheckpoint: async (_sourceId: string) => ({
      version: 2 as const,
      issued_at: 100,
      doc_id: "100",
      gap_count: 0,
      gap_digest: null,
    }),
    list: async (product: MarketProductId) => {
      if (product === "NP6-323-CD") throw new Error("ercot_mis_market_list_failed");
      return [];
    },
    download: async () => {
      throw new Error("unexpected_download");
    },
    ingest: async () => {
      throw new Error("unexpected_ingest");
    },
    saveHealth: async (items: Record<string, unknown>[]) => {
      attempts.push(items);
    },
  } as unknown as HttpMarketMechanicsTransport;
  let failed = false;
  try {
    await runMarketMechanicsCycle(transport, 1_000);
  } catch (error) {
    failed = error instanceof Error && error.message === "ercot_mis_market_list_failed";
  }
  equal(failed, true);
  equal(attempts[0]?.length, Object.keys(MARKET_PRODUCTS).length);
  const bySource = Object.fromEntries(attempts[0]!.map((item) => [item.source_id, item.success]));
  equal(bySource.ercot_mis_np6_323, false);
  equal(bySource.ercot_mis_np6_322, true);
  equal(bySource.ercot_mis_np6_328, true);
  equal(bySource.ercot_mis_np6_332, true);
});

Deno.test("expired document gap does not starve newer documents and persists while idle", async () => {
  const first: MisDocument = {
    docId: "100",
    publishDate: "2026-08-18T11:40:20-05:00",
    issuedAt: 1_787_071_220,
    constructedName: "expired.zip",
    contentSize: 128,
  };
  const second: MisDocument = {
    ...first,
    docId: "101",
    publishDate: "2026-08-18T11:45:20-05:00",
    issuedAt: 1_787_071_520,
    constructedName: "valid.zip",
  };
  const checkpoints = new Map<string, unknown>();
  const attempts: Record<string, unknown>[][] = [];
  let downloads = 0;
  const transport = {
    loadCheckpoint: async (sourceId: string) => checkpoints.get(sourceId),
    list: async (product: MarketProductId) => (product === "NP6-322-CD" ? [first, second] : []),
    download: async (document: MisDocument) => {
      downloads += 1;
      if (document.docId === first.docId) throw new Error("ercot_mis_market_download_failed");
      return storedZip("SCEDTimeStamp,RepeatedHourFlag,SystemLambda\n08/18/2026 11:45:18,N,42\n");
    },
    ingest: async () => undefined,
    saveHealth: async (items: Record<string, unknown>[]) => {
      attempts.push(items);
      for (const item of items)
        if (item.checkpoint !== undefined) checkpoints.set(String(item.source_id), item.checkpoint);
    },
  } as unknown as HttpMarketMechanicsTransport;

  await runMarketMechanicsCycle(transport, 1_787_071_530);
  const firstHealth = attempts[0]!.find((item) => item.source_id === "ercot_mis_np6_322")!;
  equal((firstHealth.checkpoint as MarketCheckpoint).doc_id, "101");
  equal((firstHealth.checkpoint as MarketCheckpoint).gap_count, 1);
  equal((firstHealth.diagnostics as Record<string, unknown>).gap_count, 1);
  equal(downloads, 2);

  await runMarketMechanicsCycle(transport, 1_787_071_830);
  const idleHealth = attempts[1]!.find((item) => item.source_id === "ercot_mis_np6_322")!;
  equal((idleHealth.checkpoint as MarketCheckpoint).doc_id, "101");
  equal((idleHealth.checkpoint as MarketCheckpoint).gap_count, 1);
  equal((idleHealth.diagnostics as Record<string, unknown>).gap_count, 1);
  equal(downloads, 2);
});

Deno.test("transient newest-document failure retries without minting a permanent gap", async () => {
  const document: MisDocument = {
    docId: "201",
    publishDate: "2026-08-18T11:45:20-05:00",
    issuedAt: 1_787_071_520,
    constructedName: "retry.zip",
    contentSize: 128,
  };
  const checkpoints = new Map<string, unknown>();
  const attempts: Record<string, unknown>[][] = [];
  let downloads = 0;
  const transport = {
    loadCheckpoint: async (sourceId: string) => checkpoints.get(sourceId),
    list: async (product: MarketProductId) => (product === "NP6-322-CD" ? [document] : []),
    download: async () => {
      downloads += 1;
      if (downloads === 1) throw new Error("ercot_mis_market_download_failed");
      return storedZip("SCEDTimeStamp,RepeatedHourFlag,SystemLambda\n08/18/2026 11:45:18,N,42\n");
    },
    ingest: async () => undefined,
    saveHealth: async (items: Record<string, unknown>[]) => {
      attempts.push(items);
      for (const item of items)
        if (item.checkpoint !== undefined) checkpoints.set(String(item.source_id), item.checkpoint);
    },
  } as unknown as HttpMarketMechanicsTransport;

  let firstFailed = false;
  try {
    await runMarketMechanicsCycle(transport, 1_787_071_530);
  } catch (error) {
    firstFailed = error instanceof Error && error.message === "ercot_mis_market_document_failed";
  }
  equal(firstFailed, true);
  const failedHealth = attempts[0]!.find((item) => item.source_id === "ercot_mis_np6_322")!;
  equal(failedHealth.success, false);
  equal(failedHealth.checkpoint, undefined);

  await runMarketMechanicsCycle(transport, 1_787_071_830);
  const recoveredHealth = attempts[1]!.find((item) => item.source_id === "ercot_mis_np6_322")!;
  equal(recoveredHealth.success, true);
  equal((recoveredHealth.checkpoint as MarketCheckpoint).doc_id, "201");
  equal((recoveredHealth.checkpoint as MarketCheckpoint).gap_count, 0);
  equal((recoveredHealth.diagnostics as Record<string, unknown>).gap_count, 0);
  equal(downloads, 2);
});
