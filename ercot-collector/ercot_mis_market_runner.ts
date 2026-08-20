import { fixedInterval } from "./deps.ts";
import { extractSingleCsvZip, type MisDocument } from "./ercot_mis_renewable_publications.ts";
import {
  buildMarketMechanicsPublicationPayload,
  MARKET_PRODUCTS,
  parseMarketMechanicsCsv,
  type MarketMechanicsPublicationPayload,
  type MarketProductId,
} from "./ercot_mis_market_mechanics.ts";

const LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS";
const DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload";
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INGEST_BYTES = 1024 * 1024;
const PRODUCTS = Object.keys(MARKET_PRODUCTS) as MarketProductId[];
const MAX_LIST_CANDIDATES = 5_000;
type Json = Record<string, unknown>;
export type MarketCheckpoint = {
  version: 2;
  issued_at: number;
  doc_id: string;
  gap_count: number;
  gap_digest: string | null;
};

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function bounded(response: Response, maximum: number, code: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(code);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new Error(`${code}_size`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(code);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error(`${code}_size`);
    }
    chunks.push(part.value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function json(response: Response, maximum: number, code: string): Promise<unknown> {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await bounded(response, maximum, code)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(code)) throw error;
    throw new Error(`${code}_json`);
  }
}

function checkpoint(value: unknown): MarketCheckpoint | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !object(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["doc_id", "gap_count", "gap_digest", "issued_at", "version"]) ||
    value.version !== 2 ||
    !Number.isInteger(value.issued_at) ||
    Number(value.issued_at) <= 0 ||
    typeof value.doc_id !== "string" ||
    !/^\d{1,20}$/.test(value.doc_id) ||
    !Number.isInteger(value.gap_count) ||
    Number(value.gap_count) < 0 ||
    Number(value.gap_count) > 10_000 ||
    (Number(value.gap_count) === 0
      ? value.gap_digest !== null
      : typeof value.gap_digest !== "string" || !/^[0-9a-f]{64}$/.test(value.gap_digest))
  ) {
    throw new Error("ercot_mis_market_checkpoint_invalid");
  }
  return {
    version: 2,
    issued_at: Number(value.issued_at),
    doc_id: value.doc_id,
    gap_count: Number(value.gap_count),
    gap_digest: value.gap_digest as string | null,
  };
}

async function gapDigest(docIds: string[]): Promise<string | undefined> {
  if (!docIds.length) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([...docIds].sort().join(",")),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function compare(left: MisDocument, right: MisDocument): number {
  return (
    left.issuedAt - right.issuedAt ||
    left.docId.length - right.docId.length ||
    left.docId.localeCompare(right.docId)
  );
}

function documentObjects(value: unknown, output: Json[], depth = 0): void {
  if (depth > 12) throw new Error("ercot_mis_market_list_depth");
  if (Array.isArray(value)) {
    for (const child of value) documentObjects(child, output, depth + 1);
  } else if (object(value)) {
    if ("DocID" in value) {
      output.push(value);
      if (output.length > MAX_LIST_CANDIDATES) throw new Error("ercot_mis_market_document_limit");
    } else for (const child of Object.values(value)) documentObjects(child, output, depth + 1);
  }
}

function issueEpoch(raw: unknown): number {
  if (typeof raw !== "string" || raw.length > 64)
    throw new Error("ercot_mis_market_publish_date_invalid");
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized))
    throw new Error("ercot_mis_market_publish_date_invalid");
  const result = Date.parse(normalized.replace(" ", "T")) / 1000;
  if (!Number.isInteger(result)) throw new Error("ercot_mis_market_publish_date_invalid");
  return result;
}

const CONSTRUCTED = {
  "NP6-322-CD": /^cdr\.00013114\.0{16}\.\d{8}\.\d{9}\.SCEDSYSLAMBDANP6322_[A-Za-z0-9_-]+_csv\.zip$/,
  "NP6-323-CD":
    /^cdr\.00013221\.0{16}\.\d{8}\.\d{9}\.RTSCEDpriceAdderNP6323_[A-Za-z0-9_-]+_csv\.zip$/,
  "NP6-328-CD":
    /^cdr\.00024887\.0{16}\.\d{8}\.\d{9}\.TotASResCapabilityNP6328_[A-Za-z0-9_-]+_csv\.zip$/,
  "NP6-332-CD": /^cdr\.00024891\.0{16}\.\d{8}\.\d{9}\.SCEDMCPCNP6332_csv\.zip$/,
} as const;

export function parseMarketDocumentList(value: unknown, product: MarketProductId): MisDocument[] {
  const candidates: Json[] = [];
  documentObjects(value, candidates);
  const report = MARKET_PRODUCTS[product].reportTypeId;
  const documents: MisDocument[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    if (String(entry.ReportTypeID) !== report)
      throw new Error("ercot_mis_market_report_type_mismatch");
    if (entry.SecurityStatus !== "P" || String(entry.Extension).toLowerCase() !== "zip") continue;
    if (typeof entry.FriendlyName !== "string" || !/_csv(?:\.zip)?$/i.test(entry.FriendlyName))
      continue;
    const docId = String(entry.DocID);
    if (!/^\d{1,20}$/.test(docId) || seen.has(docId))
      throw new Error("ercot_mis_market_document_id_invalid");
    const constructedName = entry.ConstructedName;
    if (typeof constructedName !== "string" || !CONSTRUCTED[product].test(constructedName))
      throw new Error("ercot_mis_market_constructed_name_invalid");
    const contentSize = Number(entry.ContentSize);
    if (!Number.isInteger(contentSize) || contentSize <= 0 || contentSize > MAX_DOWNLOAD_BYTES)
      throw new Error("ercot_mis_market_document_size_invalid");
    seen.add(docId);
    documents.push({
      docId,
      publishDate: String(entry.PublishDate),
      issuedAt: issueEpoch(entry.PublishDate),
      constructedName,
      contentSize,
    });
  }
  return documents.sort(compare);
}

function after(document: MisDocument, prior: MarketCheckpoint): boolean {
  return (
    document.issuedAt > prior.issued_at ||
    (document.issuedAt === prior.issued_at &&
      (document.docId.length > prior.doc_id.length ||
        (document.docId.length === prior.doc_id.length && document.docId > prior.doc_id)))
  );
}

export function selectMarketDocuments(
  documents: MisDocument[],
  prior?: MarketCheckpoint,
): MisDocument[] {
  for (const document of documents)
    if (!/^\d{1,20}$/.test(document.docId)) throw new Error("ercot_mis_market_document_id_invalid");
  const ordered = [...documents].sort(compare);
  if (!prior) return ordered.slice(-48);
  return ordered.filter((document) => after(document, prior)).slice(0, 48);
}

export class HttpMarketMechanicsTransport {
  readonly endpoint: URL;
  constructor(
    endpoint: string,
    readonly apiKey: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    const local = new Set(["receiver", "localhost", "127.0.0.1", "[::1]"]);
    if (
      !apiKey ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/market-mechanics-publications/ingest" ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !local.has(url.hostname))
    ) {
      throw new Error("ercot_mis_market_receiver_config_invalid");
    }
    this.endpoint = url;
  }
  async request(url: URL, init: RequestInit, maximum: number, code: string): Promise<unknown> {
    return await json(
      await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      maximum,
      code,
    );
  }
  async list(product: MarketProductId): Promise<MisDocument[]> {
    const url = new URL(LIST);
    url.searchParams.set("reportTypeId", MARKET_PRODUCTS[product].reportTypeId);
    const value = await this.request(
      url,
      { headers: { Accept: "application/json" } },
      MAX_LIST_BYTES,
      "ercot_mis_market_list_failed",
    );
    return parseMarketDocumentList(value, product);
  }
  async download(document: MisDocument): Promise<Uint8Array> {
    const url = new URL(DOWNLOAD);
    url.searchParams.set("doclookupId", document.docId);
    return await bounded(
      await this.fetchImpl(url, {
        headers: { Accept: "application/zip" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      MAX_DOWNLOAD_BYTES,
      "ercot_mis_market_download_failed",
    );
  }
  async ingest(payload: MarketMechanicsPublicationPayload): Promise<void> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_INGEST_BYTES)
      throw new Error("ercot_mis_market_ingest_size");
    const result = await this.request(
      this.endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body,
      },
      64 * 1024,
      "ercot_mis_market_ingest_failed",
    );
    if (
      !object(result) ||
      !["inserted", "unchanged"].includes(String(result.status)) ||
      typeof result.vintage_key !== "string" ||
      !/^mm1-[0-9a-f]{64}$/.test(result.vintage_key) ||
      result.row_count !== payload.rows.length
    )
      throw new Error("ercot_mis_market_receiver_response_invalid");
  }
  async loadCheckpoint(sourceId: string): Promise<MarketCheckpoint | undefined> {
    const url = new URL(this.endpoint);
    url.pathname = "/api/source-checkpoint";
    url.searchParams.set("source_id", sourceId);
    const result = await this.request(
      url,
      { headers: { "X-API-Key": this.apiKey } },
      64 * 1024,
      "ercot_mis_market_checkpoint_failed",
    );
    if (!object(result)) throw new Error("ercot_mis_market_checkpoint_invalid");
    return checkpoint(result.checkpoint);
  }
  async saveHealth(attempts: Json[]): Promise<void> {
    const url = new URL(this.endpoint);
    url.pathname = "/api/source-health";
    const result = await this.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body: JSON.stringify(attempts),
      },
      64 * 1024,
      "ercot_mis_market_health_failed",
    );
    if (!object(result) || !Number.isInteger(result.updated))
      throw new Error("ercot_mis_market_receiver_response_invalid");
  }
}

export async function runMarketMechanicsCycle(
  transport: HttpMarketMechanicsTransport,
  now: number,
): Promise<void> {
  const attempts: Json[] = [];
  const failures: string[] = [];
  for (const product of PRODUCTS) {
    const config = MARKET_PRODUCTS[product];
    try {
      const prior = await transport.loadCheckpoint(config.sourceId);
      const listed = await transport.list(product);
      const selected = selectMarketDocuments(listed, prior);
      let newest = prior;
      let newestTarget: number | undefined;
      let rows = 0;
      const gaps: MisDocument[] = [];
      for (const document of selected) {
        try {
          const parsed = parseMarketMechanicsCsv(
            product,
            await extractSingleCsvZip(await transport.download(document)),
          );
          await transport.ingest(
            buildMarketMechanicsPublicationPayload(product, document, parsed, now),
          );
          rows += parsed.length;
          newestTarget = Math.max(newestTarget ?? 0, ...parsed.map((row) => row.target_ts));
          if (!newest || after(document, newest))
            newest = {
              version: 2,
              issued_at: document.issuedAt,
              doc_id: document.docId,
              gap_count: newest?.gap_count ?? 0,
              gap_digest: newest?.gap_digest ?? null,
            };
        } catch {
          gaps.push(document);
        }
      }
      const advanced = newest;
      const permanentGaps = advanced ? gaps.filter((document) => !after(document, advanced)) : [];
      if (gaps.length !== permanentGaps.length) throw new Error("ercot_mis_market_document_failed");
      const gapHash = permanentGaps.length
        ? await gapDigest([
            ...(prior?.gap_digest ? [prior.gap_digest] : []),
            ...permanentGaps.map((document) => document.docId),
          ])
        : prior?.gap_digest;
      const gapCount = (prior?.gap_count ?? 0) + permanentGaps.length;
      if (newest) newest = { ...newest, gap_count: gapCount, gap_digest: gapHash ?? null };
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${product} market mechanics`,
        expected_interval_seconds: 300,
        publication_mode: "event",
        publication_interval_seconds: 300,
        attempted_at: now,
        success: true,
        row_count: rows,
        availability_status: newest ? "available" : "empty",
        checkpoint: newest,
        ...(newest ? { source_timestamp_ts: newest.issued_at } : {}),
        ...(newestTarget ? { data_timestamp_ts: newestTarget } : {}),
        diagnostics: {
          bootstrap_truncated: prior === undefined && listed.length > 48,
          backlog_count: prior
            ? Math.max(0, listed.filter((item) => after(item, prior)).length - 48)
            : 0,
          gap_count: gapCount,
          ...(gapHash ? { gap_document_ids_sha256: gapHash } : {}),
          ...(newestTarget ? { newest_target_ts: newestTarget } : {}),
        },
        provenance: { product_id: product, report_type_id: config.reportTypeId },
      });
    } catch (error) {
      const code =
        error instanceof Error && /^ercot_mis_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "ercot_mis_market_cycle_failed";
      failures.push(code);
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${product} market mechanics`,
        expected_interval_seconds: 300,
        publication_mode: "event",
        publication_interval_seconds: 300,
        attempted_at: now,
        success: false,
        row_count: 0,
        error: code,
        provenance: { product_id: product, report_type_id: config.reportTypeId },
      });
    }
  }
  await transport.saveHealth(attempts);
  if (failures.length) throw new Error(failures[0]);
}

export function marketMechanicsRuntimeConfig(environment: {
  get(name: string): string | undefined;
}) {
  if (environment.get("ERCOT_MARKET_MECHANICS_INGEST_ENABLED") !== "true")
    return { enabled: false as const };
  const endpoint = environment.get("ERCOT_MARKET_MECHANICS_ENDPOINT");
  const apiKey = environment.get("METRICS_API_KEY");
  if (!endpoint || !apiKey) throw new Error("ercot_mis_market_runtime_config_missing");
  return { enabled: true as const, endpoint, apiKey };
}

export async function startMisMarketMechanics(): Promise<never> {
  const runtime = marketMechanicsRuntimeConfig(Deno.env);
  if (!runtime.enabled) return await new Promise(() => undefined);
  const transport = new HttpMarketMechanicsTransport(runtime.endpoint, runtime.apiKey);
  for await (const _cycle of fixedInterval(300_000)) {
    try {
      await runMarketMechanicsCycle(transport, Math.floor(Date.now() / 1000));
    } catch {
      // Per-product failure health is already persisted; keep the runner alive.
    }
  }
  return await new Promise(() => undefined);
}

if (import.meta.main) await startMisMarketMechanics();
