import type { Page } from "@playwright/test";

import { installMobileApi, type MobileScenario } from "./mobile-fixtures";

function storageValue(metric: string, index: number) {
  const wave = Math.sin(index / 5);
  const charging = -900 - wave * 500;
  const discharging = 450 + wave * 300;
  if (metric.includes("discharging_mw")) return discharging;
  if (metric.includes("charging_mw")) return charging;
  if (metric.includes("net_output_mw")) return charging + discharging;
  return 1_200 + wave * 350;
}

/** Installs the shared browser API and rebinds series batches to a coherent storage oracle. */
export async function installStorageOperationsApi(
  page: Page,
  scenario: MobileScenario,
  requests: string[][],
) {
  await installMobileApi(page, scenario, []);
  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; since: number; until: number }>;
    };
    requests.push(payload.queries.map((query) => query.id));
    const series = payload.queries.map((query) => {
      const count = query.id.includes("compare") ? 42 : 64;
      const step = Math.max(60, Math.floor((query.until - query.since) / (count - 1)));
      const points = Array.from({ length: count }, (_, index) => [
        query.since + index * step,
        storageValue(query.metric, index),
      ]);
      const values = points.map((point) => Number(point[1]));
      return {
        id: query.id,
        metric: query.metric,
        points,
        meta: {
          since: query.since,
          until: query.until,
          max_points: 1_200,
          bucket_seconds: step,
          partial_current_bucket: !query.id.includes("compare"),
          stats: {
            average: values.reduce((sum, value) => sum + value, 0) / values.length,
            count: values.length,
            energy_mwh: query.metric.endsWith("_mw") ? 412.5 : null,
            latest: values.at(-1),
            maximum: Math.max(...values),
            minimum: Math.min(...values),
          },
        },
      };
    });
    await route.fulfill({ json: { series } });
  });
}
