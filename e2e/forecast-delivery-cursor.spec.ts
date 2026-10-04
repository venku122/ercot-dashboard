import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
test("hour-ending forecast cursor selects delivery interval containing08:30UTC", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const start = Date.parse("2026-08-18T07:00:00Z") / 1000,
    end = start + 10800;
  await page.route("**/api/v1/historical-forecast?**", (route) =>
    route.fulfill({
      json: {
        product_id: "NP3-565-CD",
        policy: "issued_before_delivery",
        rows: [
          {
            target_ts: start + 3600,
            interval_start: start,
            interval_end: start + 3600,
            issued_at: start - 7200,
            value: 11000,
            unit: "MW",
          },
          {
            target_ts: start + 7200,
            interval_start: start + 3600,
            interval_end: start + 7200,
            issued_at: start - 7200,
            value: 42000,
            unit: "MW",
          },
        ],
      },
    }),
  );
  await page.goto(
    `/?view=overview&live=0&from=${start}&to=${end}&range=10800&compare=none&legend=compact`,
  );
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await card.locator("canvas").focus();
  for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowLeft");
  const latest = card
    .locator(".legend-row")
    .filter({ hasText: "Forecast issued before delivery" })
    .locator(".legend-latest");
  await expect(latest).toHaveAttribute("data-value-scope", "cursor");
  console.log(
    "Actual forecast cursor legend:",
    await latest.textContent(),
    "title:",
    await latest.getAttribute("title"),
  );
  await page.screenshot({
    path: "artifacts/post-release/forecast-delivery-cursor.png",
    fullPage: true,
  });
  await expect(latest).toContainText("42.0 GW");
  await expect(latest).toHaveAttribute("title", /Delivery interval/);
  await expect(latest).not.toHaveAttribute("title", /s before cursor|source observation/);
});
