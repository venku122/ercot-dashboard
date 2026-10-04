import { installArchivedForecastApi } from "./archived-forecast-fixtures";
import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390, 768, 1440]) {
  for (const hours of [6, 24, 168]) {
    test(`ERP-04 normal shared archive publishes ${hours}h forecast at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await installMobileApi(page, "normal", [], { nativeCadence: true });
      const legacyForecastQueries: string[] = [];
      await page.route("**/api/series/batch", async (route) => {
        const body = route.request().postDataJSON() as {
          queries: Array<{ id: string; metric: string }>;
        };
        legacyForecastQueries.push(
          ...body.queries
            .filter((query) => query.id.startsWith("supply-demand:forecast-demand"))
            .map((query) => query.id),
        );
        const retired = body.queries.filter((query) =>
          query.id.startsWith("supply-demand:forecast-demand"),
        );
        if (retired.length) {
          await route.fulfill({
            json: {
              series: retired.map((query) => ({
                id: query.id,
                metric: query.metric,
                points: [[FIXED_NOW_SECONDS + 3600, 999_999]],
                meta: { fixture_provenance: "counterfactual synthetic current future snapshot" },
              })),
            },
          });
          return;
        }
        await route.fallback();
      });
      const archives: import("@playwright/test").Response[] = [];
      page.on("response", (response) => {
        if (response.url().includes("/api/v1/historical-forecast?")) archives.push(response);
      });
      await page.goto(`/?view=overview&range=${hours * 3600}&live=1&legend=expanded`);
      const card = page.locator('[data-chart-id="supply-demand"]');
      await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      expect(archives).toHaveLength(1);
      expect(archives[0]!.status()).toBe(200);
      const forecast = card
        .getByRole("table", { name: "Supply and demand series statistics" })
        .getByRole("row")
        .filter({ hasText: "Forecast issued before delivery" });
      await expect(forecast.getByRole("cell").nth(1)).toContainText("71.4 GW");
      await card.getByText("Accessible data table", { exact: true }).click();
      const rows = card
        .locator(".accessible-data tbody tr")
        .filter({ hasText: "Forecast issued before delivery" });
      // The source target-window contract includes the left ending-hour edge.
      // Rendering may remove that non-overlapping edge under delivery-interval policy.
      expect(await rows.count()).toBeGreaterThanOrEqual(hours);
      expect(await rows.count()).toBeLessThanOrEqual(hours + 1);
      const payload = await archives[0]!.json();
      expect(payload.coverage.expected_target_count).toBe(hours + 1);
      expect(payload.coverage.available_value_count).toBe(hours + 1);
      expect(payload.coverage.missing_value_count).toBe(0);
      expect(payload.rows).toHaveLength(hours + 1);
      for (const row of payload.rows) {
        expect(row.target_ts % 3600).toBe(0);
        expect(row.interval_end).toBe(row.target_ts);
        expect(row.interval_start).toBe(row.target_ts - 3600);
        expect(row.issued_at).toBeLessThanOrEqual(row.interval_start);
        expect(row.issued_at).toBeLessThanOrEqual(FIXED_NOW_SECONDS);
        expect(row.retrieved_at).toBe(FIXED_NOW_SECONDS - 137);
        expect(row.first_seen_at).toBe(FIXED_NOW_SECONDS - 113);
        expect(row.retrieved_at).not.toBe(row.first_seen_at);
        expect(row.model).toBe("SYNTHETIC_FIXTURE_MODEL");
      }
      expect(payload.system_knowledge_claim).toBe(false);
      expect(payload.fixture_provenance).toContain("synthetic");
      await expect(rows.last()).toContainText("71.4 GW");
      expect(legacyForecastQueries).toEqual([]);
      expect(Number(new URL(archives[0]!.url()).searchParams.get("as_of"))).toBe(FIXED_NOW_SECONDS);
    });
  }
}

for (const mode of ["empty", "error", "missing-archive"] as const) {
  test(`ERP-04 shared archive ${mode} remains distinct from populated actuals`, async ({
    page,
  }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await installArchivedForecastApi(page, FIXED_NOW_SECONDS, mode);
    const response = page.waitForResponse((response) =>
      response.url().includes("/api/v1/historical-forecast?"),
    );
    await page.goto("/?view=overview&range=21600&live=1&legend=expanded");
    const archive = await response;
    expect(archive.status()).toBe(mode === "empty" ? 200 : mode === "error" ? 503 : 404);
    const card = page.locator('[data-chart-id="supply-demand"]');
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    const table = card.getByRole("table", { name: "Supply and demand series statistics" });
    await expect(
      table
        .getByRole("row")
        .filter({ hasText: "Forecast issued before delivery" })
        .getByRole("cell")
        .nth(1),
    ).toHaveText("—");
    await expect(
      table.getByRole("row").filter({ hasText: "Actual demand" }).getByRole("cell").nth(1),
    ).toContainText("GW");
    await expect(
      page.getByText(
        mode === "empty"
          ? /No eligible archived forecast issued before delivery/
          : /Archived pre-delivery forecast unavailable/,
      ),
    ).toBeVisible();
    if (mode === "empty") {
      const data = await archive.json();
      expect(data.availability).toBe("no_eligible_archived_vintage");
      expect(data.rows).toEqual([]);
      expect(data.coverage).toMatchObject({
        expected_target_count: 7,
        available_value_count: 0,
        missing_value_count: 7,
      });
    }
  });
}
