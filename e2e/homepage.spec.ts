import { installMarketGeographyApi } from "./market-geography-fixtures";
import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`HOME-01 HOME-02 chart-first overview ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMobileApi(page);
    await page.goto("/?view=overview&live=1&range=86400&legend=compact");
    await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toBeVisible();
    await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
      "aria-label",
      /[1-9]\d* observations/,
    );
    if (process.env.HOME_EVIDENCE === "before") {
      await page.screenshot({ path: `docs/overview-chart-first/before-${viewport.width}.png` });
      return;
    }
    const plot = await page.locator('[data-chart-id="supply-demand"] canvas').boundingBox();
    // Two readable rows of phone readings still leave the full first plot above the fold.
    expect(plot!.y).toBeLessThanOrEqual(viewport.width === 390 ? 320 : 240);
    expect(plot!.height).toBeGreaterThanOrEqual(viewport.width === 390 ? 220 : 280);
    await page.screenshot({ path: `docs/overview-chart-first/after-${viewport.width}.png` });
    await expect(page.locator('[data-chart-id="fuel-mix"]')).toHaveCount(1);
    await expect(page.locator('[data-chart-id="storage"]')).toHaveCount(1);
    await expect(page.locator('[data-chart-id="pricing"]')).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Grid frequency", exact: true })).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("DATA-01 DATA-03 native headroom, PRC and market selection remain distinct", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await installMarketGeographyApi(page, [], { priceTarget: FIXED_NOW_SECONDS });
  await page.goto("/?range=86400&live=1");
  const headroom = page.locator('[data-chart-id="overview-headroom"]');
  await expect(headroom.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(headroom).not.toContainText("Headroom unavailable");
  await expect(
    headroom.getByRole("button", { name: "Derived headroom", exact: true }),
  ).toBeVisible();
  await expect(headroom.getByRole("button", { name: "Reported PRC", exact: true })).toBeVisible();
  await page.screenshot({ path: "docs/overview-chart-first/native-1440.png" });
  await page
    .getByRole("region", { name: "Settlement price ranking" })
    .getByRole("button", { name: /^West Hub/ })
    .click();
  await expect(page.locator('[data-chart-id="pricing"] h3')).toHaveText(
    "West Hub · NP6-905 settlement price",
  );
  await expect(page).toHaveURL(/overviewPoint=HB_WEST/);
  await page
    .getByRole("region", { name: "Settlement price ranking" })
    .getByRole("button", { name: /^LZ_WEST/ })
    .click();
  const price = page.locator('[data-chart-id="pricing"]');
  await expect(
    price.getByRole("heading", { name: "LZ_WEST · NP6-905 settlement price" }),
  ).toBeVisible();
  await expect(price.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await price.locator("summary").filter({ hasText: "Accessible data table" }).click();
  await expect(price.getByRole("columnheader", { name: "Interval ending (UTC)" })).toBeVisible();
  await expect(price.getByRole("cell", { name: "$225.00/MWh", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/overviewPoint=LZ_WEST/);
});

test("HOME-03 UI-02 Inspect preserves one instance and explicit expanded legends", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.goto("/?range=86400&live=1&legend=expanded");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.locator(".legend-stats").first()).toBeVisible();
  await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(card).toHaveCount(1);
  await expect(card.locator("canvas")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card.locator("canvas")).toHaveCount(1);
});

test("TIME-04 CURSOR-01 keyboard pin freezes live; clearing does not resume", async ({ page }) => {
  await installMobileApi(page);
  await page.goto("/?range=21600&live=1");
  const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Clear pin", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/time_play=paused/);
  const frozenEnd = new URL(page.url()).searchParams.get("time_to_ms");
  await page.getByRole("button", { name: "Clear pin", exact: true }).click();
  await expect(page.locator(".homepage-cursor-strip")).toHaveCount(0);
  await expect(page).toHaveURL(/time_play=paused/);
  expect(new URL(page.url()).searchParams.get("time_to_ms")).toBe(frozenEnd);
});

test("PERF-02 hover does not fetch and preserves chart instances", async ({ page }) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/?range=86400&live=1");
  const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  await expect(page.locator('[data-chart-id="storage"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  const before = requests.length;
  const lifecycle = await page.evaluate(() => window.__ercotChartLifecycle);
  const box = (await canvas.boundingBox())!;
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 60 + i * 5, box.y + 80);
  expect(requests.length).toBe(before);
  expect((await page.evaluate(() => window.__ercotChartLifecycle))?.constructed).toBe(
    lifecycle?.constructed,
  );
});

test("PERF-02 repeated Overview specialist Inspect traversal leaves no ChartCard instances", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.goto("/?range=86400&live=1");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Generation view", exact: true }).click();
    const fuel = page.locator('[data-chart-id="fuel-mix"]');
    await fuel.scrollIntoViewIfNeeded();
    await expect(fuel.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await fuel.getByRole("button", { name: "Open Fuel mix generation inspect mode" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Overview view", exact: true }).click();
    await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
      "data-chart-ready",
      "true",
    );
  }
  await page.getByRole("button", { name: "Outlook view", exact: true }).click();
  await expect(page.locator("[data-chart-id]")).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__ercotChartLifecycle!.constructed - window.__ercotChartLifecycle!.destroyed,
      ),
    )
    .toBe(0);
});

test("expanded statistics have aligned columns and a stable plot during cursor movement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await installMobileApi(page);
  await page.goto("/?range=21600&live=1&legend=expanded");
  const card = page.locator('[data-chart-id="supply-demand"]');
  const canvas = card.locator("canvas");
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  await expect(
    card.getByRole("table", { name: "Supply and demand series statistics" }),
  ).toBeVisible();
  for (const name of ["Series", "Value", "Min", "Max", "Average", "Energy"]) {
    await expect(card.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  const before = (await canvas.boundingBox())!;
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(before.x + 60 + (i * (before.width - 100)) / 12, before.y + 80);
    const after = (await canvas.boundingBox())!;
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(after.height).toBeCloseTo(before.height, 1);
  }
  await expect(page.locator(".homepage-cursor-strip")).toHaveCount(0);
});
