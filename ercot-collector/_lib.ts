export * from "./deps.ts";
import {
  DatadogApi,
  MetricSubmission,
  fixedInterval,
} from "./deps.ts";

const metricsEndpoint = Deno.env.get("METRICS_ENDPOINT");
const metricsApiKey = Deno.env.get("METRICS_API_KEY");
let datadog: DatadogApi | null = null;

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

export function headers(accept = 'text/html') {
  return {
    headers: {
      'Accept': accept,
      'User-Agent': `Deno/${Deno.version} (+https://p.datadoghq.com/sb/5c2fc00be-393be929c9c55c3b80b557d08c30787a)`,
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
        points: [{value: dutyCycle*100}],
        tags: [`app:${loopName}`],
        interval: 60,
        metric_type: 'gauge',
      });

      // Submit all metrics
      try {
        await submitMetrics(data);
      } catch (err) {
        console.log(new Date().toISOString(), 'eh', err.message);
        await submitMetrics(data);
      }

    } catch (err) {
      console.log(new Date().toISOString(), '!!', err.message);
    }
  }
};
