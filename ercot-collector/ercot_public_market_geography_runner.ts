import { fixedInterval } from "./deps.ts";
import { extractSingleCsvZip, type MisDocument } from "./ercot_mis_renewable_publications.ts";
import {
  buildPublicMarketGeographyPublicationPayload,
  MARKET_GEOGRAPHY_PRODUCTS,
  parsePublicMarketGeographyCsv,
  type MarketGeographyProductId,
  type MarketGeographyPublicationPayload,
} from "./ercot_public_market_geography.ts";

const LIST_URL = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS";
const DOWNLOAD_URL = "https://www.ercot.com/misdownload/servlets/mirDownload";
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INGEST_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 5_000;
const MAX_DOCUMENTS_PER_CYCLE = 48;
const PRODUCTS = Object.keys(MARKET_GEOGRAPHY_PRODUCTS) as MarketGeographyProductId[];
type Json = Record<string, unknown>;

export type MarketGeographyCheckpoint = {
  version: 2;
  issued_at: number;
  document_id: string;
  gap_count: number;
  gap_digest: string | null;
};

const CONSTRUCTED: Record<MarketGeographyProductId, RegExp> = {
  "NP6-788-CD": /^cdr\.00012300\.0{16}\.\d{8}\.\d{9}\.LMPSROSNODENP6788_\d{8}_\d{6}_csv\.zip$/,
  "NP6-905-CD": /^cdr\.00012301\.0{16}\.\d{8}\.\d{9}\.SPPHLZNP6905_\d{8}_\d{4}_csv\.zip$/,
  "NP6-86-CD": /^cdr\.00012302\.0{16}\.\d{8}\.\d{9}\.SCEDBTCNP686_csv\.zip$/,
};

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedResponse(
  response: Response,
  maximum: number,
  code: string,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(code);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new Error(`${code}_size`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(code);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error(`${code}_size`);
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function boundedJson(response: Response, maximum: number, code: string): Promise<unknown> {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedResponse(response, maximum, code),
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(code)) throw error;
    throw new Error(`${code}_json`);
  }
}

function issueEpoch(value: unknown): number {
  if (typeof value !== "string" || value.length > 64)
    throw new Error("market_geography_publish_date");
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized))
    throw new Error("market_geography_publish_date");
  const epoch = Date.parse(normalized.replace(" ", "T")) / 1000;
  if (!Number.isInteger(epoch)) throw new Error("market_geography_publish_date");
  return epoch;
}

function collectDocuments(value: unknown, result: Json[], depth = 0): void {
  if (depth > 12) throw new Error("market_geography_list_depth");
  if (Array.isArray(value)) {
    for (const child of value) collectDocuments(child, result, depth + 1);
  } else if (object(value)) {
    if ("DocID" in value) {
      result.push(value);
      if (result.length > MAX_CANDIDATES) throw new Error("market_geography_list_count");
    } else for (const child of Object.values(value)) collectDocuments(child, result, depth + 1);
  }
}

function compareDocument(left: MisDocument, right: MisDocument): number {
  return (
    left.issuedAt - right.issuedAt ||
    left.docId.length - right.docId.length ||
    left.docId.localeCompare(right.docId)
  );
}

async function gapDigest(values: string[]): Promise<string | undefined> {
  if (!values.length) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([...values].sort().join(",")),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function parsePublicMarketGeographyDocumentList(
  value: unknown,
  product: MarketGeographyProductId,
): MisDocument[] {
  const entries: Json[] = [];
  collectDocuments(value, entries);
  const expectedReport = MARKET_GEOGRAPHY_PRODUCTS[product].reportTypeId;
  const seen = new Set<string>();
  const documents: MisDocument[] = [];
  for (const entry of entries) {
    if (String(entry.ReportTypeID) !== String(expectedReport))
      throw new Error("market_geography_report_type");
    if (entry.SecurityStatus !== "P" || String(entry.Extension).toLowerCase() !== "zip") continue;
    if (typeof entry.FriendlyName !== "string" || !/_csv(?:\.zip)?$/i.test(entry.FriendlyName))
      continue;
    const documentId = String(entry.DocID);
    if (!/^\d{1,20}$/.test(documentId) || seen.has(documentId))
      throw new Error("market_geography_document_id");
    const constructedName = entry.ConstructedName;
    if (typeof constructedName !== "string" || !CONSTRUCTED[product].test(constructedName))
      throw new Error("market_geography_constructed_name");
    const contentSize = Number(entry.ContentSize);
    if (!Number.isInteger(contentSize) || contentSize <= 0 || contentSize > MAX_DOWNLOAD_BYTES)
      throw new Error("market_geography_document_size");
    seen.add(documentId);
    documents.push({
      docId: documentId,
      publishDate: String(entry.PublishDate),
      issuedAt: issueEpoch(entry.PublishDate),
      constructedName,
      contentSize,
    });
  }
  return documents.sort(compareDocument);
}

function isAfter(document: MisDocument, checkpoint: MarketGeographyCheckpoint): boolean {
  return (
    document.issuedAt > checkpoint.issued_at ||
    (document.issuedAt === checkpoint.issued_at &&
      (document.docId.length > checkpoint.document_id.length ||
        (document.docId.length === checkpoint.document_id.length &&
          document.docId > checkpoint.document_id)))
  );
}

export function selectPublicMarketGeographyDocuments(
  documents: MisDocument[],
  prior?: MarketGeographyCheckpoint,
): MisDocument[] {
  const ordered = [...documents].sort(compareDocument);
  if (!prior) return ordered.slice(-MAX_DOCUMENTS_PER_CYCLE);
  return ordered.filter((document) => isAfter(document, prior)).slice(0, MAX_DOCUMENTS_PER_CYCLE);
}

function parseCheckpoint(value: unknown): MarketGeographyCheckpoint | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !object(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["document_id", "gap_count", "gap_digest", "issued_at", "version"]) ||
    value.version !== 2 ||
    !Number.isInteger(value.issued_at) ||
    Number(value.issued_at) <= 0 ||
    typeof value.document_id !== "string" ||
    !/^\d{1,20}$/.test(value.document_id) ||
    !Number.isInteger(value.gap_count) ||
    Number(value.gap_count) < 0 ||
    Number(value.gap_count) > 10_000 ||
    (Number(value.gap_count) === 0
      ? value.gap_digest !== null
      : typeof value.gap_digest !== "string" || !/^[0-9a-f]{64}$/.test(value.gap_digest))
  )
    throw new Error("market_geography_checkpoint");
  return {
    version: 2,
    issued_at: Number(value.issued_at),
    document_id: value.document_id,
    gap_count: Number(value.gap_count),
    gap_digest: value.gap_digest as string | null,
  };
}

export class HttpPublicMarketGeographyTransport {
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
      url.pathname !== "/api/market-geography-publications/ingest" ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !local.has(url.hostname))
    )
      throw new Error("market_geography_receiver_config");
    this.endpoint = url;
  }

  async request(url: URL, init: RequestInit, maximum: number, code: string): Promise<unknown> {
    return await boundedJson(
      await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      maximum,
      code,
    );
  }

  async list(product: MarketGeographyProductId): Promise<MisDocument[]> {
    const url = new URL(LIST_URL);
    url.searchParams.set("reportTypeId", String(MARKET_GEOGRAPHY_PRODUCTS[product].reportTypeId));
    return parsePublicMarketGeographyDocumentList(
      await this.request(
        url,
        { headers: { Accept: "application/json" } },
        MAX_LIST_BYTES,
        "market_geography_list_failed",
      ),
      product,
    );
  }

  async download(document: MisDocument): Promise<Uint8Array> {
    const url = new URL(DOWNLOAD_URL);
    url.searchParams.set("doclookupId", document.docId);
    return await boundedResponse(
      await this.fetchImpl(url, {
        headers: { Accept: "application/zip" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      MAX_DOWNLOAD_BYTES,
      "market_geography_download_failed",
    );
  }

  async ingest(payload: MarketGeographyPublicationPayload): Promise<void> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_INGEST_BYTES)
      throw new Error("market_geography_ingest_size");
    const result = await this.request(
      this.endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body,
      },
      MAX_RESPONSE_BYTES,
      "market_geography_ingest_failed",
    );
    if (
      !object(result) ||
      !["inserted", "unchanged"].includes(String(result.status)) ||
      typeof result.publication_key !== "string" ||
      result.row_count !== payload.rows.length
    )
      throw new Error("market_geography_receiver_response");
  }

  async loadCheckpoint(sourceId: string): Promise<MarketGeographyCheckpoint | undefined> {
    const url = new URL(this.endpoint);
    url.pathname = "/api/source-checkpoint";
    url.searchParams.set("source_id", sourceId);
    const result = await this.request(
      url,
      { headers: { "X-API-Key": this.apiKey } },
      MAX_RESPONSE_BYTES,
      "market_geography_checkpoint_failed",
    );
    if (!object(result)) throw new Error("market_geography_checkpoint");
    return parseCheckpoint(result.checkpoint);
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
      MAX_RESPONSE_BYTES,
      "market_geography_health_failed",
    );
    if (!object(result) || !Number.isInteger(result.updated))
      throw new Error("market_geography_receiver_response");
  }
}

export async function runPublicMarketGeographyCycle(
  transport: HttpPublicMarketGeographyTransport,
  now: number,
): Promise<void> {
  const attempts: Json[] = [];
  const failures: string[] = [];
  for (const product of PRODUCTS) {
    const config = MARKET_GEOGRAPHY_PRODUCTS[product];
    try {
      const prior = await transport.loadCheckpoint(config.sourceId);
      const listed = await transport.list(product);
      const selected = selectPublicMarketGeographyDocuments(listed, prior);
      let current = prior;
      let rowCount = 0;
      let newestTarget: number | undefined;
      const failedDocuments: MisDocument[] = [];
      for (const document of selected) {
        try {
          const rows = parsePublicMarketGeographyCsv(
            product,
            await extractSingleCsvZip(await transport.download(document)),
          );
          await transport.ingest(
            buildPublicMarketGeographyPublicationPayload(product, document, rows, now),
          );
          rowCount += rows.length;
          newestTarget = Math.max(newestTarget ?? 0, ...rows.map((row) => row.target_ts));
          current = {
            version: 2,
            issued_at: document.issuedAt,
            document_id: document.docId,
            gap_count: current?.gap_count ?? 0,
            gap_digest: current?.gap_digest ?? null,
          };
        } catch {
          failedDocuments.push(document);
        }
      }
      const advanced = current;
      const permanentGaps = advanced
        ? failedDocuments.filter((document) => !isAfter(document, advanced))
        : [];
      if (failedDocuments.length !== permanentGaps.length)
        throw new Error("market_geography_document_failed");
      const digest = permanentGaps.length
        ? await gapDigest([
            ...(prior?.gap_digest ? [prior.gap_digest] : []),
            ...permanentGaps.map((document) => document.docId),
          ])
        : prior?.gap_digest;
      const gapCount = (prior?.gap_count ?? 0) + permanentGaps.length;
      if (current) current = { ...current, gap_count: gapCount, gap_digest: digest ?? null };
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${product} market geography`,
        expected_interval_seconds: product === "NP6-905-CD" ? 900 : 300,
        publication_mode: "event",
        publication_interval_seconds: product === "NP6-905-CD" ? 900 : 300,
        attempted_at: now,
        success: true,
        row_count: rowCount,
        availability_status: current ? "available" : "empty",
        checkpoint: current,
        ...(current ? { source_timestamp_ts: current.issued_at } : {}),
        ...(newestTarget ? { data_timestamp_ts: newestTarget } : {}),
        diagnostics: {
          bootstrap_truncated: prior === undefined && listed.length > MAX_DOCUMENTS_PER_CYCLE,
          backlog_count: prior
            ? Math.max(
                0,
                listed.filter((document) => isAfter(document, prior)).length - selected.length,
              )
            : Math.max(0, listed.length - selected.length),
          newest_target_ts: newestTarget ?? null,
          gap_count: gapCount,
          ...(digest ? { gap_document_ids_sha256: digest } : {}),
        },
        provenance: { product_id: product, report_type_id: config.reportTypeId },
      });
    } catch (error) {
      const code =
        error instanceof Error && /^market_geography_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "market_geography_cycle_failed";
      failures.push(code);
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${product} market geography`,
        expected_interval_seconds: product === "NP6-905-CD" ? 900 : 300,
        publication_mode: "event",
        publication_interval_seconds: product === "NP6-905-CD" ? 900 : 300,
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

export function publicMarketGeographyRuntimeConfig(environment: {
  get(name: string): string | undefined;
}) {
  if (environment.get("ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED") !== "true")
    return { enabled: false as const };
  const endpoint = environment.get("ERCOT_MARKET_GEOGRAPHY_ENDPOINT");
  const apiKey = environment.get("METRICS_API_KEY");
  if (!endpoint || !apiKey) throw new Error("market_geography_runtime_config");
  return { enabled: true as const, endpoint, apiKey };
}

export async function startPublicMarketGeography(): Promise<never> {
  const runtime = publicMarketGeographyRuntimeConfig(Deno.env);
  if (!runtime.enabled) return await new Promise(() => undefined);
  const transport = new HttpPublicMarketGeographyTransport(runtime.endpoint, runtime.apiKey);
  for await (const _cycle of fixedInterval(300_000)) {
    try {
      await runPublicMarketGeographyCycle(transport, Math.floor(Date.now() / 1000));
    } catch {
      // Per-product failure health is persisted; keep the long-running collector alive.
    }
  }
  return await new Promise(() => undefined);
}

if (import.meta.main) await startPublicMarketGeography();
