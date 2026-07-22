import { expect, test, type Page } from "@playwright/test";

type Scenario = "empty" | "error" | "negative" | "normal" | "spike" | "stale";

const FIXED_NOW = new Date("2026-07-21T18:00:00-05:00");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

function metricValue(metric: string, tags: string[], index: number, scenario: Scenario) {
  const wave = Math.sin(index / 5);
  if (metric.includes("demand_mw")) return 68_000 + wave * 3200;
  if (metric.includes("capacity_mw")) return 93_000 + wave * 1800;
  if (metric.includes("Frequency")) return 60 + wave * 0.018;
  if (metric.includes("charging_mw")) return -900 - wave * 500;
  if (metric.includes("discharging_mw")) return 450 + wave * 300;
  if (metric.includes("net_output_mw")) return -450 + wave * 800;
  if (metric.includes("fuel_mix")) {
    if (tags.includes("fuel:wind")) return 18_000 + wave * 2200;
    if (tags.includes("fuel:solar")) return Math.max(0, 12_000 + wave * 9000);
    return 28_000 + wave * 2500;
  }
  if (metric.includes("generation_outages")) return 5000 + wave * 1800;
  if (metric.includes("renewables")) return 15_000 + wave * 4500;
  if (metric.includes("pricing")) {
    if (scenario === "spike" && index === 34) return 5250;
    if (scenario === "negative" && index === 24) return -425;
    return 38 + wave * 22;
  }
  if (metric.includes("DC_Tie")) return wave * 650;
  return 1200 + wave * 350;
}

async function installApi(page: Page, scenario: Scenario = "normal", requests: string[][] = []) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route("**/api/series/batch", async (route) => {
    if (scenario === "error") {
      await route.fulfill({ status: 503, body: "fixture upstream unavailable" });
      return;
    }
    const payload = route.request().postDataJSON() as {
      queries: Array<{
        id: string;
        metric: string;
        since: number;
        tags: string[];
        until: number;
      }>;
    };
    requests.push(payload.queries.map((query) => query.id));
    const series = payload.queries.map((query) => {
      const count = query.id.includes("compare") ? 42 : 64;
      const step = Math.max(60, Math.floor((query.until - query.since) / (count - 1)));
      return {
        id: query.id,
        metric: query.metric,
        points:
          scenario === "empty"
            ? []
            : Array.from({ length: count }, (_, index) => [
                query.since + index * step,
                metricValue(query.metric, query.tags, index, scenario),
              ]),
        meta: {
          since: query.since,
          until: query.until,
          max_points: 1200,
          bucket_seconds: step,
          partial_current_bucket: !query.id.includes("compare"),
        },
      };
    });
    await route.fulfill({ json: { series } });
  });
  await page.route("**/api/latest/batch", async (route) => {
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; tags: string[] }>;
    };
    await route.fulfill({
      json: {
        latest: payload.queries.map((query) => ({
          id: query.id,
          metric: query.metric,
          point: {
            ts: FIXED_NOW_SECONDS - 30,
            value: metricValue(query.metric, query.tags ?? [], 63, scenario),
            tags: query.tags ?? [],
          },
          meta: { age_seconds: 30 },
        })),
      },
    });
  });
  await page.route("**/api/v1/ranking**", async (route) => {
    await route.fulfill({
      json: {
        rows: [
          { tag: "ercot_region:LZ_WEST", ts: FIXED_NOW_SECONDS - 30, value: 92.5 },
          { tag: "ercot_region:HB_HOUSTON", ts: FIXED_NOW_SECONDS - 30, value: 48.25 },
        ],
      },
    });
  });
  await page.route("**/api/v1/source-health", async (route) => {
    const now = FIXED_NOW_SECONDS;
    const sources = [
      ["fuel_mix", "ERCOT Fuel Mix"],
      ["energy_storage", "ERCOT Energy Storage Resources"],
      ["supply_demand", "ERCOT Supply and Demand"],
      ["generation_outages", "ERCOT Generation Outages"],
      ["operations_messages", "ERCOT Operations Messages"],
      ["wind_solar", "ERCOT Combined Wind and Solar"],
    ].map(([sourceId, displayName]) => ({
      source_id: sourceId,
      display_name: displayName,
      expected_interval_seconds: 300,
      last_attempt_ts: now - 30,
      last_success_ts: now - 30,
      source_timestamp_ts:
        scenario === "stale" && sourceId === "energy_storage" ? now - 4000 : now - 60,
      last_row_count: 25,
      consecutive_failures: scenario === "stale" && sourceId === "energy_storage" ? 3 : 0,
      last_error: scenario === "stale" && sourceId === "energy_storage" ? "fixture timeout" : null,
      age_seconds: scenario === "stale" && sourceId === "energy_storage" ? 4000 : 60,
      state: scenario === "stale" && sourceId === "energy_storage" ? "failed" : "healthy",
      collection_age_seconds: 30,
      collection_state:
        scenario === "stale" && sourceId === "energy_storage" ? "failed" : "healthy",
      data_age_seconds: scenario === "stale" && sourceId === "energy_storage" ? 4000 : 60,
      freshness_state: scenario === "stale" && sourceId === "energy_storage" ? "stale" : "fresh",
      publication_mode: sourceId === "operations_messages" ? "event" : "polling",
      publication_interval_seconds: 300,
    }));
    await route.fulfill({ json: { sources, summary: {}, as_of: now } });
  });
  await page.route("**/api/v1/events**", async (route) => {
    const now = FIXED_NOW_SECONDS;
    await route.fulfill({
      json: {
        events: [
          {
            dedupe_key: "fixture:event",
            source_id: "operations_messages",
            starts_at: now - 1800,
            observed_at: now - 1800,
            event_type: "Operational Information",
            status: "Active",
            severity: "warning",
            title: "Fixture operations message: DC tie unavailable during the selected window.",
          },
        ],
      },
    });
  });
}

test("time, inspect, cursor, legend, compare, events, CSV and URL state", async ({ page }) => {
  await installApi(page);
  await page.goto("/?range=21600&compare=none&events=1");
  await expect(page.getByRole("heading", { name: "ERCOT analytical dashboard" })).toBeVisible();
  await expect(page.getByText("Fixture operations message", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Latest settlement point prices" })).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Live paused")).toBeVisible();
  await page.getByRole("button", { name: "Previous time window" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("0");
  const fixedFrom = new URL(page.url()).searchParams.get("from");
  expect(fixedFrom).not.toBeNull();
  await page.getByRole("button", { name: "Next time window" }).click();

  await page.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect(page.locator('[data-chart-id="supply-demand"]')).toHaveClass(/chart-card-inspect/);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-chart-id="supply-demand"]')).not.toHaveClass(
    /chart-card-inspect/,
  );

  const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
  await canvas.hover({ position: { x: 240, y: 120 } });
  await canvas.click({ position: { x: 240, y: 120 } });
  await expect(page.getByText("cursor pinned").first()).toBeVisible();
  await page.keyboard.press("Escape");

  const demandLegend = page.getByRole("button", { name: "Actual demand", exact: true });
  await demandLegend.click();
  await expect(demandLegend).toHaveAttribute("aria-pressed", "false");
  await demandLegend.click();
  await page.getByRole("button", { name: "Solo Actual demand" }).click();
  await expect(page.getByRole("button", { name: "Forecast demand", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByLabel("Supply and demand chart menu").click();
  await expect(page.getByRole("menuitem", { name: "Open inspect" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Enable comparison" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("compare")).toBe("previous_period");
  await page.getByRole("menuitem", { name: "Disable comparison" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("compare")).toBe("none");
  await page.getByLabel("Supply and demand chart menu").click();

  await page.getByLabel("Compare time").selectOption("custom");
  await page.getByLabel("Custom comparison offset hours").fill("48");
  await expect.poll(() => new URL(page.url()).searchParams.get("compare")).toBe("custom");
  await expect.poll(() => new URL(page.url()).searchParams.get("compare_offset")).toBe("172800");

  await page.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await page.getByLabel("Supply and demand chart menu").click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("ercot-supply-demand.csv");
  await page.getByRole("menuitem", { name: "Reset zoom" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("0");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reset to live" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");
});

test("drag zoom and modified pan update the fixed global window", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await expect
    .poll(() => page.evaluate(() => window.__ercotChartLifecycle?.updated ?? 0))
    .toBeGreaterThan(0);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas missing bounds");
  await page.mouse.move(box.x + 120, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 130, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("0");
  const beforePan = new URL(page.url()).searchParams.get("from");
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 300, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 130, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => new URL(page.url()).searchParams.get("from")).not.toBe(beforePan);
});

test("failure, no-data distinction, and stale source state are explicit", async ({ page }) => {
  await installApi(page, "error");
  await page.goto("/");
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect(page.getByRole("alert")).toContainText("not an empty-data state");

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "empty");
  await page.reload();
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect(page.getByText("No observations in this window.").first()).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "stale");
  await page.reload();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  await expect(storage.getByText("failed", { exact: false }).first()).toBeVisible();
  await expect(storage.getByText("Showing stale data")).toBeVisible();
});

test("lazy mounting, browser long tasks, and heap remain bounded", async ({ page }) => {
  await page.addInitScript(() => {
    const durations: number[] = [];
    Object.defineProperty(window, "__ercotLongTasks", { value: durations });
    new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ entryTypes: ["longtask"] });
  });
  await installApi(page);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await page.goto("/");
  const total = await page.locator("[data-chart-id]").count();
  const initiallyMounted = await page.locator('[data-chart-id][data-mounted="true"]').count();
  const initiallyVisible = await page.locator('[data-chart-id][data-visible="true"]').count();
  expect(total).toBe(19);
  expect(initiallyMounted).toBeLessThanOrEqual(4);
  expect(initiallyVisible).toBeLessThanOrEqual(4);
  const heapBefore = await session.send("Performance.getMetrics");
  await page.locator('[data-chart-id="pricing"]').scrollIntoViewIfNeeded();
  await expect
    .poll(() => windowLifecycle(page).then((value) => value?.constructed ?? 0))
    .toBeGreaterThan(initiallyMounted);
  const beforeChurn = await page.evaluate(() => window.__ercotChartLifecycle);
  await page.getByLabel("Compare time").selectOption("week");
  await page.getByLabel("Compare time").selectOption("none");
  const lifecycle = await page.evaluate(() => window.__ercotChartLifecycle);
  expect(lifecycle?.constructed).toBe(beforeChurn?.constructed);
  expect(lifecycle?.destroyed).toBe(beforeChurn?.destroyed);
  expect(lifecycle?.updated).toBeGreaterThan(initiallyMounted);
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.locator('[data-chart-id][data-visible="true"]').count())
    .toBeLessThanOrEqual(4);
  const heapAfter = await session.send("Performance.getMetrics");
  const metric = (metrics: typeof heapBefore.metrics, name: string) =>
    metrics.find((entry) => entry.name === name)?.value ?? 0;
  const heapGrowth =
    metric(heapAfter.metrics, "JSHeapUsedSize") - metric(heapBefore.metrics, "JSHeapUsedSize");
  expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
  const longTasks = await page.evaluate<number[]>("window.__ercotLongTasks");
  expect(Math.max(0, ...longTasks)).toBeLessThan(500);
});

async function windowLifecycle(page: Page) {
  return page.evaluate(() => window.__ercotChartLifecycle);
}

test("inactive and collapsed groups are not requested and legacy parity views are present", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installApi(page, "normal", requests);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unused capacity and headroom" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Time error and delta" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "System inertia" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Emergency Energy Alert level" })).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "PowerOutage.us customer outages" }),
  ).toBeAttached();
  await expect(page.getByRole("heading", { name: "Nearby METAR temperature" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Collector duty cycle" })).toBeAttached();
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests.flat().some((id) => id.startsWith("pricing:"))).toBe(false);

  await page.getByRole("button", { name: "Grid conditions Collapse" }).click();
  const requestCount = requests.length;
  await page.getByLabel("Compare time").selectOption("week");
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(requestCount);
  const gridPrefixes = [
    "supply-demand:",
    "frequency:",
    "reserves:",
    "capacity-headroom:",
    "time-error:",
    "inertia:",
  ];
  expect(
    requests
      .slice(requestCount)
      .flat()
      .some((id) => gridPrefixes.some((prefix) => id.startsWith(prefix))),
  ).toBe(false);
});

for (const scenario of ["normal", "spike", "negative", "stale"] as const) {
  test(`visual regression ${scenario}`, async ({ page }) => {
    await installApi(page, scenario);
    await page.goto("/");
    const chartId =
      scenario === "normal" ? "supply-demand" : scenario === "stale" ? "storage" : "pricing";
    const card = page.locator(`[data-chart-id="${chartId}"]`);
    await card.evaluate((element) => element.scrollIntoView({ block: "end" }));
    await expect(card).toHaveAttribute("data-visible", "true");
    await expect(card.locator(".chart-placeholder")).toHaveCount(0);
    await expect(card).toHaveScreenshot(`${scenario}-${chartId}.png`);
  });
}

test("visual regression storage charging and operations event", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(storage).toHaveAttribute("data-visible", "true");
  await expect(storage.locator(".chart-placeholder")).toHaveCount(0);
  await expect(storage).toHaveScreenshot("storage-charging.png");
  const events = page.getByRole("region", { name: "ERCOT operations messages" });
  await events.scrollIntoViewIfNeeded();
  await expect(events).toHaveScreenshot("operations-event.png");
});

test("visual regression analytical dashboard", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const cards = page.locator("[data-chart-id]");
  for (let index = 0; index < (await cards.count()); index += 1) {
    await cards.nth(index).scrollIntoViewIfNeeded();
  }
  await expect(page.locator(".chart-placeholder")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page).toHaveScreenshot("analytical-dashboard.png", { fullPage: true });
});
