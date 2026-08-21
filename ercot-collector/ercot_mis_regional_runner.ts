import { fixedInterval } from "./deps.ts";
import {
  extractSingleCsvZip,
  parseMisDocumentList,
  type MisDocument,
} from "./ercot_mis_renewable_publications.ts";
import {
  buildRegionalRenewablePublicationPayload,
  parseRegionalRenewableCsv,
  REGIONAL_RENEWABLE_PRODUCTS,
  type RegionalRenewableProductId,
  type RegionalRenewablePublicationPayload,
} from "./ercot_mis_regional_renewables.ts";

const LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS";
const DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload";
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INGEST_BYTES = 1024 * 1024;
type Json = Record<string, unknown>;
export type RegionalCheckpoint = { version: 1; issued_at: number; doc_id: string };

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

function checkpoint(value: unknown): RegionalCheckpoint | undefined {
  if (value === null || value === undefined) return undefined;
  if (
    !object(value) ||
    value.version !== 1 ||
    !Number.isInteger(value.issued_at) ||
    Number(value.issued_at) <= 0 ||
    typeof value.doc_id !== "string" ||
    !/^\d{1,20}$/.test(value.doc_id)
  )
    throw new Error("ercot_mis_regional_checkpoint_invalid");
  return { version: 1, issued_at: Number(value.issued_at), doc_id: value.doc_id };
}

function after(document: MisDocument, prior?: RegionalCheckpoint): boolean {
  if (!prior) return true;
  return (
    document.issuedAt > prior.issued_at ||
    (document.issuedAt === prior.issued_at &&
      (document.docId.length > prior.doc_id.length ||
        (document.docId.length === prior.doc_id.length && document.docId > prior.doc_id)))
  );
}

function compareDocument(left: MisDocument, right: MisDocument): number {
  return (
    left.issuedAt - right.issuedAt ||
    left.docId.length - right.docId.length ||
    left.docId.localeCompare(right.docId)
  );
}

export function selectRegionalDocuments(
  documents: MisDocument[],
  prior?: RegionalCheckpoint,
): MisDocument[] {
  const listed = documents.filter((document) => {
    if (!/^\d{1,20}$/.test(document.docId))
      throw new Error("ercot_mis_regional_document_id_invalid");
    return true;
  });
  listed.sort(compareDocument);
  const newer = listed.filter((document) => after(document, prior));
  const selected = prior ? newer.slice(0, 48) : newer.slice(-48);
  if (prior) {
    const overlap = listed.find(
      (document) => document.issuedAt === prior.issued_at && document.docId === prior.doc_id,
    );
    if (overlap) selected.unshift(overlap);
  }
  return selected;
}

export class HttpRegionalRenewableTransport {
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
      url.pathname !== "/api/regional-renewable-publications/ingest" ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !local.has(url.hostname))
    )
      throw new Error("ercot_mis_regional_receiver_config_invalid");
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
  async list(productId: RegionalRenewableProductId): Promise<MisDocument[]> {
    const config = REGIONAL_RENEWABLE_PRODUCTS[productId];
    const url = new URL(LIST);
    url.searchParams.set("reportTypeId", String(config.reportTypeId));
    return parseMisDocumentList(
      await this.request(
        url,
        { headers: { Accept: "application/json" } },
        MAX_LIST_BYTES,
        "ercot_mis_regional_list_failed",
      ),
      config.reportTypeId,
    );
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
      "ercot_mis_regional_download_failed",
    );
  }
  async ingest(payload: RegionalRenewablePublicationPayload): Promise<void> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_INGEST_BYTES)
      throw new Error("ercot_mis_regional_ingest_size");
    const result = await this.request(
      this.endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
        body,
      },
      64 * 1024,
      "ercot_mis_regional_ingest_failed",
    );
    if (
      !object(result) ||
      !["inserted", "unchanged"].includes(String(result.status)) ||
      typeof result.vintage_key !== "string" ||
      !/^rgv1-[0-9a-f]{64}$/.test(result.vintage_key) ||
      result.row_count !== payload.rows.length
    )
      throw new Error("ercot_mis_regional_receiver_response_invalid");
  }
  async loadCheckpoint(sourceId: string): Promise<RegionalCheckpoint | undefined> {
    const url = new URL(this.endpoint);
    url.pathname = "/api/source-checkpoint";
    url.searchParams.set("source_id", sourceId);
    const result = await this.request(
      url,
      { headers: { "X-API-Key": this.apiKey } },
      64 * 1024,
      "ercot_mis_regional_checkpoint_failed",
    );
    if (!object(result)) throw new Error("ercot_mis_regional_checkpoint_invalid");
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
      "ercot_mis_regional_health_failed",
    );
    if (!object(result) || !Number.isInteger(result.updated))
      throw new Error("ercot_mis_regional_receiver_response_invalid");
  }
}

export async function runRegionalRenewableCycle(
  transport: HttpRegionalRenewableTransport,
  now: number,
): Promise<void> {
  const attempts: Json[] = [];
  const failures: string[] = [];
  for (const productId of ["NP4-742-CD", "NP4-745-CD"] as const) {
    const config = REGIONAL_RENEWABLE_PRODUCTS[productId];
    try {
      const prior = await transport.loadCheckpoint(config.sourceId);
      const listed = await transport.list(productId);
      const documents = selectRegionalDocuments(listed, prior);
      let rows = 0;
      let newest = prior;
      for (const document of documents) {
        const parsed = parseRegionalRenewableCsv(
          productId,
          await extractSingleCsvZip(await transport.download(document)),
        );
        await transport.ingest(
          await buildRegionalRenewablePublicationPayload(productId, document, parsed, now),
        );
        rows += parsed.length;
        newest = { version: 1, issued_at: document.issuedAt, doc_id: document.docId };
      }
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${productId} hourly regional renewable publication`,
        expected_interval_seconds: 3600,
        publication_mode: "event",
        publication_interval_seconds: 3600,
        attempted_at: now,
        success: true,
        row_count: rows,
        availability_status: newest ? "available" : "empty",
        checkpoint: newest,
        ...(newest
          ? { source_timestamp_ts: newest.issued_at, data_timestamp_ts: newest.issued_at }
          : {}),
        diagnostics: {
          bootstrap_truncated: prior === undefined && listed.length > 48,
          backlog_count:
            prior === undefined
              ? 0
              : Math.max(0, listed.filter((item) => after(item, prior)).length - 48),
        },
        provenance: { product_id: productId, report_type_id: config.reportTypeId },
      });
    } catch (error) {
      const code =
        error instanceof Error && /^ercot_mis_[a-z0-9_]+$/.test(error.message)
          ? error.message
          : "ercot_mis_regional_cycle_failed";
      failures.push(code);
      attempts.push({
        source_id: config.sourceId,
        display_name: `ERCOT MIS ${productId} hourly regional renewable publication`,
        expected_interval_seconds: 3600,
        publication_mode: "event",
        publication_interval_seconds: 3600,
        attempted_at: now,
        success: false,
        row_count: 0,
        error: code,
        provenance: { product_id: productId, report_type_id: config.reportTypeId },
      });
    }
  }
  await transport.saveHealth(attempts);
  if (failures.length) throw new Error(failures[0]);
}

export function regionalRenewableRuntimeConfig(environment: {
  get(name: string): string | undefined;
}) {
  if (environment.get("ERCOT_REGIONAL_RENEWABLE_INGEST_ENABLED") !== "true")
    return { enabled: false as const };
  const endpoint = environment.get("ERCOT_REGIONAL_RENEWABLE_ENDPOINT");
  const apiKey = environment.get("METRICS_API_KEY");
  if (!endpoint || !apiKey) throw new Error("ercot_mis_regional_runtime_config_missing");
  return { enabled: true as const, endpoint, apiKey };
}

export async function startMisRegionalRenewablePublications(): Promise<never> {
  const runtime = regionalRenewableRuntimeConfig(Deno.env);
  if (!runtime.enabled) return await new Promise(() => undefined);
  const transport = new HttpRegionalRenewableTransport(runtime.endpoint, runtime.apiKey);
  for await (const _cycle of fixedInterval(3_600_000)) {
    try {
      await runRegionalRenewableCycle(transport, Math.floor(Date.now() / 1000));
    } catch {
      // Health was already persisted; the long-running loop remains available.
    }
  }
  return await new Promise(() => undefined);
}

if (import.meta.main) await startMisRegionalRenewablePublications();
