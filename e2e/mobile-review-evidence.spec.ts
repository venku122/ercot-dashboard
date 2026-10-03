import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./mobile-fixtures";
import { installReviewEvidenceApi, labelSyntheticFixture } from "./review-evidence-fixtures";

test.beforeEach(async ({ page }) => {
  await installReviewEvidenceApi(page);
});

test("populated forecast quality review evidence on mobile @mobile-vri", async ({ page }) => {
  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Forecast quality" });
  const toggle = panel.getByRole("button", { name: "Load quality details" });
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const table = panel.getByRole("table", {
    name: "System load 1-hour ahead exact forecast quality",
  });
  await expect(table).toBeVisible();
  await labelSyntheticFixture(page, "section:has(#forecast-quality-title)");
  await table.evaluate((element) => {
    element.style.display = "none";
  });
  await expectNoHorizontalOverflow(page);
  await expect(panel).toHaveScreenshot("review-forecast-quality-populated-mobile.png");
});

test("populated net-load review evidence on mobile @mobile-vri", async ({ page }) => {
  await page.goto("/?view=generation");
  const panel = page.getByRole("region", { name: "Net load and ramp" });
  const toggle = panel.getByRole("button", { name: "Load net-load details" });
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await toggle.click();
  const table = panel.getByRole("table", { name: "Actual exact net-load values" });
  await expect(table).toBeVisible();
  await labelSyntheticFixture(page, "section.net-load-panel");
  await table.evaluate((element) => {
    element.style.display = "none";
  });
  await expectNoHorizontalOverflow(page);
  await expect(panel).toHaveScreenshot("review-net-load-populated-mobile.png");
});
