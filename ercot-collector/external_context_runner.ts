import { fixedInterval } from "./deps.ts";
import {
  EGRID_DISCOVERY_URL,
  EXTERNAL_CONTEXT_KIND,
  parseEgridDiscovery,
  parseEgridWorkbook,
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
): Promise<void> {
  const target = new URL(endpoint);
  target.pathname = "/api/external-context/source-attempt";
  await receiverPost(dependencies, target, apiKey, {
    schema: 1,
    kind: EXTERNAL_CONTEXT_KIND,
    stream: "epa_egrid",
    attempted_at: attemptedAt,
    status: "failed",
    reason: reason.slice(0, 200),
  });
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
) {
  if (dependencies.environment.get("EXTERNAL_CONTEXT_INGEST_ENABLED") !== "true") return;
  const endpoint =
    dependencies.environment.get("EXTERNAL_CONTEXT_ENDPOINT") ??
    "http://receiver:8080/api/external-context/ingest";
  const apiKey = dependencies.environment.get("METRICS_API_KEY") ?? "";
  for await (const _cycle of fixedInterval(7 * 86_400_000)) {
    try {
      await runExternalContextCycle(endpoint, apiKey, Math.floor(Date.now() / 1000), dependencies);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "external_context_cycle_failed");
    }
  }
}
