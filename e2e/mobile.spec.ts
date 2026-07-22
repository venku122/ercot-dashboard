import { expect, test } from "@playwright/test";

test("mobile controls and keyboard-reachable chart menu remain usable", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-21T18:00:00-05:00"));
  await page.route("**/api/series/batch", (route) => route.fulfill({ json: { series: [] } }));
  await page.route("**/api/latest/batch", (route) => route.fulfill({ json: { latest: [] } }));
  await page.route("**/api/v1/ranking**", (route) => route.fulfill({ json: { rows: [] } }));
  await page.route("**/api/v1/source-health", (route) => route.fulfill({ json: { sources: [] } }));
  await page.route("**/api/v1/events**", (route) => route.fulfill({ json: { events: [] } }));
  await page.goto("/");
  await expect(page.getByLabel("Time range")).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse", exact: false }).first();
  await collapse.click();
  const expand = page.getByRole("button", { name: "Expand", exact: false }).first();
  await expect(expand).toBeVisible();
  await expand.click();
  const chartMenu = page.getByLabel("Supply and demand chart menu");
  await chartMenu.scrollIntoViewIfNeeded();
  await chartMenu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Reset zoom" })).toBeVisible();
  await page.keyboard.press("Escape");
  await collapse.click();
  await expect(page).toHaveScreenshot("mobile-dashboard.png", { fullPage: true });
});
