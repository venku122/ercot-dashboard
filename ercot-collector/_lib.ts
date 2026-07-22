export * from "./deps.ts";
import { DatadogApi, fetch as instrumentedFetch, fixedInterval } from "./deps.ts";
import type { MetricSubmission as DatadogMetricSubmission } from "./deps.ts";

export type MetricPoint = {
  dedupe_key?: string;
  timestamp?: number;
  value: number;
};

export type NormalizedMetric = {
  dedupe_key?: string;
  interval?: number;
  metric_name: string;
  metric_type?: "count" | "gauge" | "rate";
  points: MetricPoint[];
  tags?: string[];
};

export type NormalizedEvent = {
  body?: string;
  dedupe_key: string;
  ends_at?: number;
  event_type: string;
  external_key?: string;
  metadata?: Record<string, unknown>;
  observed_at: number;
  severity?: string;
  source_id: string;
  starts_at: number;
  status?: string;
  title: string;
};

export type SourceResult = {
  diagnostics?: Record<string, unknown>;
  events: NormalizedEvent[];
  metrics: NormalizedMetric[];
  payloadHash: string;
  sourceTimestamp: number;
};

export type SourceAdapter = {
  displayName: string;
  expectedIntervalSeconds: number;
  gather: () => Promise<SourceResult>;
  mutableMetricNames?: string[];
  overlapSeconds?: number;
  publicationIntervalSeconds?: number;
  publicationMode?: "event" | "polling";
  sourceId: string;
};

export type SourceCheckpoint = {
  events?: Record<string, string>;
  high_water_ts: number;
  values: Record<string, number>;
  version: 1;
};

type SourceAttempt = {
  attempted_at: number;
  display_name: string;
  error?: string;
  expected_interval_seconds: number;
  checkpoint?: SourceCheckpoint;
  payload_hash?: string;
  publication_interval_seconds?: number;
  publication_mode?: "event" | "polling";
  row_count: number;
  source_id: string;
  source_timestamp_ts?: number;
  success: boolean;
};

const metricsEndpoint = Deno.env.get("METRICS_ENDPOINT");
const metricsApiKey = Deno.env.get("METRICS_API_KEY");
const defaultFetchTimeoutMs = 30_000;
let datadog: DatadogApi | null = null;

function fetchTimeoutMs() {
  const raw = Deno.env.get("FETCH_TIMEOUT_MS");
  if (!raw) return defaultFetchTimeoutMs;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultFetchTimeoutMs;
}

export async function fetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const timeoutMs = fetchTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(`timeout ${timeoutMs}ms`), timeoutMs);
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  try {
    const response = await instrumentedFetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`source_http_${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function getDatadog(): DatadogApi {
  if (!datadog) datadog = DatadogApi.fromEnvironment(Deno.env);
  return datadog;
}

function receiverEndpoint(path: string): string | null {
  if (!metricsEndpoint) return null;
  const url = new URL(metricsEndpoint);
  url.pathname = path;
  url.search = "";
  return url.toString();
}

async function submitJson(endpoint: string, data: unknown) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(metricsApiKey ? { "X-API-Key": metricsApiKey } : {}),
    },
    body: JSON.stringify(data),
  });
  await response.body?.cancel();
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function metricBatches(data: NormalizedMetric[], maximumBytes = 400 * 1024) {
  const encoder = new TextEncoder();
  const split: Array<{ bytes: number; entry: NormalizedMetric }> = [];
  for (const entry of data) {
    const metadata = { ...entry, points: [] };
    const emptyBytes = encoder.encode(JSON.stringify(metadata)).byteLength;
    const baseBytes = emptyBytes - 2;
    let points: MetricPoint[] = [];
    let pointsBytes = 0;
    for (const point of entry.points) {
      const pointBytes = encoder.encode(JSON.stringify(point)).byteLength;
      const candidateBytes = baseBytes + 2 + pointsBytes + (points.length ? 1 : 0) + pointBytes;
      if (points.length && candidateBytes > maximumBytes - 2) {
        split.push({ entry: { ...entry, points }, bytes: baseBytes + 2 + pointsBytes });
        points = [];
        pointsBytes = 0;
      }
      points.push(point);
      pointsBytes += (points.length > 1 ? 1 : 0) + pointBytes;
    }
    if (points.length) {
      const bytes = baseBytes + 2 + pointsBytes;
      if (bytes > maximumBytes - 2) throw new Error("metric_point_exceeds_batch_limit");
      split.push({ entry: { ...entry, points }, bytes });
    }
  }
  const batches: NormalizedMetric[][] = [];
  let batch: NormalizedMetric[] = [];
  let batchBytes = 2;
  for (const item of split) {
    const candidateBytes = batchBytes + (batch.length ? 1 : 0) + item.bytes;
    if (batch.length && candidateBytes > maximumBytes) {
      batches.push(batch);
      batch = [item.entry];
      batchBytes = 2 + item.bytes;
    } else {
      batch.push(item.entry);
      batchBytes = candidateBytes;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function incrementalMetrics(
  metrics: NormalizedMetric[],
  checkpoint: SourceCheckpoint | null,
  mutableMetricNames: string[] = [],
  overlapSeconds = 3600,
): { checkpoint: SourceCheckpoint; metrics: NormalizedMetric[] } {
  const mutable = new Set(mutableMetricNames);
  const priorValues = checkpoint?.values ?? {};
  const previousHighWater = checkpoint?.high_water_ts ?? 0;
  let highWater = previousHighWater;
  for (const entry of metrics) {
    for (const point of entry.points) highWater = Math.max(highWater, point.timestamp ?? 0);
  }
  const retainedValues: Record<string, number> = {};
  const output: NormalizedMetric[] = [];
  const cutoff = Math.max(0, highWater - Math.max(0, overlapSeconds));
  for (const entry of metrics) {
    const isMutable = mutable.has(entry.metric_name);
    const changed: MetricPoint[] = [];
    for (const point of entry.points) {
      const identity = point.dedupe_key;
      const timestamp = point.timestamp ?? 0;
      if (!identity) {
        changed.push(point);
        continue;
      }
      if (isMutable || timestamp >= cutoff) retainedValues[identity] = point.value;
      const isCandidate =
        !checkpoint ||
        isMutable ||
        timestamp > previousHighWater ||
        timestamp >= previousHighWater - overlapSeconds;
      if (isCandidate && priorValues[identity] !== point.value) changed.push(point);
    }
    if (changed.length) output.push({ ...entry, points: changed });
  }
  return {
    metrics: output,
    checkpoint: {
      version: 1,
      high_water_ts: highWater,
      values: retainedValues,
      events: checkpoint?.events ?? {},
    },
  };
}

function incrementalEvents(
  events: NormalizedEvent[],
  checkpoint: SourceCheckpoint,
): { checkpoint: SourceCheckpoint; events: NormalizedEvent[] } {
  const previous = checkpoint.events ?? {};
  const next: Record<string, string> = {};
  const changed: NormalizedEvent[] = [];
  for (const event of events) {
    const fingerprint = JSON.stringify(stableValue(event));
    next[event.dedupe_key] = fingerprint;
    if (previous[event.dedupe_key] !== fingerprint) changed.push(event);
  }
  return { events: changed, checkpoint: { ...checkpoint, events: next } };
}

export async function submitMetrics(data: NormalizedMetric[]) {
  if (!data.length) return;
  if (metricsEndpoint) {
    for (const batch of metricBatches(data)) await submitJson(metricsEndpoint, batch);
    return;
  }
  const submissions = data.flatMap((entry) =>
    entry.points.map(
      (point) =>
        ({
          metric_name: entry.metric_name,
          points: [{ timestamp: point.timestamp, value: point.value }],
          tags: entry.tags,
          interval: entry.interval,
          metric_type: entry.metric_type,
        }) as DatadogMetricSubmission,
    ),
  );
  await getDatadog().v1Metrics.submit(submissions);
}

async function submitEvents(data: NormalizedEvent[]) {
  if (!data.length) return;
  const endpoint = receiverEndpoint("/api/events/ingest");
  if (!endpoint) return;
  let batch: NormalizedEvent[] = [];
  let bytes = 2;
  for (const event of data) {
    const eventBytes = jsonBytes(event);
    if (batch.length && bytes + 1 + eventBytes > 400 * 1024) {
      await submitJson(endpoint, batch);
      batch = [];
      bytes = 2;
    }
    batch.push(event);
    bytes += (batch.length > 1 ? 1 : 0) + eventBytes;
  }
  if (batch.length) await submitJson(endpoint, batch);
}

async function submitSourceAttempt(attempt: SourceAttempt) {
  const endpoint = receiverEndpoint("/api/source-health");
  if (!endpoint) return;
  await submitJson(endpoint, attempt);
}

async function loadSourceCheckpoint(sourceId: string): Promise<{
  checkpoint: SourceCheckpoint | null;
  payloadHash: string | null;
}> {
  const endpoint = receiverEndpoint("/api/source-checkpoint");
  if (!endpoint) return { checkpoint: null, payloadHash: null };
  const url = new URL(endpoint);
  url.searchParams.set("source_id", sourceId);
  const response = await fetch(url, {
    headers: metricsApiKey ? { "X-API-Key": metricsApiKey } : {},
  });
  const payload = (await response.json()) as {
    checkpoint?: SourceCheckpoint | null;
    payload_hash?: string | null;
  };
  return {
    checkpoint: payload.checkpoint ?? null,
    payloadHash: payload.payload_hash ?? null,
  };
}

export function headers(accept = "text/html") {
  return {
    headers: {
      Accept: accept,
      "User-Agent": `Deno/${Deno.version.deno} (+https://github.com/venku122/ercot-dashboard)`,
    },
  };
}

export function parseErcotTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid_source_timestamp");
  }
  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid_source_timestamp");
  return Math.floor(milliseconds / 1000);
}

export function epochSeconds(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("invalid_epoch");
  return Math.floor(parsed > 1_000_000_000_000 ? parsed / 1000 : parsed);
}

export function numeric(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid_numeric_${field}`);
  return parsed;
}

export function tagValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function metric(
  sourceId: string,
  metricName: string,
  timestamp: number,
  value: number,
  tags: string[] = [],
  interval = 300,
): NormalizedMetric {
  return metricSeries(sourceId, metricName, [{ timestamp, value }], tags, interval);
}

export function metricSeries(
  sourceId: string,
  metricName: string,
  points: Array<{ timestamp: number; value: number }>,
  tags: string[] = [],
  interval = 300,
): NormalizedMetric {
  const normalizedTags = [...new Set(tags)].sort();
  return {
    metric_name: metricName,
    points: points.map(({ timestamp, value }) => ({
      timestamp,
      value,
      dedupe_key: [sourceId, metricName, normalizedTags.join(","), timestamp].join(":"),
    })),
    tags: [`source:${sourceId}`, ...normalizedTags],
    interval,
    metric_type: "gauge",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

export async function payloadHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runSourceLoop(adapter: SourceAdapter, offsetSeconds = 0) {
  if (offsetSeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, offsetSeconds * 1000));
  }
  let checkpoint: SourceCheckpoint | null = null;
  let previousHash: string | null = null;
  try {
    const recovered = await loadSourceCheckpoint(adapter.sourceId);
    checkpoint = recovered.checkpoint;
    previousHash = recovered.payloadHash;
  } catch (error) {
    console.error(new Date().toISOString(), adapter.sourceId, "checkpoint", error);
  }
  for await (const dutyCycle of fixedInterval(adapter.expectedIntervalSeconds * 1000)) {
    const attemptedAt = Math.floor(Date.now() / 1000);
    try {
      const result = await adapter.gather();
      const rowCount =
        result.metrics.reduce((total, entry) => total + entry.points.length, 0) +
        result.events.length;
      if (rowCount === 0) throw new Error("zero_core_rows");
      const unchanged = previousHash === result.payloadHash;
      const incremental = incrementalMetrics(
        result.metrics,
        checkpoint,
        adapter.mutableMetricNames,
        adapter.overlapSeconds,
      );
      const incrementalEventResult = incrementalEvents(result.events, incremental.checkpoint);
      await submitMetrics(incremental.metrics);
      await submitEvents(incrementalEventResult.events);
      await submitMetrics([
        metric(
          adapter.sourceId,
          "ercot.app.duty_cycle",
          attemptedAt,
          dutyCycle * 100,
          [`app:${adapter.sourceId}`],
          adapter.expectedIntervalSeconds,
        ),
      ]);
      await submitSourceAttempt({
        source_id: adapter.sourceId,
        display_name: adapter.displayName,
        expected_interval_seconds: adapter.expectedIntervalSeconds,
        attempted_at: attemptedAt,
        success: true,
        source_timestamp_ts: result.sourceTimestamp,
        payload_hash: result.payloadHash,
        row_count: rowCount,
        checkpoint: incrementalEventResult.checkpoint,
        publication_mode: adapter.publicationMode ?? "polling",
        publication_interval_seconds: adapter.publicationIntervalSeconds,
      });
      checkpoint = incrementalEventResult.checkpoint;
      previousHash = result.payloadHash;
      console.log(
        new Date().toISOString(),
        adapter.sourceId,
        unchanged && !incremental.metrics.length && !incrementalEventResult.events.length
          ? "unchanged"
          : "submitted",
        incremental.metrics.reduce((total, entry) => total + entry.points.length, 0) +
          incrementalEventResult.events.length,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(new Date().toISOString(), adapter.sourceId, message);
      try {
        await submitSourceAttempt({
          source_id: adapter.sourceId,
          display_name: adapter.displayName,
          expected_interval_seconds: adapter.expectedIntervalSeconds,
          attempted_at: attemptedAt,
          success: false,
          row_count: 0,
          error: message,
          publication_mode: adapter.publicationMode ?? "polling",
          publication_interval_seconds: adapter.publicationIntervalSeconds,
        });
      } catch (healthError) {
        console.error(new Date().toISOString(), adapter.sourceId, "health", healthError);
      }
    }
  }
}

export async function runMetricsLoop(
  gather: () => Promise<NormalizedMetric[]>,
  intervalMinutes: number,
  loopName: string,
) {
  for await (const dutyCycle of fixedInterval(intervalMinutes * 60 * 1000)) {
    const attemptedAt = Math.floor(Date.now() / 1000);
    try {
      const data = await gather();
      if (!data.length) throw new Error("zero_core_rows");
      const pointTimestamps = data.flatMap((entry) =>
        entry.points.flatMap((point) => (point.timestamp ? [point.timestamp] : [])),
      );
      const sourceTimestamp = pointTimestamps.length ? Math.max(...pointTimestamps) : attemptedAt;
      data.push(
        metric(
          loopName,
          "ercot.app.duty_cycle",
          attemptedAt,
          dutyCycle * 100,
          [`app:${loopName}`],
          60,
        ),
      );
      try {
        await submitMetrics(data);
      } catch (error) {
        console.error(new Date().toISOString(), loopName, "retry", error);
        await submitMetrics(data);
      }
      await submitSourceAttempt({
        source_id: loopName,
        display_name: loopName.replaceAll("_", " "),
        expected_interval_seconds: intervalMinutes * 60,
        attempted_at: attemptedAt,
        success: true,
        source_timestamp_ts: sourceTimestamp,
        payload_hash: await payloadHash(data),
        row_count: data.reduce((total, entry) => total + entry.points.length, 0),
        publication_mode: "polling",
      });
    } catch (error) {
      console.error(new Date().toISOString(), loopName, error);
      try {
        await submitSourceAttempt({
          source_id: loopName,
          display_name: loopName.replaceAll("_", " "),
          expected_interval_seconds: intervalMinutes * 60,
          attempted_at: attemptedAt,
          success: false,
          row_count: 0,
          error: error instanceof Error ? error.message : String(error),
          publication_mode: "polling",
        });
      } catch (healthError) {
        console.error(new Date().toISOString(), loopName, "health", healthError);
      }
    }
  }
}
