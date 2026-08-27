import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./mobile-fixtures";
import { installStorageOperationsApi } from "./storage-operations-fixtures";

test("storage operations is contained and accessible on mobile @mobile-core", async ({ page }) => {
  const requests: string[][] = [];
  await installStorageOperationsApi(page, "normal", requests);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const disclosure = summary.getByText("Exact coherent observation");
  const box = await disclosure.boundingBox();
  expect(box, "exact-observation disclosure has a layout box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await disclosure.click();
  const exact = summary.getByRole("region", { name: "Exact coherent storage observation" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("storage operations has stable mobile evidence states @mobile-vri", async ({ page }) => {
  const requests: string[][] = [];
  await installStorageOperationsApi(page, "normal", requests);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary).toBeVisible();
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await expect(summary).toHaveScreenshot("storage-operations-summary-mobile.png");
  await summary.getByText("Exact coherent observation").click();
  await expect(
    summary.getByRole("region", { name: "Exact coherent storage observation" }),
  ).toHaveScreenshot("storage-operations-exact-mobile.png");
});
