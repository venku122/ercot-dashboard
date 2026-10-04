import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390, 512, 700, 834]) {
  test(`homepage controls remain contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installMobileApi(page);
    await page.goto("/?view=overview&range=259200&live=1&legend=compact");
    const card = page.locator('[data-chart-id="supply-demand"]');
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const controls = page.getByLabel("Time-aligned grid readings", { exact: true });
    const boxes = await controls.locator("strong").evaluateAll((elements) =>
      elements.map((element) => ({
        value: element.getBoundingClientRect().toJSON(),
        cell: element.parentElement!.getBoundingClientRect().toJSON(),
      })),
    );
    for (const { value, cell } of boxes) {
      expect(value.right).toBeLessThanOrEqual(cell.right + 1);
    }
    if (width <= 700) {
      const nav = page.locator(".mobile-section-nav");
      const more = await nav.getByRole("button", { name: "More views", exact: true }).boundingBox();
      expect(more!.x).toBeGreaterThanOrEqual(0);
      expect(more!.x + more!.width).toBeLessThanOrEqual(width + 1);
      const rows = await card
        .locator(".legend-row")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().toJSON()),
        );
      for (const row of rows) expect(row.width).toBeGreaterThan(width - 60);
    }
    await page
      .getByRole("combobox", { name: "History point", exact: true })
      .selectOption({ label: "West Hub" });
    await expect(
      page.getByRole("heading", { name: "West Hub · NP6-905 settlement price" }),
    ).toBeVisible();
    await expect(page.locator('[data-chart-id="pricing"] canvas')).toHaveCount(0);
    await expect(
      page.getByText("Settlement source unavailable. Core collection history remains independent."),
    ).toBeVisible();
  });
}
