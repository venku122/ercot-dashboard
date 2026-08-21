import {
  parsePublicMarketGeographyDocumentList,
  publicMarketGeographyRuntimeConfig,
  runPublicMarketGeographyCycle,
  selectPublicMarketGeographyDocuments,
  type HttpPublicMarketGeographyTransport,
  type MarketGeographyCheckpoint,
} from "./ercot_public_market_geography_runner.ts";
import type { MarketGeographyProductId } from "./ercot_public_market_geography.ts";
import type { MisDocument } from "./ercot_mis_renewable_publications.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function set16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}
function set32(bytes: Uint8Array, offset: number, value: number) {
  set16(bytes, offset, value);
  set16(bytes, offset + 2, value >>> 16);
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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
  const end = new Uint8Array(22);
  set32(end, 0, 0x06054b50);
  set16(end, 8, 1);
  set16(end, 10, 1);
  set32(end, 12, central.length);
  set32(end, 16, local.length);
  const output = new Uint8Array(local.length + central.length + end.length);
  output.set(local);
  output.set(central, local.length);
  output.set(end, local.length + central.length);
  return output;
}

function entry(index: number, csv: boolean) {
  return {
    DocID: String(1_000_000 + index),
    ReportTypeID: "12301",
    SecurityStatus: "P",
    Extension: "zip",
    FriendlyName: csv ? "SPPHLZNP6905_csv" : "SPPHLZNP6905_xml",
    ConstructedName: `cdr.00012301.0000000000000000.20260818.123456789.SPPHLZNP6905_20260818_1234_${csv ? "csv" : "xml"}.zip`,
    PublishDate: "2026-08-18T12:35:00-05:00",
    ContentSize: 512,
  };
}

Deno.test("market geography list admits live cardinality and only exact CSV sibling", () => {
  const documents = Array.from({ length: 4_000 }, (_, index) => entry(index, index % 2 === 0));
  equal(
    parsePublicMarketGeographyDocumentList(
      { ListDocsByRptTypeRes: { DocumentList: documents } },
      "NP6-905-CD",
    ).length,
    2_000,
  );
});

Deno.test("market geography checkpoint drains oldest new documents and idles", () => {
  const documents: MisDocument[] = Array.from({ length: 70 }, (_, index) => ({
    docId: String(10 ** 15 + index),
    publishDate: "2026-08-18T12:35:00-05:00",
    issuedAt: 1_000 + index,
    constructedName: "x",
    contentSize: 1,
  }));
  const selected = selectPublicMarketGeographyDocuments(documents);
  equal(selected.length, 48);
  equal(selected[0]?.issuedAt, 1_022);
  const checkpoint: MarketGeographyCheckpoint = {
    version: 2,
    issued_at: 1_069,
    document_id: documents[69]!.docId,
    gap_count: 0,
    gap_digest: null,
  };
  equal(selectPublicMarketGeographyDocuments(documents, checkpoint), []);
});

Deno.test("enabled market geography runtime fails closed without endpoint and key", () => {
  let failed = false;
  try {
    publicMarketGeographyRuntimeConfig({
      get: (name) => (name === "ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED" ? "true" : undefined),
    });
  } catch (error) {
    failed = error instanceof Error && error.message === "market_geography_runtime_config";
  }
  equal(failed, true);
});

Deno.test("one market geography source failure does not suppress peer health", async () => {
  const attempts: Record<string, unknown>[][] = [];
  const transport = {
    loadCheckpoint: async () => undefined,
    list: async (product: MarketGeographyProductId) => {
      if (product === "NP6-905-CD") throw new Error("market_geography_list_failed");
      return [];
    },
    saveHealth: async (items: Record<string, unknown>[]) => attempts.push(items),
  } as unknown as HttpPublicMarketGeographyTransport;
  let failed = false;
  try {
    await runPublicMarketGeographyCycle(transport, 1_787_071_530);
  } catch (error) {
    failed = error instanceof Error && error.message === "market_geography_list_failed";
  }
  equal(failed, true);
  equal(attempts[0]?.length, 3);
  equal(Object.fromEntries(attempts[0]!.map((item) => [item.source_id, item.success])), {
    ercot_mis_np6_788: true,
    ercot_mis_np6_905: false,
    ercot_mis_np6_86: true,
  });
});

Deno.test("expired older market document becomes one durable gap after newer success", async () => {
  const first: MisDocument = {
    docId: "100",
    publishDate: "2026-08-18T12:34:00-05:00",
    issuedAt: 1_787_074_440,
    constructedName: "expired.zip",
    contentSize: 100,
  };
  const second = {
    ...first,
    docId: "101",
    publishDate: "2026-08-18T12:35:00-05:00",
    issuedAt: first.issuedAt + 60,
  };
  const checkpoints = new Map<string, unknown>();
  const attempts: Record<string, unknown>[][] = [];
  let downloads = 0;
  const transport = {
    loadCheckpoint: async (sourceId: string) => checkpoints.get(sourceId),
    list: async (product: MarketGeographyProductId) =>
      product === "NP6-788-CD" ? [first, second] : [],
    download: async (document: MisDocument) => {
      downloads++;
      if (document.docId === "100") throw new Error("market_geography_download_failed");
      return storedZip(
        "SCEDTimestamp,RepeatedHourFlag,SettlementPoint,LMP\n08/18/2026 12:35:00,N,HB_HOUSTON,42\n",
      );
    },
    ingest: async () => undefined,
    saveHealth: async (items: Record<string, unknown>[]) => {
      attempts.push(items);
      for (const item of items)
        if (item.checkpoint) checkpoints.set(String(item.source_id), item.checkpoint);
    },
  } as unknown as HttpPublicMarketGeographyTransport;
  await runPublicMarketGeographyCycle(transport, 1_787_074_600);
  const health = attempts[0]!.find((item) => item.source_id === "ercot_mis_np6_788")!;
  equal((health.checkpoint as MarketGeographyCheckpoint).document_id, "101");
  equal((health.checkpoint as MarketGeographyCheckpoint).gap_count, 1);
  await runPublicMarketGeographyCycle(transport, 1_787_074_900);
  equal(downloads, 2);
});

Deno.test("newest transient market document retries and recovers without false gap", async () => {
  const document: MisDocument = {
    docId: "201",
    publishDate: "2026-08-18T12:35:00-05:00",
    issuedAt: 1_787_074_500,
    constructedName: "retry.zip",
    contentSize: 100,
  };
  const checkpoints = new Map<string, unknown>();
  const attempts: Record<string, unknown>[][] = [];
  let downloads = 0;
  const transport = {
    loadCheckpoint: async (sourceId: string) => checkpoints.get(sourceId),
    list: async (product: MarketGeographyProductId) => (product === "NP6-788-CD" ? [document] : []),
    download: async () => {
      downloads++;
      if (downloads === 1) throw new Error("market_geography_download_failed");
      return storedZip(
        "SCEDTimestamp,RepeatedHourFlag,SettlementPoint,LMP\n08/18/2026 12:35:00,N,HB_HOUSTON,42\n",
      );
    },
    ingest: async () => undefined,
    saveHealth: async (items: Record<string, unknown>[]) => {
      attempts.push(items);
      for (const item of items)
        if (item.checkpoint) checkpoints.set(String(item.source_id), item.checkpoint);
    },
  } as unknown as HttpPublicMarketGeographyTransport;
  let failed = false;
  try {
    await runPublicMarketGeographyCycle(transport, 1_787_074_600);
  } catch {
    failed = true;
  }
  equal(failed, true);
  await runPublicMarketGeographyCycle(transport, 1_787_074_900);
  const recovered = attempts[1]!.find((item) => item.source_id === "ercot_mis_np6_788")!;
  equal((recovered.checkpoint as MarketGeographyCheckpoint).gap_count, 0);
  equal(downloads, 2);
});
