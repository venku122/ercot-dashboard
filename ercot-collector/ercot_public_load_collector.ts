import { payloadHash } from "./_lib.ts";
import { fixedInterval } from "./deps.ts";
import {
  ErcotApiClient,
  publicReportArtifactLinks,
  type ErcotCredentials,
  type ErcotPublicInventory,
  type ErcotQuery,
} from "./ercot_api.ts";
import {
  buildForecastPublicationPayload,
  ERCOT_PUBLIC_LOAD_SOURCES,
  ercotMarketHourEndingTargetTs,
  ercotPublicLoadSchemaFingerprint,
  parseErcotPublicLoadPage,
  requireCompleteErcotPublicLoadPages,
  type CompletePublicLoadRows,
  type ErcotPublicLoadProductId,
  type ForecastPublicationPayload,
  type ParsedPublicLoadPage,
} from "./ercot_public_load_sources.ts";

type JsonObject = Record<string, unknown>;

export const MAX_FORECAST_PUBLICATION_BYTES = 1_024 * 1_024;

export type ForecastPublicClient = {
  publicArtifact<T = unknown>(
    report: JsonObject,
    advertisedHref: string,
    query?: ErcotQuery,
  ): Promise<T>;
  publicReports(): Promise<ErcotPublicInventory>;
};

export type ForecastIngestResult = {
  content_hash: string;
  row_count: number;
  status: "inserted" | "unchanged";
  vintage_key: string;
};

export type ForecastReceiver = {
  ingest(payload: ForecastPublicationPayload): Promise<ForecastIngestResult>;
  loadCheckpoint(sourceId: string): Promise<number | null>;
  sourceHealth(attempt: JsonObject): Promise<void>;
};

export type ForecastCollectorOptions = {
  intervalSeconds?: number;
  maximumLookbackSeconds?: number;
  maximumPages?: number;
  maximumPublications?: number;
  maximumRows?: number;
  now?: () => number;
  overlapSeconds?: number;
  pageSize?: number;
};

export type ForecastCycleResult = {
  failed: ErcotPublicLoadProductId[];
  succeeded: ErcotPublicLoadProductId[];
};

type ProductConfig = {
  displayName: string;
  productId: ErcotPublicLoadProductId;
};

const PRODUCTS: readonly ProductConfig[] = Object.freeze([
  {
    displayName: "ERCOT NP3-565 weather-zone load forecast",
    productId: "NP3-565-CD",
  },
  {
    displayName: "ERCOT NP3-763 short-term system adequacy",
    productId: "NP3-763-CD",
  },
  {
    displayName: "ERCOT NP6-345 actual weather-zone load",
    productId: "NP6-345-CD",
  },
]);

const CHICAGO_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chicagoRawDatetime(epochSeconds: number): string {
  const parts = Object.fromEntries(
    CHICAGO_PARTS.formatToParts(new Date(epochSeconds * 1_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function chicagoDate(epochSeconds: number): string {
  return chicagoRawDatetime(epochSeconds).slice(0, 10);
}

function shiftDate(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function forecastQueryWindow(
  productId: ErcotPublicLoadProductId,
  start: number,
  end: number,
): Record<string, boolean | number | string> {
  const startDay = chicagoDate(start);
  const endDay = chicagoDate(end);
  if (productId === "NP3-565-CD") {
    return {
      deliveryDateFrom: startDay,
      deliveryDateTo: shiftDate(endDay, 7),
      postedDatetimeFrom: chicagoRawDatetime(start),
      postedDatetimeTo: chicagoRawDatetime(end),
      sort: "postedDatetime",
      dir: "ASC",
    };
  }
  if (productId === "NP3-763-CD") {
    return {
      postedDatetimeFrom: chicagoRawDatetime(start),
      postedDatetimeTo: chicagoRawDatetime(end),
      deliveryDateFrom: startDay,
      deliveryDateTo: shiftDate(endDay, 7),
      hourEndingFrom: "01:00",
      hourEndingTo: "24:00",
    };
  }
  return {
    operatingDayFrom: shiftDate(endDay, -2),
    operatingDayTo: endDay,
    sort: "operatingDay",
    dir: "ASC",
  };
}

function hourEndingOrdinal(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0?[1-9]|1\d|2[0-4]):00$/.test(value)) {
    throw new Error("ercot_forecast_row_outside_window");
  }
  return Number(value.slice(0, value.indexOf(":")));
}

function requireRowsInsideWindow(
  productId: ErcotPublicLoadProductId,
  rows: CompletePublicLoadRows["rows"],
  query: Record<string, boolean | number | string>,
): void {
  const inside = (value: unknown, lower: string, upper: string) =>
    typeof value === "string" && value >= lower && value <= upper;
  for (const row of rows) {
    if (productId === "NP6-345-CD") {
      if (!inside(row.operatingDay, String(query.operatingDayFrom), String(query.operatingDayTo))) {
        throw new Error("ercot_forecast_row_outside_window");
      }
      continue;
    }
    if (
      !inside(
        row.postedDatetime,
        String(query.postedDatetimeFrom),
        String(query.postedDatetimeTo),
      ) ||
      !inside(row.deliveryDate, String(query.deliveryDateFrom), String(query.deliveryDateTo))
    ) {
      throw new Error("ercot_forecast_row_outside_window");
    }
    if (productId === "NP3-763-CD") {
      const hour = hourEndingOrdinal(row.hourEnding);
      if (
        hour < hourEndingOrdinal(query.hourEndingFrom) ||
        hour > hourEndingOrdinal(query.hourEndingTo)
      ) {
        throw new Error("ercot_forecast_row_outside_window");
      }
    }
  }
}

function advertisedReport(inventory: ErcotPublicInventory, productId: ErcotPublicLoadProductId) {
  const report = inventory.reports.find((candidate) => candidate.emilId === productId);
  if (!report) throw new Error("ercot_forecast_product_not_advertised");
  const expectedHref = ERCOT_PUBLIC_LOAD_SOURCES[productId].artifactHref;
  if (!publicReportArtifactLinks(report).includes(expectedHref)) {
    throw new Error("ercot_forecast_artifact_not_advertised");
  }
  return report;
}

function stableRows(complete: CompletePublicLoadRows): CompletePublicLoadRows {
  const rows = [...complete.rows].sort((left, right) => {
    const targetDelta =
      ercotMarketHourEndingTargetTs(complete.productId, left) -
      ercotMarketHourEndingTargetTs(complete.productId, right);
    if (targetDelta) return targetDelta;
    return String(left.model ?? "").localeCompare(String(right.model ?? ""));
  });
  return { ...complete, rows, totalRecords: rows.length };
}

function publicationGroups(complete: CompletePublicLoadRows): CompletePublicLoadRows[] {
  if (complete.productId === "NP6-345-CD") return [stableRows(complete)];
  const grouped = new Map<string, CompletePublicLoadRows["rows"]>();
  for (const row of complete.rows) {
    const posted = row.postedDatetime;
    if (typeof posted !== "string") throw new Error("ercot_forecast_posted_datetime_missing");
    const rows = grouped.get(posted) ?? [];
    rows.push(row);
    grouped.set(posted, rows);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([_posted, rows]) =>
      stableRows({
        fields: complete.fields,
        productId: complete.productId,
        rows,
        totalRecords: rows.length,
      }),
    );
}

export class ForecastPublicationCollector {
  readonly #client: ForecastPublicClient;
  readonly #receiver: ForecastReceiver;
  readonly #now: () => number;
  readonly #intervalSeconds: number;
  readonly #maximumLookbackSeconds: number;
  readonly #maximumPages: number;
  readonly #maximumPublications: number;
  readonly #maximumRows: number;
  readonly #overlapSeconds: number;
  readonly #pageSize: number;
  readonly #checkpointEnds = new Map<ErcotPublicLoadProductId, number>();
  #checkpointsLoaded = false;

  constructor(
    client: ForecastPublicClient,
    receiver: ForecastReceiver,
    options: ForecastCollectorOptions = {},
  ) {
    this.#client = client;
    this.#receiver = receiver;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#intervalSeconds = options.intervalSeconds ?? 3_600;
    this.#maximumLookbackSeconds = options.maximumLookbackSeconds ?? 172_800;
    this.#maximumPages = options.maximumPages ?? 100;
    this.#maximumPublications = options.maximumPublications ?? 100;
    this.#maximumRows = options.maximumRows ?? 100_000;
    this.#overlapSeconds = options.overlapSeconds ?? 7_200;
    this.#pageSize = options.pageSize ?? 1_000;
    for (const [value, minimum, maximum, code] of [
      [this.#intervalSeconds, 300, 86_400, "interval"],
      [this.#maximumLookbackSeconds, 3_600, 604_800, "lookback"],
      [this.#maximumPages, 1, 100, "pages"],
      [this.#maximumPublications, 1, 100, "publications"],
      [this.#maximumRows, 1, 100_000, "rows"],
      [this.#overlapSeconds, 0, 86_400, "overlap"],
      [this.#pageSize, 1, 1_000, "page_size"],
    ] as const) {
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`ercot_forecast_invalid_${code}`);
      }
    }
  }

  async #loadCheckpoints() {
    if (this.#checkpointsLoaded) return;
    for (const config of PRODUCTS) {
      const sourceId = ERCOT_PUBLIC_LOAD_SOURCES[config.productId].sourceId;
      try {
        const checkpoint = await this.#receiver.loadCheckpoint(sourceId);
        if (checkpoint !== null && Number.isInteger(checkpoint) && checkpoint > 0) {
          this.#checkpointEnds.set(config.productId, checkpoint);
        }
      } catch {
        // Replay is receiver-idempotent; a missing checkpoint falls back to the
        // bounded bootstrap window without exposing endpoint or credential data.
      }
    }
    this.#checkpointsLoaded = true;
  }

  async #fetchComplete(
    productId: ErcotPublicLoadProductId,
    report: JsonObject,
    queryWindow: Record<string, boolean | number | string>,
  ): Promise<{ complete: CompletePublicLoadRows; pages: number }> {
    const href = ERCOT_PUBLIC_LOAD_SOURCES[productId].artifactHref;
    const pages: ParsedPublicLoadPage[] = [];
    let expectedPages: number | null = null;
    for (let pageNumber = 1; ; pageNumber += 1) {
      if (pageNumber > this.#maximumPages) throw new Error("ercot_forecast_page_limit");
      const payload = await this.#client.publicArtifact(report, href, {
        ...queryWindow,
        page: pageNumber,
        size: this.#pageSize,
      });
      const page = parseErcotPublicLoadPage(productId, payload);
      if (page.meta.totalRecords > this.#maximumRows) {
        throw new Error("ercot_forecast_row_limit");
      }
      expectedPages ??= page.meta.totalPages;
      if (page.meta.totalPages !== expectedPages || expectedPages > this.#maximumPages) {
        throw new Error("ercot_forecast_pagination_changed");
      }
      pages.push(page);
      if (expectedPages === 0 || pageNumber >= expectedPages) break;
    }
    return {
      complete: requireCompleteErcotPublicLoadPages(productId, pages),
      pages: pages.length,
    };
  }

  async #health(
    config: ProductConfig,
    attempt: {
      availability?: "available" | "empty";
      checkpointEnd?: number;
      diagnostics?: JsonObject;
      error?: string;
      payloadHash?: string;
      rowCount: number;
      dataTimestamp?: number;
      sourceTimestamp?: number;
      success: boolean;
    },
    attemptedAt: number,
  ) {
    const source = ERCOT_PUBLIC_LOAD_SOURCES[config.productId];
    await this.#receiver.sourceHealth({
      source_id: source.sourceId,
      display_name: config.displayName,
      expected_interval_seconds: this.#intervalSeconds,
      attempted_at: attemptedAt,
      success: attempt.success,
      row_count: attempt.rowCount,
      publication_mode: "polling",
      publication_interval_seconds: this.#intervalSeconds,
      ...(attempt.availability === undefined ? {} : { availability_status: attempt.availability }),
      ...(attempt.checkpointEnd === undefined
        ? {}
        : {
            checkpoint: {
              version: 1,
              last_successful_window_end: attempt.checkpointEnd,
              overlap_seconds: this.#overlapSeconds,
            },
          }),
      ...(attempt.diagnostics === undefined ? {} : { diagnostics: attempt.diagnostics }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
      ...(attempt.payloadHash === undefined ? {} : { payload_hash: attempt.payloadHash }),
      ...(attempt.sourceTimestamp === undefined
        ? {}
        : {
            source_timestamp_ts: attempt.sourceTimestamp,
          }),
      ...(attempt.dataTimestamp === undefined ? {} : { data_timestamp_ts: attempt.dataTimestamp }),
      provenance: {
        product_id: config.productId,
        artifact_href: source.artifactHref,
        schema_fingerprint: await ercotPublicLoadSchemaFingerprint(config.productId),
      },
    });
  }

  async #collectProduct(
    inventory: ErcotPublicInventory,
    config: ProductConfig,
    attemptedAt: number,
  ) {
    const report = advertisedReport(inventory, config.productId);
    const checkpointEnd = this.#checkpointEnds.get(config.productId);
    const windowStart = Math.max(
      attemptedAt - this.#maximumLookbackSeconds,
      checkpointEnd === undefined
        ? attemptedAt - this.#maximumLookbackSeconds
        : checkpointEnd - this.#overlapSeconds,
    );
    const queryWindow = forecastQueryWindow(config.productId, windowStart, attemptedAt);
    const { complete, pages } = await this.#fetchComplete(config.productId, report, queryWindow);
    requireRowsInsideWindow(config.productId, complete.rows, queryWindow);
    if (complete.rows.length === 0) {
      await this.#health(
        config,
        {
          availability: "empty",
          checkpointEnd: attemptedAt,
          diagnostics: { pages, publications: 0, query_window: queryWindow },
          payloadHash: await payloadHash({ product: config.productId, queryWindow, rows: [] }),
          rowCount: 0,
          sourceTimestamp: attemptedAt,
          success: true,
        },
        attemptedAt,
      );
      this.#checkpointEnds.set(config.productId, attemptedAt);
      return;
    }

    const groups = publicationGroups(complete);
    if (groups.length > this.#maximumPublications) {
      throw new Error("ercot_forecast_publication_limit");
    }
    const ingested: ForecastIngestResult[] = [];
    let targetMinimum = Number.POSITIVE_INFINITY;
    let targetMaximum = 0;
    let newestIssuedAt = 0;
    for (const group of groups) {
      const rawPostedDatetime =
        config.productId === "NP6-345-CD" ? undefined : (group.rows[0]!.postedDatetime as string);
      const payload = await buildForecastPublicationPayload(group, {
        queryWindow,
        ...(rawPostedDatetime === undefined ? {} : { rawPostedDatetime }),
        retrievedAt: attemptedAt,
      });
      if (
        new TextEncoder().encode(JSON.stringify(payload)).length > MAX_FORECAST_PUBLICATION_BYTES
      ) {
        throw new Error("ercot_forecast_publication_too_large");
      }
      ingested.push(await this.#receiver.ingest(payload));
      const targetTimestamps = payload.rows.map((row) => Number(row.target_ts));
      targetMinimum = Math.min(targetMinimum, ...targetTimestamps);
      targetMaximum = Math.max(targetMaximum, ...targetTimestamps);
      newestIssuedAt = Math.max(newestIssuedAt, payload.publication.issued_at ?? 0);
    }
    await this.#health(
      config,
      {
        availability: "available",
        checkpointEnd: attemptedAt,
        diagnostics: {
          pages,
          publications: groups.length,
          inserted: ingested.filter((result) => result.status === "inserted").length,
          unchanged: ingested.filter((result) => result.status === "unchanged").length,
          target_min_ts: targetMinimum,
          target_max_ts: targetMaximum,
          query_window: queryWindow,
        },
        payloadHash: await payloadHash(ingested.map((result) => result.content_hash)),
        rowCount: complete.rows.length,
        dataTimestamp: newestIssuedAt || targetMaximum,
        sourceTimestamp: newestIssuedAt || targetMaximum,
        success: true,
      },
      attemptedAt,
    );
    this.#checkpointEnds.set(config.productId, attemptedAt);
  }

  async collectOnce(): Promise<ForecastCycleResult> {
    await this.#loadCheckpoints();
    const attemptedAt = this.#now();
    let inventory: ErcotPublicInventory;
    try {
      inventory = await this.#client.publicReports();
    } catch {
      const failed = PRODUCTS.map((config) => config.productId);
      for (const config of PRODUCTS) {
        try {
          await this.#health(
            config,
            { error: "ercot_forecast_inventory_failed", rowCount: 0, success: false },
            attemptedAt,
          );
        } catch {
          // Preserve the primary failure without leaking receiver details.
        }
      }
      return { failed, succeeded: [] };
    }
    const result: ForecastCycleResult = { failed: [], succeeded: [] };
    for (const config of PRODUCTS) {
      try {
        await this.#collectProduct(inventory, config, attemptedAt);
        result.succeeded.push(config.productId);
      } catch (error) {
        result.failed.push(config.productId);
        const code = error instanceof Error ? error.message : "ercot_forecast_collection_failed";
        try {
          await this.#health(
            config,
            {
              error: code.startsWith("ercot_") ? code : "ercot_forecast_collection_failed",
              rowCount: 0,
              success: false,
            },
            attemptedAt,
          );
        } catch {
          // The next cycle retries the same bounded overlap.
        }
      }
    }
    return result;
  }
}

export class HttpForecastReceiver implements ForecastReceiver {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(endpoint: string, apiKey: string, fetcher = globalThis.fetch.bind(globalThis)) {
    const url = new URL(endpoint);
    const localHttpHosts = new Set(["127.0.0.1", "[::1]", "localhost", "receiver"]);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && localHttpHosts.has(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/forecast-publications/ingest" ||
      !apiKey
    ) {
      throw new Error("ercot_forecast_receiver_configuration_invalid");
    }
    this.#endpoint = url;
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
  }

  async #request(url: URL, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("X-API-Key", this.#apiKey);
    const response = await this.#fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ercot_forecast_receiver_http_${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error("ercot_forecast_receiver_response_invalid");
    }
  }

  async ingest(payload: ForecastPublicationPayload): Promise<ForecastIngestResult> {
    const result = await this.#request(this.#endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (
      !isObject(result) ||
      !["inserted", "unchanged"].includes(String(result.status)) ||
      typeof result.vintage_key !== "string" ||
      !/^v1-[0-9a-f]{64}$/.test(result.vintage_key) ||
      typeof result.content_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(result.content_hash) ||
      typeof result.row_count !== "number" ||
      !Number.isInteger(result.row_count) ||
      result.row_count < 1
    ) {
      throw new Error("ercot_forecast_receiver_response_invalid");
    }
    return result as ForecastIngestResult;
  }

  async sourceHealth(attempt: JsonObject): Promise<void> {
    const url = new URL(this.#endpoint);
    url.pathname = "/api/source-health";
    const result = await this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt),
    });
    if (!isObject(result) || !Number.isInteger(result.updated)) {
      throw new Error("ercot_forecast_receiver_response_invalid");
    }
  }

  async loadCheckpoint(sourceId: string): Promise<number | null> {
    const url = new URL(this.#endpoint);
    url.pathname = "/api/source-checkpoint";
    url.searchParams.set("source_id", sourceId);
    const result = await this.#request(url, { method: "GET" });
    if (!isObject(result)) throw new Error("ercot_forecast_receiver_response_invalid");
    const checkpoint = result.checkpoint;
    if (checkpoint === null || checkpoint === undefined) return null;
    if (
      !isObject(checkpoint) ||
      checkpoint.version !== 1 ||
      typeof checkpoint.last_successful_window_end !== "number" ||
      !Number.isInteger(checkpoint.last_successful_window_end) ||
      checkpoint.last_successful_window_end <= 0
    ) {
      throw new Error("ercot_forecast_receiver_response_invalid");
    }
    return checkpoint.last_successful_window_end as number;
  }
}

type RuntimeEnvironment = { get(name: string): string | undefined };

export function forecastRuntimeConfig(environment: RuntimeEnvironment):
  | { enabled: false; reason: "disabled" | "missing_environment" }
  | {
      credentials: ErcotCredentials;
      enabled: true;
      endpoint: string;
      metricsApiKey: string;
    } {
  if (environment.get("ERCOT_FORECAST_INGEST_ENABLED") !== "true") {
    return { enabled: false, reason: "disabled" };
  }
  const values = {
    username: environment.get("ERCOT_API_USERNAME"),
    password: environment.get("ERCOT_API_PASSWORD"),
    publicSubscriptionKey: environment.get("ERCOT_PUBLIC_API_SUBSCRIPTION_KEY"),
    esrSubscriptionKey: environment.get("ERCOT_ESR_API_SUBSCRIPTION_KEY"),
    endpoint: environment.get("ERCOT_FORECAST_ENDPOINT"),
    metricsApiKey: environment.get("METRICS_API_KEY"),
  };
  if (Object.values(values).some((value) => !value)) {
    return { enabled: false, reason: "missing_environment" };
  }
  return {
    enabled: true,
    credentials: {
      username: values.username!,
      password: values.password!,
      publicSubscriptionKey: values.publicSubscriptionKey!,
      esrSubscriptionKey: values.esrSubscriptionKey!,
    },
    endpoint: values.endpoint!,
    metricsApiKey: values.metricsApiKey!,
  };
}

function never(): Promise<never> {
  return new Promise(() => undefined);
}

export async function startForecastPublications(): Promise<never> {
  const runtime = forecastRuntimeConfig(Deno.env);
  if (!runtime.enabled) {
    console.log("forecast_publications", runtime.reason);
    return await never();
  }
  const client = new ErcotApiClient({
    credentials: runtime.credentials,
    requestsPerMinute: 30,
  });
  const collector = new ForecastPublicationCollector(
    client,
    new HttpForecastReceiver(runtime.endpoint, runtime.metricsApiKey),
  );
  for await (const _dutyCycle of fixedInterval(3_600_000)) {
    const result = await collector.collectOnce();
    console.log(
      new Date().toISOString(),
      "forecast_publications",
      `succeeded=${result.succeeded.length}`,
      `failed=${result.failed.length}`,
    );
  }
  return await never();
}
