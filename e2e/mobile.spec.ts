import { expect, test } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  installMobileApi,
  LONG_SOURCE_ERROR,
  type MobileScenario,
} from "./mobile-fixtures";

async function openPopulated(
  page: Parameters<typeof installMobileApi>[0],
  scenario: MobileScenario = "normal",
  url = "/",
) {
  await installMobileApi(page, scenario);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "ERCOT Grid" })).toBeVisible();
}

test("P0 operational summary precedes mobile controls and charts @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const viewportHeight = page.viewportSize()?.height ?? 956;
  for (const label of ["Demand", "Available capacity", "Unused capacity", "Frequency"]) {
    const card = page.getByLabel("Grid overview").getByText(label, { exact: true });
    await expect(card).toBeVisible();
  }
  const demand = await page
    .getByLabel("Grid overview")
    .getByText("Demand", { exact: true })
    .boundingBox();
  const frequency = await page
    .getByLabel("Grid overview")
    .getByText("Frequency", { exact: true })
    .boundingBox();
  expect(demand && demand.y + demand.height).toBeLessThanOrEqual(viewportHeight);
  expect(frequency && frequency.y + frequency.height).toBeLessThanOrEqual(viewportHeight);
  await expect(page.getByLabel("Global dashboard controls")).toBeHidden();
  await expect(page.getByRole("button", { name: "Controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grid conditions Collapse" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generation Expand" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("legend")).toBe("compact");
  const firstChart = await page.locator('[data-chart-id="supply-demand"]').boundingBox();
  expect(firstChart?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(viewportHeight * 1.5);
});

test("P0 populated layouts have no horizontal overflow @mobile-core", async ({ page }) => {
  for (const scenario of ["normal", "failed", "active-event", "negative"] as const) {
    await installMobileApi(page, scenario);
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("P0 quick controls open a focus-trapped restorable sheet @mobile-core", async ({ page }) => {
  await openPopulated(page);
  const trigger = page.getByRole("button", { name: "Controls" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Dashboard controls" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Compare time")).toBeVisible();
  await expect(sheet.getByLabel("Legend detail")).toBeVisible();
  await expect(sheet.getByText("Custom range", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("P0 compact legends preserve explicit shared expanded state @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator(".legend-stats")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page);
  await page.goto("/?legend=expanded");
  await expect(card.locator(".legend-stats").first()).toBeVisible();
});

test("P0 normal chart scroll policy differs from inspect gestures @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const card = page.locator('[data-chart-id="supply-demand"]');
  const canvasWrap = card.locator(".chart-canvas-wrap");
  await expect(canvasWrap).toHaveCSS("touch-action", "pan-y");
  await expect(card).toHaveAttribute("data-interaction-policy", "mobile-scroll");
  await canvasWrap.hover();
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");
  await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect(card).toHaveAttribute("data-interaction-policy", "inspect");
  await expect(canvasWrap).toHaveCSS("touch-action", "none");
  await expect(card.getByText("Pinch to zoom", { exact: false })).toBeVisible();
});

test("P0 inspect is a safe-area dialog with explicit analysis actions @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const trigger = page.getByRole("button", { name: "Open Supply and demand inspect mode" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Inspect Supply and demand" });
  await expect(dialog).toBeVisible();
  for (const action of [
    "Close inspect",
    "Reset zoom",
    "Download CSV",
    "ERCOT source",
    "Show data table",
  ]) {
    await expect(
      dialog.getByRole("button", { name: action }).or(dialog.getByRole("link", { name: action })),
    ).toBeVisible();
  }
  await expect(dialog).toHaveCSS("max-height", /.+/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("P0 negative price ranking is compact and accessible @mobile-core", async ({ page }) => {
  await openPopulated(page, "negative");
  const summary = page.getByLabel("Settlement price summary");
  await expect(summary.getByText("HB_NORTH", { exact: true })).toBeVisible();
  await expect(summary.getByText(/-42\.2 \$\/MWh/)).toBeVisible();
  await expect(summary.getByRole("listitem")).toHaveCount(5);
  await summary.getByRole("button", { name: "Show all prices" }).click();
  const dialog = page.getByRole("dialog", { name: "Settlement price details" });
  await expect(dialog.getByRole("table")).toBeVisible();
  await expect(dialog.getByText("HB_SOUTH", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("P0 long source failures are summarized with complete drawer detail @mobile-core", async ({
  page,
}) => {
  await openPopulated(page, "failed");
  const summary = page.getByLabel("Source health summary");
  await expect(summary).toContainText("Energy Storage");
  await expect(summary).not.toContainText(LONG_SOURCE_ERROR);
  await summary.getByRole("button", { name: "Review source health" }).click();
  const dialog = page.getByRole("dialog", { name: "Source health details" });
  await expect(dialog.getByText(LONG_SOURCE_ERROR, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("P0 active operations notice stays visible while history is progressive @mobile-core", async ({
  page,
}) => {
  await openPopulated(page, "active-event");
  const summary = page.getByLabel("Operations notice summary");
  await expect(summary).toContainText("Transmission constraint");
  await expect(page.getByText("Earlier transmission advisory", { exact: false })).toBeHidden();
  await summary.getByRole("button", { name: "Review operations messages" }).click();
  await expect(page.getByRole("dialog", { name: "Operations message history" })).toContainText(
    "Earlier transmission advisory",
  );
});

test("P0 section navigation expands, scrolls, and focuses its destination @mobile-core", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/");
  await page.getByRole("button", { name: "Market section" }).click();
  const heading = page.getByRole("button", { name: "Market Collapse" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect.poll(() => requests.flat().some((id) => id.startsWith("pricing:"))).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("P1 mobile performance mounts at most two charts and skips collapsed groups @mobile-core", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/");
  await expect
    .poll(() => page.locator('[data-chart-id][data-mounted="true"]').count())
    .toBeGreaterThan(0);
  expect(await page.locator('[data-chart-id][data-mounted="true"]').count()).toBeLessThanOrEqual(2);
  expect(requests.flat().some((id) => id.startsWith("fuel-mix:"))).toBe(false);
  expect(
    await page.evaluate(() => window.__ercotChartLifecycle?.constructed ?? 0),
  ).toBeLessThanOrEqual(2);
});

test("P1 compact portrait, landscape, and increased text stay usable @responsive", async ({
  page,
}) => {
  await page.addStyleTag({ content: ":root { font-size: 125%; }" });
  await openPopulated(page, "failed");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Controls" }).click();
  const sheet = page.getByRole("dialog", { name: "Dashboard controls" });
  await expect(sheet).toBeVisible();
  const viewport = page.viewportSize();
  const box = await sheet.boundingBox();
  expect(box && viewport && box.x + box.width).toBeLessThanOrEqual(viewport?.width ?? 0);
  expect(box && viewport && box.y + box.height).toBeLessThanOrEqual(viewport?.height ?? 0);
});

test("P0 viewport metadata opts into safe-area layout @mobile-core", async ({ page }) => {
  await openPopulated(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    /viewport-fit=cover/,
  );
  await expect(page.locator(".mobile-section-nav")).toHaveCSS("padding-bottom", /.+/);
});
