import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

test("closed source tables defer rows and opening exposes the retained native observations", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/?range=86400&live=1");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator('canvas[data-chart-ready="true"]')).toBeVisible();
  const disclosure = card.locator("details.accessible-data");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(disclosure.locator("tbody tr")).toHaveCount(0);
  await disclosure.getByText("Accessible data table", { exact: true }).click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect.poll(() => disclosure.locator("tbody tr").count()).toBeGreaterThan(250);
  await expect(disclosure).toContainText(new Date(FIXED_NOW_SECONDS * 1000).toISOString());
  await disclosure.getByText("Accessible data table", { exact: true }).click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(disclosure.locator("tbody tr")).toHaveCount(0);
});

test("an opened table keeps its disclosure and row state together across a genuine empty window", async ({
  page,
}) => {
  await page.clock.install();
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/?range=21600&live=1");
  const frequency = page.locator('[data-chart-id="frequency"]');
  await frequency.scrollIntoViewIfNeeded();
  await expect(frequency.locator('canvas[data-chart-ready="true"]')).toBeVisible();
  await expect(frequency).toHaveAttribute("aria-busy", "false");
  await frequency.getByText("Accessible data table", { exact: true }).click();
  await expect(frequency.locator("details.accessible-data")).toHaveAttribute("open", "");
  await page.clock.setFixedTime(new Date((FIXED_NOW_SECONDS + 86400) * 1000));
  await page.clock.fastForward(30_000);
  await expect(frequency).toContainText("Waiting for first sample");
  await expect(frequency.locator("details.accessible-data")).toHaveCount(0);
  await page.clock.setFixedTime(new Date(FIXED_NOW_SECONDS * 1000));
  await page.clock.fastForward(30_000);
  await expect(frequency.locator('canvas[data-chart-ready="true"]')).toBeVisible();
  const disclosure = frequency.locator("details.accessible-data");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(disclosure.locator("tbody tr")).toHaveCount(250);
  await disclosure.getByText("Accessible data table", { exact: true }).click();
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(disclosure.locator("tbody tr")).toHaveCount(0);
});
