export * from "./deps.ts";
import { DatadogApi, MetricSubmission, fetch as instrumentedFetch, fixedInterval } from "./deps.ts";

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
    return await instrumentedFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function getDatadog(): DatadogApi {
  if (!datadog) datadog = DatadogApi.fromEnvironment(Deno.env);
  return datadog;
}

async function submitMetrics(data: MetricSubmission[]) {
  if (metricsEndpoint) {
    const resp = await fetch(metricsEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(metricsApiKey ? { "X-API-Key": metricsApiKey } : {}),
      },
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`metrics endpoint ${resp.status}: ${text}`);
    }
    return;
  }
  await getDatadog().v1Metrics.submit(data);
}

export function headers(accept = "text/html") {
  return {
    headers: {
      Accept: accept,
      "User-Agent": `Deno/${Deno.version} (+https://p.datadoghq.com/sb/5c2fc00be-393be929c9c55c3b80b557d08c30787a)`,
    },
  };
}

export async function runMetricsLoop(
  gather: () => Promise<MetricSubmission[]>,
  intervalMinutes: number,
  loopName: string,
) {
  for await (const dutyCycle of fixedInterval(intervalMinutes * 60 * 1000)) {
    try {
      const data = await gather();

      // Our own loop-health metric
      data.push({
        metric_name: `ercot.app.duty_cycle`,
        points: [{ value: dutyCycle * 100 }],
        tags: [`app:${loopName}`],
        interval: 60,
        metric_type: "gauge",
      });

      // Submit all metrics
      try {
        await submitMetrics(data);
      } catch (err) {
        console.log(new Date().toISOString(), "eh", err.message);
        await submitMetrics(data);
      }
    } catch (err) {
      console.log(new Date().toISOString(), "!!", err.message);
    }
  }
}
