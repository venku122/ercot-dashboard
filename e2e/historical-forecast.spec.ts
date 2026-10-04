import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

for (const width of [390, 1440]) {
  test(`ERP-04 archived forecast overlaps actuals at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    const requests: URL[] = [];
    await page.route("**/api/v1/historical-forecast?**", (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const start = Number(url.searchParams.get("start"));
      return route.fulfill({
        json: {
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          coverage: {
            expected_target_count: 24,
            available_value_count: 24,
            missing_value_count: 0,
            truncated: false,
          },
          rows: Array.from({ length: 24 }, (_, index) => {
            const target = start + (index + 1) * 3600;
            return {
              target_ts: target,
              interval_start: target - 3600,
              interval_end: target,
              issued_at: start - 7200,
              retrieved_at: target + 10,
              first_seen_at: target + 10,
              value: 70_000 + index * 100,
              unit: "MW",
              vintage_key: "synthetic-pre-delivery",
            };
          }),
        },
      });
    });
    await page.goto("/?range=86400&live=1&legend=compact");
    const card = page.locator('[data-chart-id="supply-demand"]');
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    const forecast = card
      .locator(".legend-row")
      .filter({ hasText: "Forecast issued before delivery" });
    await expect(forecast.locator(".legend-latest")).toContainText("72.3 GW");
    await expect(
      card.locator(".legend-row").filter({ hasText: "Actual demand" }).locator(".legend-latest"),
    ).toContainText("71.0 GW");
    await expect(
      page.getByText("Official issue time does not prove this system knew it then.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("policy")).toBe("issued_before_delivery");
    expect(Number(requests[0]!.searchParams.get("as_of"))).toBe(FIXED_NOW_SECONDS);
    await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
    await card.getByText("Accessible data table", { exact: true }).click();
    const rows = card
      .locator(".accessible-data tbody tr")
      .filter({ hasText: "Forecast issued before delivery" });
    await expect(rows).toHaveCount(24);
    await expect(rows.last()).toContainText("72.3 GW");
    await page.keyboard.press("Escape");
    expect(requests).toHaveLength(1);
    await page.screenshot({ path: `artifacts/post-release/historical-forecast-${width}.png` });
  });

  test(`ERP-04 missing archived forecast remains explicit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.route("**/api/v1/historical-forecast?**", (route) =>
      route.fulfill({
        json: {
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          rows: [],
          coverage: {
            expected_target_count: 24,
            available_value_count: 0,
            missing_value_count: 24,
            truncated: false,
          },
        },
      }),
    );
    await page.goto("/?range=86400&live=1&legend=compact");
    const card = page.locator('[data-chart-id="supply-demand"]');
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await expect(
      page.getByText(/No eligible archived forecast issued before delivery/),
    ).toBeVisible();
    await expect(
      card.locator(".legend-row").filter({ hasText: "Actual demand" }).locator(".legend-latest"),
    ).toContainText("71.0 GW");
    await expect(
      card
        .locator(".legend-row")
        .filter({ hasText: "Forecast issued before delivery" })
        .locator(".legend-latest"),
    ).toHaveText("—");
  });
}
