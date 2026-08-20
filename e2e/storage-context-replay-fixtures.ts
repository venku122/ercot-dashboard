import type { Page } from "@playwright/test";

import { MARKET_SERIES, type MarketSeriesKey } from "../frontend/src/dashboard/market-mechanics";
import { FIXED_NOW_SECONDS, type MobileScenario } from "./mobile-fixtures";
import { installStorageOperationsApi } from "./storage-operations-fixtures";

function productFor(key: MarketSeriesKey): [string, string] {
  if (key === "market.sced.system-lambda") return ["ercot_mis_np6_322", "NP6-322-CD"];
  if (key.includes("price-adder") || key.includes("adder-input"))
    return ["ercot_mis_np6_323", "NP6-323-CD"];
  if (key.includes("as-capability")) return ["ercot_mis_np6_328", "NP6-328-CD"];
  return ["ercot_mis_np6_332", "NP6-332-CD"];
}

function rawSced(target: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "America/Chicago",
      year: "numeric",
    })
      .formatToParts(new Date(target * 1_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts["month"]}/${parts["day"]}/${parts["year"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
}

function source(key: MarketSeriesKey, target: number) {
  const [sourceId, productId] = productFor(key);
  return {
    document_id: productId === "NP6-322-CD" ? "322123" : "328123",
    issued_at: target + 2,
    product_id: productId,
    raw_publish_datetime: new Date((target + 2 - 5 * 3_600) * 1_000)
      .toISOString()
      .replace("Z", "-05:00"),
    raw_sced_timestamp: rawSced(target),
    repeated_hour_flag: false,
    source_id: sourceId,
    vintage_key: `mm1-${"b".repeat(64)}`,
  };
}

function snapshot(target: number, offset: number) {
  return {
    alignment: "exact_same_sced_timestamp",
    lambda_parity: { delta: 0, state: "match", tolerance: 0.00005 },
    readings: Object.fromEntries(
      (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key, index) => [
        key,
        {
          source: source(key, target),
          unit: MARKET_SERIES[key],
          value:
            key === "market.sced.system-lambda"
              ? offset === 0
                ? -18.75
                : 24.5
              : key === "market.sced.as-capability.regup-rrs-ecrs-nonspin"
                ? 4_125 + offset * 75
                : index + offset,
        },
      ]),
    ),
    target_ts: target,
  };
}

export async function installStorageContextReplayApi(
  page: Page,
  scenario: MobileScenario,
  batchRequests: string[][],
  marketRequests: string[],
) {
  await installStorageOperationsApi(page, scenario, batchRequests);
  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; since: number; until: number }>;
    };
    batchRequests.push(payload.queries.map((query) => query.id));
    await route.fulfill({
      json: {
        series: payload.queries.map((query) => {
          const step = query.metric.includes("Frequency") ? 60 : 300;
          const count = Math.min(1_200, Math.ceil((query.until - query.since) / step));
          const points = Array.from({ length: count }, (_, index) => {
            const wave = Math.sin(index / 5);
            const charging = -900 - wave * 500;
            const discharging = 450 + wave * 300;
            const value = query.metric.includes("Frequency")
              ? 60.001 + wave * 0.018
              : query.metric.includes("charging_mw")
                ? charging
                : query.metric.includes("discharging_mw")
                  ? discharging
                  : query.metric.includes("net_output_mw")
                    ? charging + discharging
                    : 1_200 + wave * 350;
            return [query.since + index * step, value];
          });
          return {
            id: query.id,
            meta: {
              bucket_seconds: step,
              max_points: 1_200,
              partial_current_bucket: true,
              since: query.since,
              stats: { count: points.length },
              until: query.until,
            },
            metric: query.metric,
            points,
          };
        }),
      },
    });
  });
  await page.route("**/api/v1/market-mechanics", (route) => {
    marketRequests.push(new URL(route.request().url()).pathname);
    const current = snapshot(FIXED_NOW_SECONDS - 602, 0);
    const previous = snapshot(FIXED_NOW_SECONDS - 902, -1);
    return route.fulfill({
      json: {
        changes: Object.fromEntries(
          (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key) => [
            key,
            {
              delta: current.readings[key].value - previous.readings[key].value,
              unit: MARKET_SERIES[key],
            },
          ]),
        ),
        current,
        deferred_products: ["NP6-331-CD", "NP6-86-CD"],
        elapsed_seconds: 300,
        explanation_policy: "time_adjacent_context_not_causal_decomposition",
        factors: {},
        kind: "market_mechanics_manifest",
        materialization_health: {
          consecutive_failures: 0,
          last_error: null,
          last_success_ts: FIXED_NOW_SECONDS - 30,
          state: "healthy",
        },
        methodology: "market-context-v1",
        previous,
        resources: [],
        schema_version: 1,
        source_health: [
          ["ercot_mis_np6_322", "healthy", current.target_ts],
          ["ercot_mis_np6_323", "healthy", current.target_ts],
          ["ercot_mis_np6_328", scenario === "failed" ? "failed" : "healthy", current.target_ts],
          ["ercot_mis_np6_332", "healthy", current.target_ts],
        ].map(([sourceId, state, observed]) => ({
          data_timestamp_ts: observed,
          gap_count: 0,
          last_error: state === "failed" ? "ercot_mis_np6_328" : null,
          source_id: sourceId,
          state,
        })),
      },
    });
  });
}
