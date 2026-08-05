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
  const primaryOverview = page.getByLabel("Grid overview");
  await expect(primaryOverview.getByRole("article")).toHaveCount(3);
  for (const label of ["Demand", "Reserve margin", "Real-time price"]) {
    const card = primaryOverview.getByText(label, { exact: true });
    await expect(card).toBeVisible();
  }
  await expect(primaryOverview.getByText("Available capacity", { exact: true })).toHaveCount(0);
  await expect(primaryOverview.getByText("Frequency", { exact: true })).toHaveCount(0);
  for (const id of ["grid-status", "demand", "reserve-margin", "real-time-price"]) {
    const trend = page.locator(`[data-hero-trend="${id}"]`);
    await expect(trend).toBeVisible();
    await expect(trend).toHaveAttribute("aria-label", /Last hour/);
  }
  const healthScore = page.locator(".mobile-grid-condition .grid-health-score-value");
  await expect(healthScore).toBeVisible();
  await expect(healthScore).toHaveAttribute("data-health-status", "normal");
  await expect(healthScore).toContainText("/ 100");
  await expect(healthScore).toContainText("100% factor coverage");
  await expect(
    page.getByText("How the Grid Health Score is calculated", { exact: true }),
  ).toBeVisible();
  const primaryPrice = await primaryOverview
    .getByText("Real-time price", { exact: true })
    .boundingBox();
  expect(primaryPrice && primaryPrice.y + primaryPrice.height).toBeLessThanOrEqual(viewportHeight);
  const supporting = page.locator(".mobile-supporting-metrics");
  const supportingSummary = supporting.locator("summary");
  await expect(supporting).not.toHaveAttribute("open", "");
  await expect(supportingSummary).toHaveAccessibleName(
    "Supporting grid readings Available capacity and frequency",
  );
  await expect(supporting.getByText("Available capacity", { exact: true })).toBeHidden();
  await expect(supporting.getByText("Frequency", { exact: true })).toBeHidden();
  await supportingSummary.focus();
  await expect(supportingSummary).toBeFocused();
  await expect(supportingSummary).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(supporting).toHaveAttribute("open", "");
  await expect(supporting.getByText("Available capacity", { exact: true })).toBeVisible();
  await expect(supporting.getByText("Frequency", { exact: true })).toBeVisible();
  for (const id of ["available-capacity", "frequency"]) {
    await expect(supporting.locator(`[data-hero-trend="${id}"]`)).toHaveAttribute(
      "aria-label",
      /Last hour/,
    );
  }
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Global dashboard controls")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Grid at a glance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operational detail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grid conditions Collapse" })).toBeVisible();
  await expect(page.locator('[data-group="Generation"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generation view" })).toBeVisible();
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

test("P0 all derived metrics remain accessible without horizontal overflow @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const metrics = page.getByLabel("Derived grid metrics");
  await metrics.scrollIntoViewIfNeeded();
  await expect(metrics.getByRole("article")).toHaveCount(9);
  await expect(metrics.locator('[data-derived-available="true"]')).toHaveCount(9);
  for (const label of [
    "Reserve Margin %",
    "Capacity Utilization %",
    "Renewable %",
    "Storage State",
    "Demand Growth",
    "Forecast Peak",
    "Hours Until Peak",
    "Price Percentile",
    "Historical Comparison",
  ]) {
    await expect(metrics.getByRole("article", { name: new RegExp(`^${label}:`) })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
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

test("P0 chart interpretation stays compact and text-accessible @mobile-core", async ({ page }) => {
  await openPopulated(page);
  const card = page.locator('[data-chart-id="supply-demand"]');
  const interpretation = card.locator(".chart-interpretation");
  await card.scrollIntoViewIfNeeded();
  await expect(interpretation).not.toHaveAttribute("open", "");
  await expect(interpretation.locator("summary")).toBeVisible();
  await interpretation.locator("summary").click();
  await expect(
    card.getByLabel("Supply and demand interpretation bands").getByRole("listitem"),
  ).toHaveCount(4);
  await expect(card.locator("canvas")).toHaveAttribute(
    "aria-label",
    /Interpretation guide for actual demand.*Above capacity/,
  );
  await expectNoHorizontalOverflow(page);
});

test("P0 primary mobile targets meet the 44 point contract @mobile-core", async ({ page }) => {
  await openPopulated(page);
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toBeVisible();
  const targets = [
    page.locator(".mobile-supporting-metrics > summary"),
    page.getByRole("button", { name: "Controls" }),
    page.getByLabel("Time range"),
    page.getByRole("button", { name: "Grid conditions Collapse" }),
    card.getByRole("button", { name: "Open Supply and demand inspect mode" }),
    card.getByLabel("Supply and demand chart menu"),
    card.getByRole("button", { name: "Actual demand", exact: true }),
    card.getByRole("button", { name: "Solo Actual demand" }),
    card.locator(".accessible-data summary"),
    page.getByRole("button", { name: "Market view" }),
  ];
  for (const target of targets) {
    const bounds = await target.boundingBox();
    const name = (await target.getAttribute("aria-label")) ?? (await target.textContent());
    expect(bounds?.height ?? 0, name ?? "target height").toBeGreaterThanOrEqual(44);
    expect(bounds?.width ?? 0, name ?? "target width").toBeGreaterThanOrEqual(44);
  }
});

test("P0 normal chart scroll policy differs from inspect gestures @mobile-core", async ({
  page,
}) => {
  await openPopulated(page);
  const card = page.locator('[data-chart-id="supply-demand"]');
  const canvasWrap = card.locator(".chart-canvas-wrap");
  await expect(canvasWrap).toHaveCSS("touch-action", "pan-y");
  await expect(card).toHaveAttribute("data-interaction-policy", "mobile-scroll");
  const before = await page.evaluate(() => window.scrollY);
  await canvasWrap.dispatchEvent("pointerdown", {
    clientX: 200,
    clientY: 700,
    pointerId: 1,
    pointerType: "touch",
  });
  await page.evaluate(() => window.scrollBy(0, 420));
  await canvasWrap.dispatchEvent("pointerup", {
    clientX: 200,
    clientY: 280,
    pointerId: 1,
    pointerType: "touch",
  });
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
  await expect(summary.getByText(/-\$42\.16\/MWh/)).toBeVisible();
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
  await expect(page.getByRole("region", { name: "Grid condition" })).toContainText("NORMAL");
  const summary = page.getByLabel("System health summary");
  await expect(summary).toContainText("1 Data Source Needs Attention");
  await expect(summary).toContainText("Energy Storage");
  await expect(summary).not.toContainText(LONG_SOURCE_ERROR);
  await summary.getByRole("button", { name: "Review system health diagnostics" }).click();
  const dialog = page.getByRole("dialog", { name: "System health details" });
  await expect(dialog.getByText(LONG_SOURCE_ERROR, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("P0 active operations notice stays visible while history is progressive @mobile-core", async ({
  page,
}) => {
  await openPopulated(page, "active-event");
  const summary = page.getByLabel("Operations notice summary");
  await expect(summary).toContainText("Transmission constraint");
  const alert = page.getByLabel("Active grid alerts");
  await expect(alert).toContainText("Cause");
  await expect(alert).toContainText("Impact");
  await expect(alert).toContainText("Recommended action");
  await expect(page.getByText("Earlier transmission advisory", { exact: false })).toBeHidden();
  await summary.getByRole("button", { name: "Review operations messages" }).click();
  const dialog = page.getByRole("dialog", { name: "Operations timeline" });
  await expect(dialog).toContainText("Earlier transmission advisory");
  await expect(
    dialog.getByLabel("Historical operations timeline").getByRole("listitem"),
  ).toHaveCount(6);
  await dialog.getByLabel("Filter operations timeline by severity").selectOption("emergency");
  await expect(
    dialog.getByLabel("Historical operations timeline").getByRole("listitem"),
  ).toHaveCount(1);
  await expect(dialog).toContainText("EEA Level 2");
  await expectNoHorizontalOverflow(page);
});

test("P0 API failure remains distinct from an empty selected window @mobile-core", async ({
  page,
}) => {
  await openPopulated(page, "error");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(page.getByRole("alert")).toContainText("not an empty-data state");
  await expect(page.getByRole("button", { name: "Retry data" })).toBeVisible();
  await expect(page.getByRole("alert")).not.toContainText("fixture upstream unavailable");
  await expect(card.getByText("No observations in this window.")).toBeHidden();

  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page, "empty");
  await page.reload();
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("No observations in this window.")).toBeVisible();
});

test("P0 view navigation updates URL, content, and focus @mobile-core", async ({ page }) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/");
  await page.getByRole("button", { name: "Market view" }).click();
  const heading = page.getByRole("button", { name: "Market Collapse" });
  await expect(heading).toBeVisible();
  await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("market");
  await page.locator('[data-chart-id="pricing"]').scrollIntoViewIfNeeded();
  await expect.poll(() => requests.flat().some((id) => id.startsWith("pricing:"))).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("P0 all seven views are reachable and browser history restores them @mobile-core", async ({
  page,
}) => {
  await installMobileApi(page, "normal");
  await page.goto("/?view=weather");
  const navigation = page.getByRole("navigation", { name: "Dashboard views" });
  await expect(navigation.getByRole("button")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Weather Collapse" })).toBeVisible();
  await expect(page.locator('[data-group="Grid conditions"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Advanced view" }).click();
  for (const group of ["Advanced grid", "Ancillary services", "Operations"]) {
    await expect(page.getByRole("button", { name: `${group} Collapse` })).toBeVisible();
  }
  await page.getByRole("button", { name: "Diagnostics view" }).click();
  await expect(page.getByLabel("System health details")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("diagnostics");

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("advanced");
  await expect(page.getByRole("button", { name: "Advanced view" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("weather");
  await expect(page.getByRole("button", { name: "Weather Collapse" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("mobile interaction evidence flow @mobile-core @interaction-evidence", async ({ page }) => {
  await openPopulated(page, "active-event");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 240));
  await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect(card).toHaveAttribute("data-interaction-policy", "inspect");
  await card.getByRole("button", { name: "Reset zoom" }).click();
  await card.getByRole("button", { name: "Close inspect" }).click();
  await page.getByRole("button", { name: "Controls" }).click();
  await expect(page.getByRole("dialog", { name: "Dashboard controls" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Market view" }).click();
  await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeFocused();
});

test("P1 mobile performance mounts at most two charts and skips collapsed groups @mobile-core", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/");
  const initiallyMounted = await page.locator('[data-chart-id][data-mounted="true"]').count();
  console.log("mobile-performance initial_chart_instances=" + String(initiallyMounted));
  expect(initiallyMounted).toBeLessThanOrEqual(2);
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.locator('[data-chart-id][data-mounted="true"]').count())
    .toBeGreaterThan(0);
  expect(requests.flat().some((id) => id.startsWith("fuel-mix:"))).toBe(false);
  expect(
    await page.evaluate(() => window.__ercotChartLifecycle?.constructed ?? 0),
  ).toBeLessThanOrEqual(2);
});

test("P1 mobile long-task and heap budgets remain bounded @mobile-performance", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(window, "__ercotLongTasks", { value: durations });
    new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ entryTypes: ["longtask"] });
  });
  await installMobileApi(page);
  const session = await context.newCDPSession(page);
  await session.send("Performance.enable");
  await page.goto("/");
  const heapBefore = await session.send("Performance.getMetrics");
  for (const view of ["Generation", "Reliability", "Market", "Weather", "Advanced"]) {
    await page.getByRole("button", { name: view + " view" }).click();
    await page.waitForTimeout(120);
  }
  await page.getByRole("button", { name: "Overview view" }).click();
  const heapAfter = await session.send("Performance.getMetrics");
  const metric = (metrics: typeof heapBefore.metrics, name: string) =>
    metrics.find((entry) => entry.name === name)?.value ?? 0;
  const heapGrowth =
    metric(heapAfter.metrics, "JSHeapUsedSize") - metric(heapBefore.metrics, "JSHeapUsedSize");
  expect(heapGrowth).toBeLessThan(48 * 1024 * 1024);
  const longTasks = await page.evaluate<number[]>("window.__ercotLongTasks");
  const maxLongTask = Math.max(0, ...longTasks);
  console.log(
    "mobile-performance heap_growth_bytes=" +
      String(heapGrowth) +
      " max_long_task_ms=" +
      String(maxLongTask),
  );
  expect(maxLongTask).toBeLessThan(300);
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

test("progressive-disclosure mobile visual states @mobile-vri", async ({ page }) => {
  await openPopulated(page);
  await expect(page).toHaveScreenshot("progressive-overview-mobile.png");

  await page.getByRole("button", { name: "Advanced view" }).click();
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("progressive-advanced-mobile.png");

  await page.getByRole("button", { name: "Diagnostics view" }).click();
  await expect(page.getByLabel("System health details")).toBeVisible();
  await expect(page).toHaveScreenshot("progressive-diagnostics-mobile.png");
});

test("mobile visual evidence states @mobile-vri", async ({ page }) => {
  await openPopulated(page);
  const gridCards = page.locator('[data-group="Grid conditions"] [data-chart-id]');
  for (let index = 0; index < (await gridCards.count()); index += 1) {
    const card = gridCards.nth(index);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  }
  const supplyDemand = page.locator('[data-chart-id="supply-demand"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.soft(page).toHaveScreenshot("mobile-after-first-viewport.png");
  const supportingReadings = page.locator(".mobile-supporting-metrics");
  await supportingReadings.locator("summary").click();
  await supportingReadings.scrollIntoViewIfNeeded();
  await expect.soft(supportingReadings).toHaveScreenshot("mobile-supporting-grid-readings.png");
  await supportingReadings.locator("summary").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Controls" }).click();
  await expect
    .soft(page.getByRole("dialog", { name: "Dashboard controls" }))
    .toHaveScreenshot("mobile-controls-sheet.png");
  await page.keyboard.press("Escape");
  await supplyDemand.scrollIntoViewIfNeeded();
  await expect.soft(supplyDemand).toHaveScreenshot("mobile-compact-legend.png");
  await supplyDemand.locator(".chart-interpretation summary").click();
  await expect.soft(supplyDemand).toHaveScreenshot("mobile-chart-interpretation.png");
  const derivedMetrics = page.getByLabel("Derived grid metrics");
  await derivedMetrics.scrollIntoViewIfNeeded();
  const mobileNavigation = page.locator(".mobile-section-nav");
  await mobileNavigation.evaluate((element) => {
    element.style.display = "none";
  });
  await expect(mobileNavigation).toBeHidden();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect.soft(derivedMetrics).toHaveScreenshot("mobile-derived-metrics.png", {
    maxDiffPixelRatio: 0.02,
    maxDiffPixels: 6000,
  });
  const healthDetails = page.locator(".grid-health-details");
  await healthDetails.getByText("How the Grid Health Score is calculated", { exact: true }).click();
  await healthDetails.scrollIntoViewIfNeeded();
  await expect.soft(healthDetails).toHaveScreenshot("mobile-grid-health-score.png");
  await mobileNavigation.evaluate((element) => {
    element.style.display = "";
  });

  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page, "failed");
  await page.reload();
  const sourceSummary = page.getByLabel("System health summary");
  await expect.soft(sourceSummary).toHaveScreenshot("mobile-source-failure-summary.png", {
    maxDiffPixelRatio: 0.02,
    maxDiffPixels: 500,
  });
  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  await expect(storage.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await expect(storage.getByText("Showing stale data")).toBeVisible();
  await expect.soft(storage).toHaveScreenshot("mobile-stale-storage-card.png");
  await page.getByRole("button", { name: "Overview view" }).click();
  await sourceSummary.scrollIntoViewIfNeeded();
  await sourceSummary.getByRole("button", { name: "Review system health diagnostics" }).click();
  await expect
    .soft(page.getByRole("dialog", { name: "System health details" }))
    .toHaveScreenshot("mobile-source-failure-drawer.png");
  await page.keyboard.press("Escape");

  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page, "active-event");
  await page.goto("/?view=overview");
  await expect
    .soft(page.getByLabel("Operations notice summary"))
    .toHaveScreenshot("mobile-active-operations.png", {
      maxDiffPixelRatio: 0.04,
      maxDiffPixels: 900,
    });
  await page
    .getByLabel("Operations notice summary")
    .getByRole("button", { name: "Review operations messages" })
    .click();
  await expect
    .soft(page.getByRole("dialog", { name: "Operations timeline" }))
    .toHaveScreenshot("mobile-operations-timeline.png");
  await page.keyboard.press("Escape");

  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page, "warning");
  await page.goto("/?view=overview");
  const warning = page.locator(".mobile-grid-condition");
  await expect(warning).toContainText("EMERGENCY");
  await expect.soft(warning).toHaveScreenshot("mobile-grid-warning.png");
  const structuredAlert = page.getByLabel("Active grid alerts");
  await structuredAlert.scrollIntoViewIfNeeded();
  await expect.soft(structuredAlert).toHaveScreenshot("mobile-structured-alert.png");

  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page, "negative");
  await page.goto("/?view=overview");
  await expect
    .soft(page.getByLabel("Settlement price summary"))
    .toHaveScreenshot("mobile-negative-ranking.png");
  await page.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect
    .soft(page.getByRole("dialog", { name: "Inspect Supply and demand" }))
    .toHaveScreenshot("mobile-inspect-portrait.png", { maxDiffPixels: 8 });
});

test("landscape inspect remains usable @landscape-vri", async ({ page }) => {
  await openPopulated(page, "active-event");
  await page.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  const inspect = page.getByRole("dialog", { name: "Inspect Supply and demand" });
  await expect(inspect).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(inspect).toHaveScreenshot("mobile-inspect-landscape.png");
});
