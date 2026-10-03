import { expect, test } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";
import { installTexasGridApi } from "./texas-grid-fixtures";

test("Texas Grid is lazy, selected-only, exact, and URL-restorable", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installTexasGridApi(page, requests);

  await page.goto("/?view=overview");
  await expect(page.getByRole("region", { name: "Texas Grid long-horizon evidence" })).toHaveCount(
    0,
  );
  expect(requests).toEqual([]);

  await page.goto("/?view=texas-grid");
  const panel = page.getByRole("region", { name: "Texas Grid long-horizon evidence" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Planning snapshots, not operating capacity");
  await expect(panel).toContainText("Long-term load forecast");
  await expect(panel).toContainText("Large-load project status");
  await expect(panel).toContainText("Gross retirements");
  await expect(page.getByLabel("Global dashboard controls")).toHaveCount(0);
  expect(requests).toEqual(["/api/v1/texas-grid"]);

  await panel.getByRole("button", { name: "Open interconnection history" }).click();
  await expect(page).toHaveURL(/grid_resource=gis/);
  await expect(panel).toContainText("Negative MW can reflect repowering net-change adjustments");
  await expect(panel).toContainText("-25.5 MW");
  await expect(
    panel.getByRole("region", { name: "Exact generator interconnection aggregate evidence" }),
  ).toBeVisible();
  expect(requests.filter((request) => request.startsWith("/api/v2/"))).toHaveLength(1);
  expect(requests.at(-1)).toContain("/api/v2/texas-grid/gis/v1/tg1-");

  await panel.getByRole("button", { name: "Open capacity history" }).click();
  await expect(page).toHaveURL(/grid_resource=resource_capacity_trend/);
  await expect(panel).toContainText("Official total");
  await expect(panel).toContainText("Source column absent");
  await expect(panel.getByRole("button", { name: "Wind" })).toHaveAttribute("aria-pressed", "true");
  const trendTable = panel.getByRole("region", {
    name: "Wind exact resource capacity trend evidence",
  });
  await expect(trendTable.locator("tbody tr")).toHaveCount(2);
  expect(requests.filter((request) => request.startsWith("/api/v2/"))).toHaveLength(2);
  await expect(panel).toHaveScreenshot("texas-grid-capacity-desktop.png");

  await page.goBack();
  await expect(page).toHaveURL(/grid_resource=gis/);
  await expect(panel).toContainText("Generator interconnection study aggregates");
  await page.reload();
  await expect(panel).toContainText("-25.5 MW");
  expect(requests.filter((request) => request === "/api/v1/texas-grid")).toHaveLength(2);

  await page.goto("/?view=generation");
  await expect(panel).toHaveCount(0);
});
