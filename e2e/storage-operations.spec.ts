import { expect, test } from "@playwright/test";

import { installStorageOperationsApi } from "./storage-operations-fixtures";

function storageQueryIds(requests: string[][]) {
  return requests.flat().filter((id) => id.startsWith("storage:"));
}

test("storage operations reuses the visible chart request and exposes exact truthful context", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installStorageOperationsApi(page, "normal", requests);
  await page.goto("/?view=overview");
  expect(storageQueryIds(requests)).toEqual([]);

  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  await expect(storage).toHaveAttribute("data-visible", "true");
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary).toBeVisible();
  await expect
    .poll(() => storageQueryIds(requests))
    .toEqual([
      "storage:charging:current",
      "storage:discharging:current",
      "storage:net-output:current",
    ]);
  await expect(summary.getByText("Fleet mode").locator("..")).toContainText(/Charging|Discharging/);
  await expect(summary).toContainText("System-wide dashboard aggregate only");
  await expect(summary).toContainText("does not report state of charge");
  await expect(summary).toContainText("context—not attributed causes");
  await expect(summary).toHaveScreenshot("storage-operations-summary.png", {
    maxDiffPixelRatio: 0.02,
  });

  await summary.getByText("Exact coherent observation").click();
  const exact = summary.getByRole("region", { name: "Exact coherent storage observation" });
  await expect(exact).toBeVisible();
  await expect(exact).toHaveAttribute("tabindex", "0");
  await expect(exact.locator("tbody tr")).toHaveCount(1);
  await expect(exact).toHaveScreenshot("storage-operations-exact.png");
  expect(storageQueryIds(requests)).toEqual([
    "storage:charging:current",
    "storage:discharging:current",
    "storage:net-output:current",
  ]);
});

test("storage operations keeps last-good aggregate evidence visibly stale", async ({ page }) => {
  const requests: string[][] = [];
  await installStorageOperationsApi(page, "failed", requests);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary.getByRole("status")).toContainText(
    "last coherent storage snapshot; source is stale",
  );
  await expect(storage.getByText("Showing stale data")).toBeVisible();
  await expect(summary).toContainText("Net output");
});
