import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [512, 1440]) {
  test(`legend rows focus, switch and restore series at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installMobileApi(page);
    await page.goto("/?view=overview&range=259200&live=1&legend=compact");
    const card = page.locator('[data-chart-id="fuel-mix"]');
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    const gas = card.getByRole("button", { name: "Natural gas", exact: true });
    const wind = card.getByRole("button", { name: "Wind", exact: true });
    await card
      .locator(".legend-row")
      .filter({ hasText: "Natural gas" })
      .locator(".legend-latest")
      .click();
    await expect(gas).toHaveAttribute("aria-pressed", "true");
    await expect(card.locator(".legend-row-hidden")).toHaveCount(4);
    await wind.click();
    await expect(wind).toHaveAttribute("aria-pressed", "true");
    await expect(gas).toHaveAttribute("aria-pressed", "false");
    await expect(card.locator(".legend-row-hidden")).toHaveCount(4);
    await wind.press("Enter");
    await expect(card.locator(".legend-row-hidden")).toHaveCount(0);
    await expect(wind).toHaveAttribute("aria-pressed", "false");
    await expect(card.getByRole("button", { name: /^Solo / })).toHaveCount(0);
  });
}
