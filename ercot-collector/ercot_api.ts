const DEFAULT_TOKEN_ENDPOINT =
  "https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token";
const DEFAULT_PUBLIC_BASE_URL = "https://api.ercot.com/api/";
const TOKEN_CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70";
const TOKEN_SCOPE = `openid ${TOKEN_CLIENT_ID} offline_access`;

export type ErcotApiKind = "public" | "esr";
export type ErcotQueryValue = string | number | boolean | Date | null | undefined;
export type ErcotQuery = Record<string, ErcotQueryValue | ErcotQueryValue[]>;
export type ErcotFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ErcotCredentials = {
  username: string;
  password: string;
  publicSubscriptionKey: string;
  esrSubscriptionKey: string;
};

export type ErcotClientOptions = {
  credentials: ErcotCredentials;
  fetch?: ErcotFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  maximumRetries?: number;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  tokenSafetyMarginMs?: number;
  tokenEndpoint?: string;
  publicBaseUrl?: string;
  esrBaseUrl?: string;
  requestsPerMinute?: number;
};

type JsonObject = Record<string, unknown>;

export class ErcotApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(code);
    this.name = "ErcotApiError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type ErcotPublicInventory = {
  reports: JsonObject[];
  raw: JsonObject | JsonObject[];
};

export type ErcotEsrResponse = {
  fields: ErcotFieldDefinition[];
  data: unknown[];
  _meta?: JsonObject;
  raw: JsonObject;
};

export type ErcotFieldDefinition = JsonObject & {
  name: string;
  dataType: string;
};

export type ErcotToken = {
  accessToken: string;
  expiresAt: number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded));
    const expiry = isObject(decoded) ? positiveNumber(decoded.exp) : null;
    return expiry === null ? null : expiry * 1_000;
  } catch {
    return null;
  }
}

function abortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function secureUrl(value: string, code: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ErcotApiError(code);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ErcotApiError(code);
  }
  if (url.username || url.password) throw new ErcotApiError(code);
  return url;
}

function normalizeBaseUrl(value: string): URL {
  const url = secureUrl(value, "ercot_invalid_base_url");
  if (url.search || url.hash) throw new ErcotApiError("ercot_invalid_base_url");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function normalizeTokenEndpoint(value: string): string {
  const url = secureUrl(value, "ercot_invalid_token_endpoint");
  if (url.hash) throw new ErcotApiError("ercot_invalid_token_endpoint");
  return url.toString();
}

function pathInsideBase(url: URL, base: URL): boolean {
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return url.pathname === basePath.slice(0, -1) || url.pathname.startsWith(basePath);
}

function queryUrl(base: URL, pathOrUrl: string, query: ErcotQuery = {}): URL {
  const url = pathOrUrl.startsWith("/")
    ? new URL(pathOrUrl, base.origin)
    : new URL(pathOrUrl, base);
  if (url.origin !== base.origin) {
    throw new ErcotApiError("ercot_cross_origin_url_rejected");
  }
  if (!pathInsideBase(url, base)) {
    throw new ErcotApiError("ercot_api_namespace_rejected");
  }
  for (const key of Object.keys(query).sort()) {
    const rawValues = Array.isArray(query[key]) ? query[key] : [query[key]];
    for (const raw of rawValues) {
      if (raw === null || raw === undefined) continue;
      const value = raw instanceof Date ? raw.toISOString() : String(raw);
      url.searchParams.append(key, value);
    }
  }
  return url;
}

function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function boundedDelay(
  retry: number,
  retryBaseMs: number,
  maximumRetryDelayMs: number,
  random: () => number,
  requestedDelay: number | null = null,
): number {
  const exponential = retryBaseMs * 2 ** retry;
  const randomValue = random();
  const safeRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
  const jitter = exponential * 0.25 * safeRandom;
  return Math.max(0, Math.min(maximumRetryDelayMs, requestedDelay ?? exponential + jitter));
}

function integerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function validatePublicInventory(value: unknown): ErcotPublicInventory {
  let reports: unknown;
  if (Array.isArray(value)) {
    reports = value;
  } else if (isObject(value)) {
    const embedded = value._embedded;
    reports =
      isObject(embedded) && Array.isArray(embedded.products)
        ? embedded.products
        : (value.data ?? value.reports ?? value.products);
  }
  if (!Array.isArray(reports) || !reports.every(isObject)) {
    throw new ErcotApiError("ercot_public_inventory_schema_invalid");
  }
  return { reports, raw: value as JsonObject | JsonObject[] };
}

export function validateEsrResponse(value: unknown): ErcotEsrResponse {
  if (!isObject(value) || !Array.isArray(value.fields) || !Array.isArray(value.data)) {
    throw new ErcotApiError("ercot_esr_schema_invalid");
  }
  const fields = value.fields;
  if (
    fields.length === 0 ||
    !fields.every(
      (field): field is ErcotFieldDefinition =>
        isObject(field) &&
        typeof field.name === "string" &&
        field.name.trim().length > 0 &&
        typeof field.dataType === "string" &&
        field.dataType.trim().length > 0,
    )
  ) {
    throw new ErcotApiError("ercot_esr_schema_invalid");
  }
  const fieldNames = fields.map((field) => field.name);
  if (new Set(fieldNames).size !== fieldNames.length) {
    throw new ErcotApiError("ercot_esr_schema_invalid");
  }
  const expectedNames = new Set(fieldNames);
  for (const row of value.data) {
    if (Array.isArray(row)) {
      if (row.length !== fields.length) throw new ErcotApiError("ercot_esr_schema_invalid");
      continue;
    }
    if (!isObject(row)) throw new ErcotApiError("ercot_esr_schema_invalid");
    const keys = Object.keys(row);
    if (keys.length !== fields.length || keys.some((key) => !expectedNames.has(key))) {
      throw new ErcotApiError("ercot_esr_schema_invalid");
    }
  }
  if (value._meta !== undefined && !isObject(value._meta)) {
    throw new ErcotApiError("ercot_esr_schema_invalid");
  }
  return {
    fields,
    data: value.data,
    _meta: value._meta,
    raw: value,
  };
}

function linkHrefs(value: unknown, result: string[]): void {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) linkHrefs(entry, result);
  } else if (isObject(value)) {
    if (typeof value.href === "string") result.push(value.href);
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "href") linkHrefs(entry, result);
    }
  }
}

/** Returns every href advertised by the product-level `_links` object. */
export function publicReportHrefs(report: JsonObject): string[] {
  const result: string[] = [];
  linkHrefs(report._links, result);
  return [...new Set(result)];
}

/** Returns only API endpoint hrefs attached to the product's artifact records. */
export function publicReportArtifactLinks(report: JsonObject): string[] {
  if (!Array.isArray(report.artifacts)) return [];
  const result: string[] = [];
  for (const artifact of report.artifacts) {
    if (!isObject(artifact) || !isObject(artifact._links)) {
      throw new ErcotApiError("ercot_public_artifact_schema_invalid");
    }
    const endpoint = artifact._links.endpoint;
    if (!isObject(endpoint) || typeof endpoint.href !== "string" || !endpoint.href) {
      throw new ErcotApiError("ercot_public_artifact_schema_invalid");
    }
    result.push(endpoint.href);
  }
  return result;
}

export class ErcotRateLimiter {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #nextStart = 0;

  constructor(
    requestsPerMinute = 30,
    now: () => number = Date.now,
    sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 30) {
      throw new ErcotApiError("ercot_invalid_rate_limit");
    }
    this.#intervalMs = 60_000 / requestsPerMinute;
    this.#now = now;
    this.#sleep = sleep;
  }

  async acquire(): Promise<void> {
    const now = this.#now();
    const start = Math.max(now, this.#nextStart);
    this.#nextStart = start + this.#intervalMs;
    if (start > now) await this.#sleep(start - now);
  }
}

class ErcotTokenManager {
  readonly #credentials: ErcotCredentials;
  readonly #fetch: ErcotFetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #safetyMarginMs: number;
  readonly #tokenEndpoint: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maximumRetries: number;
  readonly #retryBaseMs: number;
  readonly #maximumRetryDelayMs: number;
  #token: ErcotToken | null = null;
  #refreshing: Promise<ErcotToken> | null = null;

  constructor(
    options: Required<
      Pick<
        ErcotClientOptions,
        | "credentials"
        | "timeoutMs"
        | "tokenSafetyMarginMs"
        | "tokenEndpoint"
        | "maximumRetries"
        | "retryBaseMs"
        | "maximumRetryDelayMs"
      >
    > & {
      fetch: ErcotFetch;
      now: () => number;
      sleep: (milliseconds: number) => Promise<void>;
      random: () => number;
    },
  ) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#timeoutMs = options.timeoutMs;
    this.#safetyMarginMs = options.tokenSafetyMarginMs;
    this.#tokenEndpoint = options.tokenEndpoint;
    this.#sleep = options.sleep;
    this.#random = options.random;
    this.#maximumRetries = options.maximumRetries;
    this.#retryBaseMs = options.retryBaseMs;
    this.#maximumRetryDelayMs = options.maximumRetryDelayMs;
  }

  async get(): Promise<ErcotToken> {
    if (this.#token && this.#token.expiresAt - this.#safetyMarginMs > this.#now()) {
      return this.#token;
    }
    return await this.#refresh();
  }

  async afterUnauthorized(failedAccessToken: string): Promise<ErcotToken> {
    if (this.#token?.accessToken === failedAccessToken) this.#token = null;
    return await this.get();
  }

  async #refresh(): Promise<ErcotToken> {
    if (this.#refreshing) return await this.#refreshing;
    this.#refreshing = this.#acquire();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async #acquire(): Promise<ErcotToken> {
    const body = new URLSearchParams({
      username: this.#credentials.username,
      password: this.#credentials.password,
      grant_type: "password",
      scope: TOKEN_SCOPE,
      client_id: TOKEN_CLIENT_ID,
      response_type: "id_token",
    });
    let retry = 0;
    while (true) {
      try {
        const token = await this.#attempt(body);
        this.#token = token;
        return token;
      } catch (error) {
        if (
          !(error instanceof ErcotApiError) ||
          !error.retryable ||
          retry >= this.#maximumRetries
        ) {
          throw error;
        }
        const delay = boundedDelay(
          retry++,
          this.#retryBaseMs,
          this.#maximumRetryDelayMs,
          this.#random,
          error.retryAfterMs ?? null,
        );
        await this.#sleep(delay);
      }
    }
  }

  async #attempt(body: URLSearchParams): Promise<ErcotToken> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const retryDelay = retryable ? retryAfterMs(response, this.#now()) : null;
        await response.body?.cancel();
        throw new ErcotApiError("ercot_auth_failed", {
          status: response.status,
          retryable,
          retryAfterMs: retryDelay ?? undefined,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (abortError(error) || controller.signal.aborted) {
          throw new ErcotApiError("ercot_auth_timeout", { retryable: true });
        }
        throw new ErcotApiError("ercot_auth_response_invalid");
      }
      if (!isObject(payload) || typeof payload.access_token !== "string" || !payload.access_token) {
        throw new ErcotApiError("ercot_auth_response_invalid");
      }
      const duration = positiveNumber(payload.expires_in);
      const expiresAt =
        duration === null ? jwtExpiry(payload.access_token) : this.#now() + duration * 1_000;
      if (expiresAt === null || expiresAt <= this.#now()) {
        throw new ErcotApiError("ercot_auth_expiry_invalid");
      }
      return { accessToken: payload.access_token, expiresAt };
    } catch (error) {
      if (error instanceof ErcotApiError) throw error;
      throw new ErcotApiError(
        abortError(error) || controller.signal.aborted
          ? "ercot_auth_timeout"
          : "ercot_auth_network_error",
        { retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ErcotApiClient {
  readonly #credentials: ErcotCredentials;
  readonly #fetch: ErcotFetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #timeoutMs: number;
  readonly #maximumRetries: number;
  readonly #retryBaseMs: number;
  readonly #maximumRetryDelayMs: number;
  readonly #publicBase: URL;
  readonly #esrBase: URL;
  readonly #limiter: ErcotRateLimiter;
  readonly #tokens: ErcotTokenManager;

  constructor(options: ErcotClientOptions) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maximumRetries = options.maximumRetries ?? 3;
    const retryBaseMs = options.retryBaseMs ?? 500;
    const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
    const tokenSafetyMarginMs = options.tokenSafetyMarginMs ?? 60_000;
    if (!integerInRange(timeoutMs, 1, 300_000)) {
      throw new ErcotApiError("ercot_invalid_timeout");
    }
    if (!integerInRange(maximumRetries, 0, 10)) {
      throw new ErcotApiError("ercot_invalid_maximum_retries");
    }
    if (!integerInRange(retryBaseMs, 1, 60_000)) {
      throw new ErcotApiError("ercot_invalid_retry_base");
    }
    if (!integerInRange(maximumRetryDelayMs, retryBaseMs, 300_000)) {
      throw new ErcotApiError("ercot_invalid_maximum_retry_delay");
    }
    if (!integerInRange(tokenSafetyMarginMs, 0, 3_600_000)) {
      throw new ErcotApiError("ercot_invalid_token_safety_margin");
    }
    for (const value of Object.values(options.credentials)) {
      if (typeof value !== "string" || value.length === 0) {
        throw new ErcotApiError("ercot_invalid_credentials");
      }
    }
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#timeoutMs = timeoutMs;
    this.#maximumRetries = maximumRetries;
    this.#retryBaseMs = retryBaseMs;
    this.#maximumRetryDelayMs = maximumRetryDelayMs;
    this.#publicBase = normalizeBaseUrl(options.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL);
    this.#esrBase = normalizeBaseUrl(options.esrBaseUrl ?? DEFAULT_PUBLIC_BASE_URL);
    this.#limiter = new ErcotRateLimiter(options.requestsPerMinute ?? 30, this.#now, this.#sleep);
    this.#tokens = new ErcotTokenManager({
      credentials: options.credentials,
      fetch: this.#fetch,
      now: this.#now,
      sleep: this.#sleep,
      random: this.#random,
      timeoutMs,
      maximumRetries,
      retryBaseMs,
      maximumRetryDelayMs,
      tokenSafetyMarginMs,
      tokenEndpoint: normalizeTokenEndpoint(options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT),
    });
  }

  async publicReports(): Promise<ErcotPublicInventory> {
    return validatePublicInventory(await this.#request("public", "public-reports"));
  }

  async publicArtifact<T = unknown>(
    report: JsonObject,
    advertisedHref: string,
    query: ErcotQuery = {},
  ): Promise<T> {
    if (!publicReportArtifactLinks(report).includes(advertisedHref)) {
      throw new ErcotApiError("ercot_public_artifact_link_not_advertised");
    }
    return (await this.#request("public", advertisedHref, query)) as T;
  }

  async esrCharging(query: {
    AGCExecTimeFrom: string;
    AGCExecTimeTo: string;
  }): Promise<ErcotEsrResponse> {
    if (!query.AGCExecTimeFrom || !query.AGCExecTimeTo) {
      throw new ErcotApiError("ercot_esr_bounds_required");
    }
    return validateEsrResponse(
      await this.#request("esr", "public-data/rptesr-m/4_sec_esr_charging_mw", query),
    );
  }

  async #request(kind: ErcotApiKind, pathOrUrl: string, query: ErcotQuery = {}): Promise<unknown> {
    const base = kind === "public" ? this.#publicBase : this.#esrBase;
    const url = queryUrl(base, pathOrUrl, query);
    const subscriptionKey =
      kind === "public"
        ? this.#credentials.publicSubscriptionKey
        : this.#credentials.esrSubscriptionKey;
    let token = await this.#tokens.get();
    let unauthorizedRetried = false;
    let retry = 0;

    while (true) {
      await this.#limiter.acquire();
      let result: { payload?: unknown; response: Response };
      try {
        result = await this.#fetchJsonWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            "Ocp-Apim-Subscription-Key": subscriptionKey,
            Accept: "application/json",
          },
          redirect: "manual",
        });
      } catch (error) {
        if (error instanceof ErcotApiError && !error.retryable) throw error;
        const timeout =
          error instanceof ErcotApiError
            ? error.code === "ercot_request_timeout"
            : abortError(error);
        if (retry < this.#maximumRetries) {
          await this.#backoff(retry++);
          continue;
        }
        throw new ErcotApiError(timeout ? "ercot_request_timeout" : "ercot_request_network_error", {
          retryable: true,
        });
      }
      const { response } = result;

      if (response.status === 401 && !unauthorizedRetried) {
        await response.body?.cancel();
        unauthorizedRetried = true;
        token = await this.#tokens.afterUnauthorized(token.accessToken);
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && retry < this.#maximumRetries) {
        const requestedDelay = retryAfterMs(response, this.#now());
        await response.body?.cancel();
        await this.#backoff(retry++, requestedDelay);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ErcotApiError(`ercot_http_${response.status}`, {
          status: response.status,
          retryable,
        });
      }

      return result.payload;
    }
  }

  async #fetchJsonWithTimeout(
    url: URL,
    init: RequestInit,
  ): Promise<{ payload?: unknown; response: Response }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) return { response };
      try {
        return { response, payload: await response.json() };
      } catch (error) {
        if (abortError(error) || controller.signal.aborted) {
          throw new ErcotApiError("ercot_request_timeout", { retryable: true });
        }
        throw new ErcotApiError("ercot_response_json_invalid");
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async #backoff(retry: number, requestedDelay: number | null = null): Promise<void> {
    await this.#sleep(
      boundedDelay(
        retry,
        this.#retryBaseMs,
        this.#maximumRetryDelayMs,
        this.#random,
        requestedDelay,
      ),
    );
  }
}
