import { expect, test } from "@playwright/test";

import { installReviewEvidenceApi, labelSyntheticFixture } from "./review-evidence-fixtures";

test.beforeEach(async ({ page }) => {
  await installReviewEvidenceApi(page);
});

test("populated forecast quality review evidence", async ({ page }) => {
  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Forecast quality" });
  await panel.getByRole("button", { name: "Load quality details" }).click();
  const table = panel.getByRole("table", {
    name: "System load 1-hour ahead exact forecast quality",
  });
  await expect(table).toBeVisible();
  await expect(panel).toContainText("Signed error = actual − forecast");
  await labelSyntheticFixture(page, "section:has(#forecast-quality-title)");
  await table.evaluate((element) => {
    element.style.display = "none";
  });
  await expect(panel).toHaveScreenshot("review-forecast-quality-populated.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("populated net load and ramp review evidence", async ({ page }) => {
  await page.goto("/?view=generation");
  const panel = page.getByRole("region", { name: "Net load and ramp" });
  await panel.getByRole("button", { name: "Load net-load details" }).click();
  const table = panel.getByRole("table", { name: "Actual exact net-load values" });
  await expect(table).toBeVisible();
  await expect(panel).toContainText("Net load and ramp");
  await labelSyntheticFixture(page, "section.net-load-panel");
  await table.evaluate((element) => {
    element.style.display = "none";
  });
  await expect(panel).toHaveScreenshot("review-net-load-populated.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
