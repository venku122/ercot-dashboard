import { fixedInterval } from "./deps.ts";
import {
  buildNwsForecastPoint,
  NWS_WEATHER_POINTS,
  NWS_WEATHER_SCHEMA,
  type NwsAlertsSource,
  type NwsGridPayload,
  type NwsPointId,
  type NwsPointMapping,
  type NwsWeatherPublication,
  parseNwsGridData,
  parseNwsPoint,
  parseNwsTexasAlerts,
  pointUrl,
} from "./nws_weather.ts";

type Json = Record<string, unknown>;
const ALERTS_URL = "https://api.weather.gov/alerts/active?area=TX&status=actual";
const MAX_POINT_BYTES = 256 * 1024;
const MAX_GRID_BYTES = 2 * 1024 * 1024;
const MAX_ALERT_BYTES = 4 * 1024 * 1024;
const MAX_RECEIVER_BYTES = 64 * 1024;
const MAX_INGEST_BYTES = 4 * 1024 * 1024;

function object(value: unknown, code: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Json;
}

async function boundedBytes(response: Response, maximum: number, code: string) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new Error(`${code}_size`);
  }
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
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function boundedJson(response: Response, maximum: number, code: string) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, maximum, code)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(code)) throw error;
    throw new Error(`${code}_json`);
  }
}

type CacheEntry = {
  body: unknown;
  etag: string | null;
  lastModified: string | null;
  nextAllowedAt: number;
  validatedAt: number;
};
export type NwsFetchResult<T> = {
  freshUntil: number;
  stale: boolean;
  validatedAt: number;
  value: T;
};

function cacheSeconds(headers: Headers, now: number, minimum: number, maximum: number) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get("cache-control") ?? "");
  const expires = Date.parse(headers.get("expires") ?? "") / 1_000;
  const suggested = match ? Number(match[1]) : Number.isFinite(expires) ? expires - now : minimum;
  return Math.max(minimum, Math.min(maximum, suggested));
}

export class ConditionalNwsClient {
  readonly cache = new Map<string, CacheEntry>();
  readonly backoffUntil = new Map<string, number>();
  constructor(
    readonly userAgent: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (
      userAgent.length < 12 ||
      userAgent.length > 256 ||
      !(/@/.test(userAgent) || /https?:\/\//.test(userAgent))
    ) {
      throw new Error("nws_user_agent_config");
    }
  }

  async get(
    url: string,
    now: number,
    maximumBytes: number,
    minimumFreshSeconds: number,
    maximumFreshSeconds: number,
    maximumStaleSeconds: number,
  ): Promise<NwsFetchResult<unknown>> {
    const cached = this.cache.get(url);
    const backoff = this.backoffUntil.get(url) ?? 0;
    if (now < backoff) {
      if (cached && now - cached.validatedAt <= maximumStaleSeconds) {
        return {
          freshUntil: cached.nextAllowedAt,
          stale: true,
          validatedAt: cached.validatedAt,
          value: cached.body,
        };
      }
      throw new Error("nws_backoff_active");
    }
    if (cached && now < cached.nextAllowedAt) {
      return {
        freshUntil: cached.nextAllowedAt,
        stale: false,
        validatedAt: cached.validatedAt,
        value: cached.body,
      };
    }
    const headers: Record<string, string> = {
      Accept: "application/geo+json",
      "User-Agent": this.userAgent,
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) {
      headers["If-Modified-Since"] = cached.lastModified;
    }
    try {
      const response = await this.fetchImpl(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 304) {
        if (!cached) throw new Error("nws_304_without_cache");
        const fresh = cacheSeconds(response.headers, now, minimumFreshSeconds, maximumFreshSeconds);
        cached.validatedAt = now;
        cached.nextAllowedAt = now + fresh;
        this.backoffUntil.delete(url);
        return {
          freshUntil: cached.nextAllowedAt,
          stale: false,
          validatedAt: now,
          value: cached.body,
        };
      }
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        const seconds =
          retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : Math.min(900, minimumFreshSeconds);
        this.backoffUntil.set(url, now + Math.max(5, Math.min(900, seconds)));
        throw new Error(`nws_http_${response.status}`);
      }
      const body = await boundedJson(response, maximumBytes, "nws_response");
      const fresh = cacheSeconds(response.headers, now, minimumFreshSeconds, maximumFreshSeconds);
      this.cache.set(url, {
        body,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        nextAllowedAt: now + fresh,
        validatedAt: now,
      });
      this.backoffUntil.delete(url);
      return {
        freshUntil: now + fresh,
        stale: false,
        validatedAt: now,
        value: body,
      };
    } catch (error) {
      if (cached && now - cached.validatedAt <= maximumStaleSeconds) {
        if (!this.backoffUntil.has(url)) {
          this.backoffUntil.set(url, now + Math.min(900, minimumFreshSeconds));
        }
        return {
          freshUntil: cached.nextAllowedAt,
          stale: true,
          validatedAt: cached.validatedAt,
          value: cached.body,
        };
      }
      throw error;
    }
  }
}

export interface NwsWeatherTransport {
  point(pointId: NwsPointId, now: number): Promise<NwsFetchResult<NwsPointMapping>>;
  grid(
    pointId: NwsPointId,
    mapping: NwsPointMapping,
    now: number,
  ): Promise<NwsFetchResult<NwsGridPayload>>;
  alerts(now: number): Promise<NwsFetchResult<NwsAlertsSource>>;
  ingest(payload: NwsWeatherPublication): Promise<void>;
  saveHealth(attempts: Json[]): Promise<void>;
}

export class HttpNwsWeatherTransport implements NwsWeatherTransport {
  readonly endpoint: URL;
  readonly client: ConditionalNwsClient;
  constructor(
    endpoint: string,
    readonly apiKey: string,
    userAgent: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    const local = new Set(["receiver", "localhost", "127.0.0.1", "[::1]"]);
    if (
      !apiKey ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/predictive-weather/ingest" ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol === "http:" && !local.has(url.hostname))
    ) {
      throw new Error("nws_receiver_config");
    }
    this.endpoint = url;
    this.client = new ConditionalNwsClient(userAgent, fetchImpl);
  }

  async point(pointId: NwsPointId, now: number) {
    const result = await this.client.get(
      pointUrl(pointId),
      now,
      MAX_POINT_BYTES,
      86_400,
      86_400,
      86_400,
    );
    return {
      stale: result.stale,
      freshUntil: result.freshUntil,
      validatedAt: result.validatedAt,
      value: parseNwsPoint(pointId, result.value),
    };
  }

  async grid(pointId: NwsPointId, mapping: NwsPointMapping, now: number) {
    const result = await this.client.get(
      mapping.forecast_grid_data_url,
      now,
      MAX_GRID_BYTES,
      900,
      900,
      7_200,
    );
    return {
      stale: result.stale,
      freshUntil: result.freshUntil,
      validatedAt: result.validatedAt,
      value: parseNwsGridData(pointId, result.value),
    };
  }

  async alerts(now: number) {
    const result = await this.client.get(ALERTS_URL, now, MAX_ALERT_BYTES, 60, 60, 300);
    return {
      stale: result.stale,
      freshUntil: result.freshUntil,
      validatedAt: result.validatedAt,
      value: parseNwsTexasAlerts(result.value),
    };
  }

  async receiver(path: string, init: RequestInit) {
    const url = new URL(this.endpoint);
    url.pathname = path;
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`nws_receiver_http_${response.status}`);
    return object(await boundedJson(response, MAX_RECEIVER_BYTES, "nws_receiver"), "nws_receiver");
  }

  async ingest(payload: NwsWeatherPublication) {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_INGEST_BYTES) {
      throw new Error("nws_ingest_size");
    }
    const response = await this.receiver(this.endpoint.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body,
    });
    if (
      !["inserted", "unchanged", "ignored_older", "corrected"].includes(String(response.status))
    ) {
      throw new Error("nws_receiver_response");
    }
  }

  async saveHealth(attempts: Json[]) {
    const response = await this.receiver("/api/source-health", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify(attempts),
    });
    if (!Number.isInteger(response.updated)) {
      throw new Error("nws_receiver_response");
    }
  }
}

function attempt(
  sourceId: string,
  displayName: string,
  now: number,
  success: boolean,
  rowCount: number,
  stale: boolean,
  sourceTimestamp?: number,
  error?: string,
): Json {
  return {
    attempted_at: now,
    display_name: displayName,
    expected_interval_seconds: sourceId === "nws_alerts_tx" ? 60 : 900,
    publication_interval_seconds: sourceId === "nws_alerts_tx" ? 60 : 900,
    publication_mode: "polling",
    row_count: rowCount,
    source_id: sourceId,
    success: success && !stale,
    ...(success && !stale
      ? rowCount === 0
        ? { availability_status: "empty" }
        : { availability_status: "available" }
      : {}),
    ...(sourceTimestamp
      ? {
          data_timestamp_ts: sourceTimestamp,
          source_timestamp_ts: sourceTimestamp,
        }
      : {}),
    ...(stale ? { error: "nws_stale_cache" } : error ? { error } : {}),
    diagnostics: { cache_state: stale ? "stale_if_error" : "validated" },
  };
}

function errorCode(error: unknown) {
  return error instanceof Error && /^nws_[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "nws_cycle_failed";
}

export async function runNwsWeatherCycle(transport: NwsWeatherTransport, now: number) {
  const attempts: Json[] = [];
  const failures: string[] = [];
  const forecastPoints = [];
  let forecastRows = 0;
  let forecastUpdatedAt = 0;
  let forecastError: string | null = null;
  for (const pointId of Object.keys(NWS_WEATHER_POINTS) as NwsPointId[]) {
    try {
      const mapping = await transport.point(pointId, now);
      if (mapping.stale) throw new Error("nws_stale_cache");
      const grid = await transport.grid(pointId, mapping.value, now);
      if (grid.stale) throw new Error("nws_stale_cache");
      forecastRows += Object.values(grid.value.layers).reduce(
        (total, layer) => total + layer.values.length,
        0,
      );
      forecastUpdatedAt = Math.max(forecastUpdatedAt, grid.value.source_updated_at);
      forecastPoints.push(
        buildNwsForecastPoint(mapping.value, grid.value, grid.validatedAt, grid.freshUntil),
      );
    } catch (error) {
      const code = errorCode(error);
      failures.push(code);
      forecastError ??= `${code}_${pointId.toLowerCase()}`;
    }
  }
  if (forecastPoints.length === Object.keys(NWS_WEATHER_POINTS).length) {
    try {
      await transport.ingest({
        points: forecastPoints,
        schema: NWS_WEATHER_SCHEMA,
        stream: "forecast",
      });
      attempts.push(
        attempt(
          "nws_grid_forecast",
          "NWS representative airport point forecasts",
          now,
          true,
          forecastRows,
          false,
          forecastUpdatedAt,
        ),
      );
    } catch (error) {
      const code = errorCode(error);
      failures.push(code);
      attempts.push(
        attempt(
          "nws_grid_forecast",
          "NWS representative airport point forecasts",
          now,
          false,
          0,
          false,
          undefined,
          code,
        ),
      );
    }
  } else {
    attempts.push(
      attempt(
        "nws_grid_forecast",
        "NWS representative airport point forecasts",
        now,
        false,
        0,
        false,
        undefined,
        forecastError ?? "nws_forecast_incomplete",
      ),
    );
  }
  try {
    const result = await transport.alerts(now);
    if (result.stale) throw new Error("nws_stale_cache");
    await transport.ingest({
      cache_fresh_until: result.freshUntil,
      collection_updated_at: result.value.collection_updated_at,
      items: result.value.items,
      retrieved_at: result.validatedAt,
      schema: NWS_WEATHER_SCHEMA,
      stream: "alerts",
      truncated: result.value.truncated,
    });
    attempts.push(
      attempt(
        "nws_alerts_tx",
        "NWS active Texas alerts",
        now,
        true,
        result.value.items.length,
        false,
        result.value.collection_updated_at,
      ),
    );
  } catch (error) {
    const code = errorCode(error);
    failures.push(code);
    attempts.push(
      attempt("nws_alerts_tx", "NWS active Texas alerts", now, false, 0, false, undefined, code),
    );
  }
  await transport.saveHealth(attempts);
  if (failures.length) throw new Error(failures[0]);
}

export function nwsWeatherRuntimeConfig(environment: { get(name: string): string | undefined }) {
  if (environment.get("NWS_WEATHER_INGEST_ENABLED") !== "true") {
    return { enabled: false as const };
  }
  const endpoint = environment.get("NWS_WEATHER_ENDPOINT");
  const apiKey = environment.get("METRICS_API_KEY");
  const userAgent = environment.get("NWS_WEATHER_USER_AGENT");
  if (!endpoint || !apiKey || !userAgent) throw new Error("nws_runtime_config");
  return { apiKey, enabled: true as const, endpoint, userAgent };
}

export async function startNwsWeather(): Promise<never> {
  const runtime = nwsWeatherRuntimeConfig(Deno.env);
  if (!runtime.enabled) return await new Promise(() => undefined);
  const transport = new HttpNwsWeatherTransport(
    runtime.endpoint,
    runtime.apiKey,
    runtime.userAgent,
  );
  for await (const _cycle of fixedInterval(60_000)) {
    try {
      await runNwsWeatherCycle(transport, Math.floor(Date.now() / 1_000));
    } catch {
      // Per-stream health was persisted; keep the long-running collector alive.
    }
  }
  return await new Promise(() => undefined);
}

if (import.meta.main) await startNwsWeather();
