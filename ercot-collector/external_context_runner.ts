import { fixedInterval } from "./deps.ts";
import {
  configuredEiaKey,
  EIA930_SOURCE_URL,
  EGRID_DISCOVERY_URL,
  EXTERNAL_CONTEXT_KIND,
  HENRY_HUB_SOURCE_URL,
  parseEia930Response,
  parseEgridDiscovery,
  parseEgridWorkbook,
  parseHenryHubResponse,
} from "./external_context.ts";

type Environment = { get(name: string): string | undefined };
type RunnerDependencies = Readonly<{
  environment: Environment;
  fetcher: typeof fetch;
}>;

const DEFAULT_DEPENDENCIES: RunnerDependencies = { environment: Deno.env, fetcher: fetch };

function endpointUrl(value: string): URL {
  const url = new URL(value);
  const local = ["receiver", "localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (!local && url.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(url.protocol))
  )
    throw new Error("external_context_endpoint_scheme");
  if (url.pathname !== "/api/external-context/ingest" || url.search || url.hash)
    throw new Error("external_context_endpoint_path");
  return url;
}

async function bounded(response: Response, maximum: number, code: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(code);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error(code);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximum) throw new Error(code);
  return bytes;
}

async function upstream(
  dependencies: RunnerDependencies,
  url: string,
  accept: string,
  maximum: number,
): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "www.epa.gov" ||
    parsed.username ||
    parsed.password
  )
    throw new Error("external_context_upstream_url");
  return await bounded(
    await dependencies.fetcher(url, {
      headers: { Accept: accept },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
    maximum,
    "external_context_upstream_failed",
  );
}

async function eiaJson(
  dependencies: RunnerDependencies,
  base: string,
  apiKey: string,
  parameters: URLSearchParams,
): Promise<unknown> {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.hostname !== "api.eia.gov")
    throw new Error("external_context_eia_url");
  parameters.set("api_key", apiKey);
  url.search = parameters.toString();
  let response: Response;
  try {
    response = await dependencies.fetcher(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("external_context_eia_fetch_failed");
  }
  if (response.status === 401 || response.status === 403)
    throw new Error("external_context_eia_auth_rejected");
  const bytes = await bounded(response, 2 * 1024 * 1024, "external_context_eia_fetch_failed");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("external_context_eia_schema");
  }
}

async function receiverPost(
  dependencies: RunnerDependencies,
  endpoint: URL,
  apiKey: string,
  payload: unknown,
): Promise<void> {
  const response = await dependencies.fetcher(endpoint, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("external_context_receiver_rejected");
  const body = await response.json();
  if (!body || typeof body !== "object" || !("status" in body))
    throw new Error("external_context_receiver_response");
}

async function reportFailure(
  dependencies: RunnerDependencies,
  endpoint: URL,
  apiKey: string,
  attemptedAt: number,
  reason: string,
  stream = "epa_egrid",
): Promise<void> {
  const target = new URL(endpoint);
  target.pathname = "/api/external-context/source-attempt";
  await receiverPost(dependencies, target, apiKey, {
    schema: 1,
    kind: EXTERNAL_CONTEXT_KIND,
    stream,
    attempted_at: attemptedAt,
    status: "failed",
    reason: reason.slice(0, 200),
  });
}

function eia930Parameters(retrievedAt: number): URLSearchParams {
  const start = new Date((retrievedAt - 72 * 3_600) * 1_000).toISOString().slice(0, 13);
  const end = new Date(retrievedAt * 1_000).toISOString().slice(0, 13);
  return new URLSearchParams([
    ["frequency", "hourly"],
    ["data[]", "value"],
    ["facets[respondent][]", "ERCO"],
    ["facets[type][]", "D"],
    ["facets[type][]", "TI"],
    ["start", start],
    ["end", end],
    ["sort[0][column]", "period"],
    ["sort[0][direction]", "asc"],
    ["offset", "0"],
    ["length", "200"],
  ]);
}

function henryHubParameters(retrievedAt: number): URLSearchParams {
  const end = new Date(retrievedAt * 1_000).toISOString().slice(0, 10);
  const start = new Date((retrievedAt - 35 * 86_400) * 1_000).toISOString().slice(0, 10);
  return new URLSearchParams([
    ["start", start],
    ["end", end],
    ["sort[0][column]", "period"],
    ["sort[0][direction]", "asc"],
    ["offset", "0"],
    ["length", "25"],
  ]);
}

export async function runEiaExternalContextCycle(
  endpoint: string,
  apiKey: string,
  eiaApiKey: string,
  retrievedAt: number,
  dependencies: RunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const target = endpointUrl(endpoint);
  const key = configuredEiaKey(eiaApiKey);
  if (!key) return;
  const products = [
    {
      stream: "eia930_demand",
      collect: async () =>
        parseEia930Response(
          await eiaJson(dependencies, EIA930_SOURCE_URL, key, eia930Parameters(retrievedAt)),
          retrievedAt,
        ),
    },
    {
      stream: "henry_hub_daily",
      collect: async () =>
        parseHenryHubResponse(
          await eiaJson(dependencies, HENRY_HUB_SOURCE_URL, key, henryHubParameters(retrievedAt)),
          retrievedAt,
        ),
    },
  ] as const;
  const failures: Error[] = [];
  for (const product of products) {
    try {
      await receiverPost(dependencies, target, apiKey, await product.collect());
    } catch (error) {
      const reason = error instanceof Error ? error.message : "external_context_unknown_failure";
      await reportFailure(dependencies, target, apiKey, retrievedAt, reason, product.stream);
      failures.push(error instanceof Error ? error : new Error(reason));
    }
  }
  if (failures.length) throw failures[0];
}

export async function runExternalContextCycle(
  endpoint: string,
  apiKey: string,
  retrievedAt: number,
  dependencies: RunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!apiKey) throw new Error("external_context_receiver_key");
  const target = endpointUrl(endpoint);
  try {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(
      await upstream(dependencies, EGRID_DISCOVERY_URL, "text/html", 2 * 1024 * 1024),
    );
    const discovery = parseEgridDiscovery(html);
    const workbook = await upstream(
      dependencies,
      discovery.artifact_url,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      2 * 1024 * 1024,
    );
    await receiverPost(
      dependencies,
      target,
      apiKey,
      await parseEgridWorkbook(workbook, discovery, retrievedAt),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "external_context_unknown_failure";
    await reportFailure(dependencies, target, apiKey, retrievedAt, reason);
    throw error;
  }
}

export async function startExternalContext(
  dependencies: RunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<never> {
  if (dependencies.environment.get("EXTERNAL_CONTEXT_INGEST_ENABLED") !== "true") {
    return await new Promise<never>(() => {});
  }
  const endpoint =
    dependencies.environment.get("EXTERNAL_CONTEXT_ENDPOINT") ??
    "http://receiver:8080/api/external-context/ingest";
  const apiKey = dependencies.environment.get("METRICS_API_KEY") ?? "";
  const eiaApiKey = dependencies.environment.get("EIA_API_KEY") ?? "";
  await Promise.all([
    (async () => {
      for await (const _cycle of fixedInterval(7 * 86_400_000)) {
        try {
          await runExternalContextCycle(
            endpoint,
            apiKey,
            Math.floor(Date.now() / 1000),
            dependencies,
          );
        } catch (error) {
          console.error(error instanceof Error ? error.message : "external_context_cycle_failed");
        }
      }
    })(),
    (async () => {
      if (!configuredEiaKey(eiaApiKey)) return await new Promise<never>(() => {});
      for await (const _cycle of fixedInterval(3_600_000)) {
        try {
          await runEiaExternalContextCycle(
            endpoint,
            apiKey,
            eiaApiKey,
            Math.floor(Date.now() / 1000),
            dependencies,
          );
        } catch (error) {
          console.error(
            error instanceof Error ? error.message : "external_context_eia_cycle_failed",
          );
        }
      }
    })(),
  ]);
  throw new Error("external_context_loops_ended");
}
