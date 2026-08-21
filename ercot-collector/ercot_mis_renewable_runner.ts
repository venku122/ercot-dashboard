import { fixedInterval } from "./deps.ts";
import {
  collectRenewablePublications,
  type MisDocument,
  type RenewableCollectorCheckpoint,
  type RenewableCollectorTransport,
  type RenewableProductCycleResult,
  type RenewableProductId,
  type RenewablePublicationPayload,
} from "./ercot_mis_renewable_publications.ts";

const LIST_ORIGIN = "https://www.ercot.com";
const LIST_PATH = "/misapp/servlets/IceDocListJsonWS";
const DOWNLOAD_PATH = "/misdownload/servlets/mirDownload";
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INGEST_BYTES = 512 * 1024;
const PRODUCT_SOURCES = Object.freeze({
  "NP4-732-CD": { sourceId: "ercot_mis_np4_732", reportTypeId: 13028 },
  "NP4-737-CD": { sourceId: "ercot_mis_np4_737", reportTypeId: 13483 },
});

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericDocId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,64}$/.test(value);
}

function parseCheckpoint(value: unknown): RenewableCollectorCheckpoint | undefined {
  if (value === null || value === undefined) return undefined;
  if (!object(value) || value.version !== 1 || !object(value.highWater)) {
    throw new Error("ercot_mis_checkpoint_response_invalid");
  }
  const allowed = new Set(["NP4-732-CD", "NP4-737-CD"]);
  const highWater: NonNullable<RenewableCollectorCheckpoint["highWater"]> = {};
  for (const [productId, entry] of Object.entries(value.highWater)) {
    if (!allowed.has(productId) || !object(entry)) {
      throw new Error("ercot_mis_checkpoint_response_invalid");
    }
    if (
      !Number.isInteger(entry.issuedAt) ||
      Number(entry.issuedAt) <= 0 ||
      Number(entry.issuedAt) > 4_102_444_800 ||
      !numericDocId(entry.docId)
    ) {
      throw new Error("ercot_mis_checkpoint_response_invalid");
    }
    highWater[productId as keyof typeof highWater] = {
      issuedAt: Number(entry.issuedAt),
      docId: entry.docId,
    };
  }
  if (
    Object.keys(highWater).length > 2 ||
    !Array.isArray(value.overlapDocIds) ||
    value.overlapDocIds.length > 96
  ) {
    throw new Error("ercot_mis_checkpoint_response_invalid");
  }
  const overlapDocIds: string[] = [];
  const seen = new Set<string>();
  for (const docId of value.overlapDocIds) {
    if (!numericDocId(docId) || seen.has(docId)) {
      throw new Error("ercot_mis_checkpoint_response_invalid");
    }
    seen.add(docId);
    overlapDocIds.push(docId);
  }
  return { highWater, overlapDocIds };
}

function checkpointSignature(checkpoint: RenewableCollectorCheckpoint): string {
  return JSON.stringify({
    highWater: Object.fromEntries(
      (["NP4-732-CD", "NP4-737-CD"] as const).flatMap((productId) => {
        const value = checkpoint.highWater?.[productId];
        return value ? [[productId, value]] : [];
      }),
    ),
    overlapDocIds: checkpoint.overlapDocIds ?? [],
  });
}

async function boundedBytes(
  response: Response,
  maximum: number,
  error: string,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(error);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new Error(`${error}_size`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(error);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error(`${error}_size`);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function jsonResponse(response: Response, maximum: number, error: string): Promise<unknown> {
  const bytes = await boundedBytes(response, maximum, error);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${error}_json`);
  }
}

export class HttpMisRenewableTransport implements RenewableCollectorTransport {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(
    endpoint: string,
    apiKey: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const url = new URL(endpoint);
    const localHttpHosts = new Set(["receiver", "localhost", "127.0.0.1", "[::1]"]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !localHttpHosts.has(url.hostname)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/renewable-publications/ingest" ||
      !apiKey
    ) {
      throw new Error("ercot_mis_receiver_config_invalid");
    }
    this.#endpoint = url;
    this.#fetch = fetchImpl;
    this.#headers = Object.freeze({ "Content-Type": "application/json", "X-API-Key": apiKey });
  }

  async #request(url: URL, init: RequestInit, maximum = MAX_LIST_BYTES): Promise<unknown> {
    const response = await this.#fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    return await jsonResponse(response, maximum, "ercot_mis_http_failed");
  }

  async list(reportTypeId: number): Promise<unknown> {
    if (![13028, 13483].includes(reportTypeId)) throw new Error("ercot_mis_report_type_invalid");
    const url = new URL(LIST_PATH, LIST_ORIGIN);
    url.searchParams.set("reportTypeId", String(reportTypeId));
    return await this.#request(url, { headers: { Accept: "application/json" } });
  }

  async download(document: MisDocument): Promise<Uint8Array> {
    const url = new URL(DOWNLOAD_PATH, LIST_ORIGIN);
    url.searchParams.set("doclookupId", document.docId);
    const response = await this.#fetch(url, {
      headers: { Accept: "application/zip" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    return await boundedBytes(response, MAX_DOWNLOAD_BYTES, "ercot_mis_download_failed");
  }

  async ingest(payload: RenewablePublicationPayload): Promise<void> {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_INGEST_BYTES) {
      throw new Error("ercot_mis_ingest_size_invalid");
    }
    const result = await this.#request(
      this.#endpoint,
      { method: "POST", headers: this.#headers, body },
      64 * 1024,
    );
    if (
      !object(result) ||
      !["inserted", "unchanged"].includes(String(result.status)) ||
      typeof result.vintage_key !== "string" ||
      !/^rv1-[0-9a-f]{64}$/.test(result.vintage_key) ||
      typeof result.content_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(result.content_hash) ||
      !Number.isInteger(result.row_count) ||
      Number(result.row_count) !== payload.rows.length
    ) {
      throw new Error("ercot_mis_receiver_response_invalid");
    }
  }

  async loadCheckpoint(): Promise<RenewableCollectorCheckpoint | undefined> {
    const checkpoints: RenewableCollectorCheckpoint[] = [];
    for (const { sourceId } of Object.values(PRODUCT_SOURCES)) {
      const url = new URL(this.#endpoint);
      url.pathname = "/api/source-checkpoint";
      url.searchParams.set("source_id", sourceId);
      const result = await this.#request(url, { headers: this.#headers }, 64 * 1024);
      if (!object(result)) throw new Error("ercot_mis_checkpoint_response_invalid");
      const checkpoint = parseCheckpoint(result.checkpoint);
      if (checkpoint) checkpoints.push(checkpoint);
    }
    if (
      checkpoints.length === 2 &&
      checkpointSignature(checkpoints[0]!) !== checkpointSignature(checkpoints[1]!)
    ) {
      throw new Error("ercot_mis_checkpoint_diverged");
    }
    return checkpoints[0];
  }

  async saveHealth(input: {
    attemptedAt: number;
    checkpoint: RenewableCollectorCheckpoint;
    products: Record<RenewableProductId, RenewableProductCycleResult>;
  }): Promise<void> {
    const url = new URL(this.#endpoint);
    url.pathname = "/api/source-health";
    const result = await this.#request(
      url,
      {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(
          (
            Object.entries(PRODUCT_SOURCES) as Array<
              [RenewableProductId, (typeof PRODUCT_SOURCES)[RenewableProductId]]
            >
          ).map(([productId, config]) => {
            const product = input.products[productId];
            return {
              source_id: config.sourceId,
              display_name: `ERCOT MIS ${productId} hourly renewable publication`,
              expected_interval_seconds: 3600,
              publication_mode: "event",
              publication_interval_seconds: 3600,
              attempted_at: input.attemptedAt,
              success: true,
              row_count: product.rowCount,
              availability_status: product.newestIssuedAt === undefined ? "empty" : "available",
              ...(product.newestIssuedAt === undefined
                ? {}
                : {
                    source_timestamp_ts: product.newestIssuedAt,
                    data_timestamp_ts: product.newestIssuedAt,
                  }),
              checkpoint: { version: 1, ...input.checkpoint },
              diagnostics: {
                backlog_count: product.backlogCount,
                bootstrap_truncated: product.bootstrapTruncated,
                processed_documents: product.processedDocuments,
              },
              provenance: {
                product_id: productId,
                report_type_id: config.reportTypeId,
                document_identity: "DocID",
              },
            };
          }),
        ),
      },
      64 * 1024,
    );
    if (!object(result) || !Number.isInteger(result.updated)) {
      throw new Error("ercot_mis_receiver_response_invalid");
    }
  }

  async saveFailure(attemptedAt: number, error: string): Promise<void> {
    const url = new URL(this.#endpoint);
    url.pathname = "/api/source-health";
    const result = await this.#request(
      url,
      {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(
          (
            Object.entries(PRODUCT_SOURCES) as Array<
              [RenewableProductId, (typeof PRODUCT_SOURCES)[RenewableProductId]]
            >
          ).map(([productId, config]) => ({
            source_id: config.sourceId,
            display_name: `ERCOT MIS ${productId} hourly renewable publication`,
            expected_interval_seconds: 3600,
            publication_mode: "event",
            publication_interval_seconds: 3600,
            attempted_at: attemptedAt,
            success: false,
            row_count: 0,
            error,
            provenance: { product_id: productId, report_type_id: config.reportTypeId },
          })),
        ),
      },
      64 * 1024,
    );
    if (!object(result) || !Number.isInteger(result.updated)) {
      throw new Error("ercot_mis_receiver_response_invalid");
    }
  }
}

type RuntimeEnvironment = { get(name: string): string | undefined };

export function renewableRuntimeConfig(
  environment: RuntimeEnvironment,
):
  | { enabled: false; reason: "disabled" | "missing_environment" }
  | { enabled: true; endpoint: string; apiKey: string } {
  if (environment.get("ERCOT_RENEWABLE_INGEST_ENABLED") !== "true") {
    return { enabled: false, reason: "disabled" };
  }
  const endpoint = environment.get("ERCOT_RENEWABLE_ENDPOINT");
  const apiKey = environment.get("METRICS_API_KEY");
  if (!endpoint || !apiKey) return { enabled: false, reason: "missing_environment" };
  return { enabled: true, endpoint, apiKey };
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

export type RenewableRuntimeTransport = RenewableCollectorTransport & {
  loadCheckpoint(): Promise<RenewableCollectorCheckpoint | undefined>;
  saveHealth(input: {
    attemptedAt: number;
    checkpoint: RenewableCollectorCheckpoint;
    products: Record<RenewableProductId, RenewableProductCycleResult>;
  }): Promise<void>;
  saveFailure(attemptedAt: number, error: string): Promise<void>;
};

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^ercot_mis_[a-z0-9_]{1,96}$/.test(error.message)
    ? error.message
    : "ercot_mis_cycle_failed";
}

export async function runRenewableCycle(
  transport: RenewableRuntimeTransport,
  now: number,
): Promise<void> {
  try {
    const stored = await transport.loadCheckpoint();
    const checkpoint =
      stored && stored.highWater
        ? { highWater: stored.highWater, overlapDocIds: stored.overlapDocIds }
        : undefined;
    const result = await collectRenewablePublications(transport, { checkpoint, retrievedAt: now });
    await transport.saveHealth({
      attemptedAt: now,
      checkpoint: result.checkpoint,
      products: result.products,
    });
  } catch (error) {
    const code = safeErrorCode(error);
    try {
      await transport.saveFailure(now, code);
    } catch {
      // Preserve the original bounded failure when health reporting also fails.
    }
    throw new Error(code);
  }
}

/** Wired runtime that remains inert unless the explicit environment opt-in is true. */
export async function startMisRenewablePublications(): Promise<never> {
  const runtime = renewableRuntimeConfig(Deno.env);
  if (!runtime.enabled) {
    console.log("mis_renewable_publications", runtime.reason);
    return await never();
  }
  const transport = new HttpMisRenewableTransport(runtime.endpoint, runtime.apiKey);
  for await (const _dutyCycle of fixedInterval(3_600_000)) {
    try {
      await runRenewableCycle(transport, Math.floor(Date.now() / 1_000));
      console.log(new Date().toISOString(), "mis_renewable_publications", "cycle=complete");
    } catch {
      console.log(new Date().toISOString(), "mis_renewable_publications", "cycle=failed");
    }
  }
  return await never();
}

if (import.meta.main) await startMisRenewablePublications();
