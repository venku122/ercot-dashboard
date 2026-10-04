import type { Page } from "@playwright/test";

export type ArchivedForecastScenario = "normal" | "empty" | "error" | "missing-archive";

/** Authored synthetic NP3-565 systemTotal, independent of observed demand fixtures. */
export function archivedForecastValue(target: number): number {
  return 70_500 + ((target / 3600) % 24) * 37;
}

export async function installArchivedForecastApi(
  page: Page,
  fixtureNow: number,
  scenario: ArchivedForecastScenario = "normal",
) {
  await page.route("**/api/v1/historical-forecast?**", async (route) => {
    if (scenario === "error" || scenario === "missing-archive") {
      await route.fulfill({
        status: scenario === "error" ? 503 : 404,
        json: { error: `synthetic_${scenario}` },
      });
      return;
    }
    const url = new URL(route.request().url());
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    const asOf = Number(url.searchParams.get("as_of"));
    if (
      route.request().method() !== "GET" ||
      ![start, end, asOf].every(Number.isSafeInteger) ||
      end <= start ||
      end - start > 366 * 86400 ||
      url.searchParams.get("policy") !== "issued_before_delivery"
    ) {
      await route.fulfill({ status: 400, json: { error: "synthetic_invalid_forecast_window" } });
      return;
    }
    const expected = Math.max(0, Math.floor((end - 1) / 3600) - Math.ceil(start / 3600) + 1);
    const rows = [];
    if (scenario !== "empty") {
      for (let target = Math.ceil(start / 3600) * 3600; target < end; target += 3600) {
        const issued = target - 7200;
        if (issued > asOf || issued > fixtureNow - 137) continue;
        rows.push({
          target_ts: target,
          interval_start: target - 3600,
          interval_end: target,
          issued_at: issued,
          retrieved_at: fixtureNow - 137,
          first_seen_at: fixtureNow - 113,
          vintage_key: `synthetic-np3-565-pre-delivery-${issued}`,
          model: "SYNTHETIC_FIXTURE_MODEL",
          value: archivedForecastValue(target),
          unit: "MW",
        });
      }
    }
    await route.fulfill({
      json: {
        product_id: "NP3-565-CD",
        measure: "systemTotal",
        policy: "issued_before_delivery",
        as_of: asOf,
        target_start: start,
        target_end: end,
        rows,
        availability: rows.length ? "available" : "no_eligible_archived_vintage",
        system_knowledge_claim: false,
        fixture_provenance:
          "Authored synthetic pre-delivery hourly forecast; fixture-clock retrieval is retrospective, not as-known evidence or a production capture.",
        coverage: {
          expected_target_count: expected,
          selected_target_count: rows.length,
          available_value_count: rows.length,
          missing_value_count: expected - rows.length,
          truncated: false,
        },
      },
    });
  });
}
