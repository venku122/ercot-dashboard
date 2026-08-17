import { expect, test, type Page } from "@playwright/test";

type Scenario =
  | "empty"
  | "empty-panels"
  | "error"
  | "fuel-failed"
  | "missing-core"
  | "negative"
  | "no-events"
  | "normal"
  | "spike"
  | "stale";

const FIXED_NOW = new Date("2026-07-21T18:00:00-05:00");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

async function openMoreView(page: Page, name: "Advanced" | "Diagnostics" | "Weather") {
  await page.getByRole("button", { name: /More views/ }).click();
  await page
    .getByRole("navigation", { name: "More dashboard views" })
    .getByRole("button", { name })
    .click();
}

async function openAnalyze(page: Page) {
  await page.getByRole("button", { name: "Analyze" }).click();
  return page.getByRole("dialog", { name: "Analyze" });
}

function metricValue(metric: string, tags: string[], index: number, scenario: Scenario) {
  const wave = Math.sin(index / 5);
  if (metric.includes("demand_mw")) return 68_000 + wave * 3200;
  if (metric.includes("capacity_mw")) return 93_000 + wave * 1800;
  if (metric.includes("Frequency")) return 60 + wave * 0.018;
  if (metric.includes("charging_mw")) return -900 - wave * 500;
  if (metric.includes("discharging_mw")) return 450 + wave * 300;
  if (metric.includes("net_output_mw")) return -450 + wave * 800;
  if (metric.includes("eea_level")) return 0;
  if (metric.includes("metar.temperature")) return 31 + wave * 4;
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

test("hero metrics expose honest hourly direction, delta, and timestamp", async ({ page }) => {
  await installApi(page);
  await page.goto("/");

  for (const id of [
    "demand",
    "available-capacity",
    "reserve-margin",
    "frequency",
    "real-time-price",
  ]) {
    const trend = page.locator(`[data-hero-trend="${id}"]`);
    await expect(trend).toBeVisible();
    await expect(trend).toHaveAttribute("aria-label", /Last hour/);
    await expect(trend.locator("time")).toHaveCount(1);
  }
  await expect(page.locator('[data-hero-trend="demand"]')).toHaveAttribute(
    "aria-label",
    /increasing|decreasing|unchanged/,
  );
  await expect(page.locator('[data-hero-trend="grid-status"]')).toHaveCount(0);

  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (payload.queries.every((query) => query.id.startsWith("hero:"))) {
      await route.fulfill({ status: 503, body: "fixture trend history unavailable" });
      return;
    }
    await route.fallback();
  });
  await page.reload();
  await expect(page.locator('[data-metric-id="demand"] strong')).toContainText("GW");
  await expect(page.locator('[data-hero-trend="demand"]')).toHaveCount(0);
  await expect(page.getByText(/Recent comparison unavailable for/)).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "empty");
  await page.reload();
  await expect(page.locator('[data-hero-trend="demand"]')).toHaveCount(0);
});

test("derived insights expose nine formulas and honest history availability", async ({ page }) => {
  await installApi(page);
  await page.goto("/");

  await page.getByText("Calculated grid insights", { exact: true }).click();
  const metrics = page.getByLabel("Derived grid metrics");
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
    await expect(metrics).toContainText(label);
  }
  await expect(metrics.getByText("Formula", { exact: true })).toHaveCount(9);

  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (payload.queries.every((query) => query.id.startsWith("derived:"))) {
      await route.fulfill({ status: 503, body: "fixture derived history unavailable" });
      return;
    }
    await route.fallback();
  });
  await page.reload();
  for (const id of [
    "forecast-peak",
    "hours-until-peak",
    "price-percentile",
    "historical-comparison",
  ]) {
    const card = metrics.locator(`[data-derived-metric="${id}"]`);
    await expect(card).toHaveAttribute("data-derived-available", "false");
    await expect(card).toContainText("Required source data or comparison history is unavailable.");
  }
  await expect(page.locator(".global-error")).toHaveCount(0);
});

test("Grid Health Score is details-only, bounded, explainable, and coverage-aware", async ({
  page,
}) => {
  await installApi(page);
  await page.goto("/");

  await expect(page.locator(".grid-health-score-value")).toHaveCount(0);
  await expect(page.getByLabel("Current ERCOT status")).not.toContainText("/ 100");

  const explanation = page.getByText("How status is determined", { exact: true });
  await explanation.click();
  await expect(page.getByText(/Current result: \d+ \/ 100/)).toBeVisible();
  await expect(page.getByLabel("Grid Health Score factors").getByRole("listitem")).toHaveCount(8);
  await expect(page.getByLabel("Grid Health Score factors")).toContainText("Reserve margin");
  await expect(page.getByLabel("Grid Health Score factors")).toContainText("Forecast pressure");
  await expect(page.getByText(/Score bands: NORMAL 85–100/)).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "empty");
  await page.reload();
  await explanation.click();
  await expect(page.getByText(/Current result: \d+ \/ 100 · 90% weighted coverage/)).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "missing-core");
  await page.reload();
  await explanation.click();
  await expect(page.getByText(/Current result: unavailable/)).toBeVisible();
});

test("chart thresholds pair semantic bands with non-color interpretation text", async ({
  page,
}) => {
  await installApi(page);
  await page.goto("/");

  const demand = page.locator('[data-chart-id="supply-demand"]');
  await demand.scrollIntoViewIfNeeded();
  await expect(demand.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await demand.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
  await expect(demand.locator(".chart-interpretation")).toHaveAttribute("open", "");
  await expect(
    demand.getByLabel("Supply and demand interpretation bands").getByRole("listitem"),
  ).toHaveCount(4);
  await expect(demand.getByText("Comfortable", { exact: true })).toBeVisible();
  await expect(demand.getByText("80.0%–90.0%", { exact: true })).toBeVisible();
  await expect(demand.getByText(/Waiting for latest available capacity/)).toHaveCount(0);
  await expect(demand.locator("canvas")).toHaveAttribute(
    "aria-label",
    /Interpretation guide for actual demand.*Comfortable.*Above capacity/,
  );
  await page.keyboard.press("Escape");

  const frequency = page.locator('[data-chart-id="frequency"]');
  await frequency.scrollIntoViewIfNeeded();
  await expect(
    frequency.getByLabel("Grid frequency interpretation bands").getByRole("listitem"),
  ).toHaveCount(7);
  await expect(frequency.getByText("Near nominal", { exact: true })).toBeVisible();
  await expect(frequency.locator("canvas")).toHaveAttribute(
    "aria-label",
    /Near nominal, 59.950 Hz–60.050 Hz/,
  );
});

test("production regression fixture keeps actual demand and available capacity visible", async ({
  page,
}) => {
  await installApi(page);
  await page.goto("/");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.getByRole("button", { name: "Actual demand", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Available capacity", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Forecast demand", exact: true })).toBeVisible();
  await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
});

test("fixed seven-day windows use canonical cacheable history chunks", async ({ page }) => {
  const chunkRequests: string[] = [];
  await installApi(page, "normal", [], chunkRequests);
  const to = FIXED_NOW_SECONDS - 2 * 86_400;
  const from = to - 7 * 86_400;
  await page.goto(
    `/?range=604800&live=0&from=${String(from)}&to=${String(to)}&compare=none&events=1`,
  );
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect.poll(() => chunkRequests.length).toBeGreaterThan(0);
  expect(chunkRequests.every((url) => url.includes("chunk_seconds=86400"))).toBe(true);
});

async function installApi(
  page: Page,
  scenario: Scenario = "normal",
  requests: string[][] = [],
  chunkRequests: string[] = [],
) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route("**/api/v1/series/chunk**", async (route) => {
    const url = new URL(route.request().url());
    chunkRequests.push(url.toString());
    const metric = url.searchParams.get("metric") ?? "fixture";
    const tags = url.searchParams.getAll("tag");
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    const resolution = Number(url.searchParams.get("resolution"));
    const points: Array<[number, number]> = [];
    for (let timestamp = start; timestamp < end; timestamp += resolution) {
      points.push([
        timestamp,
        metricValue(metric, tags, Math.round((timestamp - start) / resolution), scenario),
      ]);
    }
    await route.fulfill({
      json: { aggregation: "average", end, metric, points, resolution, start, tags },
    });
  });
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
          scenario === "empty" || (scenario === "fuel-failed" && query.metric.includes("fuel_mix"))
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
          point:
            scenario === "missing-core" && query.id === "frequency"
              ? null
              : {
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
        rows:
          scenario === "empty-panels"
            ? []
            : [
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
      consecutive_failures:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? 3
          : 0,
      last_error:
        scenario === "stale" && sourceId === "energy_storage"
          ? "fixture timeout"
          : scenario === "fuel-failed" && sourceId === "fuel_mix"
            ? "fixture schema drift"
            : null,
      age_seconds:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? 4000
          : 60,
      state:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? "failed"
          : "healthy",
      collection_age_seconds: 30,
      collection_state:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? "failed"
          : "healthy",
      data_age_seconds:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? 4000
          : 60,
      freshness_state:
        (scenario === "stale" && sourceId === "energy_storage") ||
        (scenario === "fuel-failed" && sourceId === "fuel_mix")
          ? "stale"
          : "fresh",
      publication_mode: sourceId === "operations_messages" ? "event" : "polling",
      publication_interval_seconds: 300,
    }));
    await route.fulfill({
      json: { sources: scenario === "empty-panels" ? [] : sources, summary: {}, as_of: now },
    });
  });
  await page.route("**/api/v1/events**", async (route) => {
    const now = FIXED_NOW_SECONDS;
    await route.fulfill({
      json: {
        events:
          scenario === "no-events"
            ? []
            : [
                {
                  dedupe_key: "fixture:event:transmission",
                  source_id: "operations_messages",
                  starts_at: now - 1800,
                  observed_at: now - 1800,
                  event_type: "Operational Information",
                  status: "Active",
                  severity: "warning",
                  title:
                    "Fixture operations message: DC tie unavailable during the selected window.",
                },
                {
                  dedupe_key: "fixture:event:heat",
                  source_id: "operations_messages",
                  starts_at: now - 3600,
                  event_type: "Advisory",
                  status: "Closed",
                  severity: "information",
                  title: "Heat advisory asked consumers to conserve during the afternoon peak.",
                },
                {
                  dedupe_key: "fixture:event:generator",
                  source_id: "operations_messages",
                  starts_at: now - 5400,
                  event_type: "Operational Information",
                  status: "Closed",
                  severity: "warning",
                  title:
                    "Generator unit trip removed 620 MW before the resource returned to service.",
                },
                {
                  dedupe_key: "fixture:event:reserve",
                  source_id: "operations_messages",
                  starts_at: now - 7200,
                  event_type: "Operational Information",
                  status: "Closed",
                  severity: "watch",
                  title: "Reserve watch ended after Physical Responsive Capability recovered.",
                },
                {
                  dedupe_key: "fixture:event:eea",
                  source_id: "operations_messages",
                  starts_at: now - 9000,
                  event_type: "Emergency Notice",
                  status: "Closed",
                  severity: "emergency",
                  title: "EEA Level 2 ended after operating reserves stabilized.",
                },
              ],
      },
    });
  });
}

test("time, inspect, cursor, legend, compare, events, CSV and URL state", async ({ page }) => {
  await installApi(page);
  await page.goto("/?range=21600&compare=none&events=1");
  await expect(page.getByRole("heading", { name: "ERCOT Grid Status" })).toBeVisible();
  await page.getByRole("button", { name: "Reliability view" }).click();
  await expect(
    page
      .getByLabel("ERCOT operations messages")
      .getByText("Fixture operations message", { exact: false }),
  ).toBeVisible();
  const operations = page.getByLabel("ERCOT operations messages");
  await expect(
    operations.getByLabel("Historical operations timeline").getByRole("listitem"),
  ).toHaveCount(5);
  for (const category of [
    "Heat advisory",
    "Generator trip",
    "Reserve watch",
    "EEA",
    "Transmission event",
  ]) {
    await expect(operations.getByText(category, { exact: true })).toBeVisible();
  }
  await operations.getByLabel("Filter operations timeline by severity").selectOption("watch");
  await expect(
    operations.getByLabel("Historical operations timeline").getByRole("listitem"),
  ).toHaveCount(2);
  await expect(operations).toContainText("Showing 2 of 5 events");
  await operations.getByLabel("Filter operations timeline by severity").selectOption("all");
  await page.getByRole("button", { name: "Market view" }).click();
  await expect(page.getByRole("heading", { name: "Latest settlement point prices" })).toBeVisible();

  await page.getByRole("button", { name: "Overview view" }).click();

  let analyze = await openAnalyze(page);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText(/Paused · updated/)).toBeVisible();
  await page.getByRole("button", { name: "Previous time window" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("0");
  const fixedFrom = new URL(page.url()).searchParams.get("from");
  expect(fixedFrom).not.toBeNull();
  await page.getByRole("button", { name: "Next time window" }).click();
  await analyze.getByRole("button", { name: "Close Analyze" }).click();

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

  analyze = await openAnalyze(page);
  await analyze.getByLabel("Compare time").selectOption("custom");
  await analyze.getByLabel("Custom comparison offset hours").fill("48");
  await expect.poll(() => new URL(page.url()).searchParams.get("compare")).toBe("custom");
  await expect.poll(() => new URL(page.url()).searchParams.get("compare_offset")).toBe("172800");
  await analyze.getByRole("button", { name: "Close Analyze" }).click();

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
  analyze = await openAnalyze(page);
  await analyze.getByRole("button", { name: "Reset to live" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");
});

test("drag zoom and modified pan update the fixed global window", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  const canvas = card.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  await canvas.scrollIntoViewIfNeeded();
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
  const errorAlert = page.getByLabel("Active grid alerts");
  await errorAlert.locator("summary").click();
  await expect(errorAlert).toContainText("not an empty-data state");
  const failedCard = page.locator('[data-chart-id="supply-demand"]');
  await expect(failedCard.getByText("Temporarily unavailable…")).toBeVisible();
  await expect(failedCard.getByText("Waiting for first sample…")).toBeHidden();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "empty");
  await page.reload();
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  const emptyCard = page.locator('[data-chart-id="supply-demand"]');
  await expect(emptyCard.getByText("Waiting for first sample…")).toBeVisible();
  await expect(emptyCard.getByText("Temporarily unavailable…")).toBeHidden();
  await expect(emptyCard.locator(".chart-interpretation")).toHaveCount(0);
  await expect(emptyCard.locator(".series-legend")).toHaveCount(0);
  await expect(emptyCard.locator(".accessible-data")).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "stale");
  await page.reload();
  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  await expect(storage.getByText("Data stale", { exact: false }).first()).toBeVisible();
  await expect(storage.getByText("Showing stale data")).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "fuel-failed");
  await page.reload();
  await page.getByRole("button", { name: "Generation view" }).click();
  const fuelMix = page.locator('[data-chart-id="fuel-mix"]');
  await fuelMix.scrollIntoViewIfNeeded();
  await expect(fuelMix.getByText("Fuel mix generation unavailable")).toBeVisible();
  await expect(fuelMix.getByText(/Collection failed · last valid observation/)).toBeVisible();
  await expect(fuelMix.getByText("Waiting for first sample…")).toHaveCount(0);
});

test("loading resolves to a first-sample wait without blank chart detail", async ({ page }) => {
  await installApi(page, "empty");
  let releaseSeries: (() => void) | undefined;
  const heldSeries = new Promise<void>((resolve) => {
    releaseSeries = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    await heldSeries;
    await route.fallback();
  });
  await page.goto("/");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText("Loading…")).toBeVisible();
  releaseSeries?.();
  await expect(card.getByText("Waiting for first sample…")).toBeVisible();
});

test("empty optional panels collapse to lifecycle or selected-range states", async ({ page }) => {
  await installApi(page, "empty-panels");
  await page.goto("/?view=market");
  const ranking = page.getByRole("region", { name: "Settlement price ranking" });
  await expect(ranking.getByText("Waiting for first sample…")).toBeVisible();
  await expect(ranking.getByRole("table")).toHaveCount(0);

  await openMoreView(page, "Diagnostics");
  const diagnostics = page.getByRole("region", { name: "System health details" });
  await expect(diagnostics.getByText("Waiting for first sample…")).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "no-events");
  await page.goto("/?view=reliability");
  await expect(page.getByText("No events during selected range.")).toBeVisible();
});

test("visual regression empty lifecycle state", async ({ page }) => {
  await page.setViewportSize({ height: 1200, width: 1280 });
  await installApi(page, "empty");
  await page.goto("/");
  await page.addStyleTag({
    content: ".control-bar, .desktop-view-nav { display: none !important; }",
  });
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveScreenshot("empty-lifecycle-chart-desktop.png");
});

test("alerts are actionable, interpretive, material, and free of collector noise", async ({
  page,
}) => {
  await installApi(page);
  await page.goto("/");
  const alerts = page.getByLabel("Active grid alerts");
  await alerts.locator("summary").click();
  await expect(alerts.getByRole("article")).toHaveCount(1);
  await expect(alerts).toContainText("warning");
  await expect(alerts).toContainText("Cause");
  await expect(alerts).toContainText("Impact");
  await expect(alerts).toContainText("Recommended action");
  await alerts.getByRole("button", { name: "Review operations" }).click();
  await expect(page.getByRole("dialog", { name: "Operations timeline" })).toContainText(
    "Fixture operations message",
  );
  await page.keyboard.press("Escape");

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "stale");
  await page.reload();
  await expect(alerts).not.toContainText("Critical data limited");
  await expect(alerts).not.toContainText("fixture timeout");
});

test("system health is summarized by default with full diagnostics on demand", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  await openMoreView(page, "Diagnostics");
  const summary = page.getByLabel("System health summary");
  await expect(summary).toContainText("Data Sources Healthy");
  await expect(summary).not.toContainText("ERCOT Fuel Mix:");
  const details = page.getByLabel("System health details");
  await expect(details).toContainText("ERCOT Fuel Mix");
  await expect(details).toContainText("Collection healthy · data fresh");

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "stale");
  await page.reload();
  await expect(summary).toContainText("1 Data Source Needs Attention");
  await expect(summary).toContainText("Energy Storage Resources failed");
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
  await expect.poll(() => page.locator("[data-chart-id]").count()).toBe(2);
  const total = await page.locator("[data-chart-id]").count();
  const initiallyMounted = await page.locator('[data-chart-id][data-mounted="true"]').count();
  const initiallyVisible = await page.locator('[data-chart-id][data-visible="true"]').count();
  expect(total).toBe(2);
  await expect(page.locator('[data-chart-id="time-error"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More views" })).toBeVisible();
  expect(initiallyMounted).toBeLessThanOrEqual(4);
  expect(initiallyVisible).toBeLessThanOrEqual(4);
  const heapBefore = await session.send("Performance.getMetrics");
  await page.getByRole("button", { name: "Market view" }).click();
  await page.locator('[data-chart-id="pricing"]').scrollIntoViewIfNeeded();
  await expect
    .poll(() => windowLifecycle(page).then((value) => value?.constructed ?? 0))
    .toBeGreaterThan(initiallyMounted);
  const beforeChurn = await page.evaluate(() => window.__ercotChartLifecycle);
  const analyze = await openAnalyze(page);
  await analyze.getByLabel("Compare time").selectOption("week");
  await analyze.getByLabel("Compare time").selectOption("none");
  await analyze.getByRole("button", { name: "Close Analyze" }).click();
  const lifecycle = await page.evaluate(() => window.__ercotChartLifecycle);
  expect(lifecycle?.constructed).toBe(beforeChurn?.constructed);
  expect(lifecycle?.destroyed).toBe(beforeChurn?.destroyed);
  expect(lifecycle?.updated).toBeGreaterThan(initiallyMounted);
  await page.getByRole("button", { name: "Overview view" }).click();
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

test("inactive views are not requested and all legacy parity surfaces remain reachable", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installApi(page, "normal", requests);
  await page.goto("/");
  const currentStatus = page.getByLabel("Current ERCOT status");
  await expect(currentStatus).toBeVisible();
  await expect(
    currentStatus.locator(".status-strip-item").first().locator("strong"),
  ).toHaveAttribute("aria-label", /ERCOT grid watch active|No active ERCOT emergency/);
  await expect(page.getByLabel("Featured grid trend")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Dashboard views" }).getByRole("button"),
  ).toHaveCount(5);
  await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests.flat().some((id) => id.startsWith("pricing:"))).toBe(false);

  await page.getByRole("button", { name: "Reliability view" }).click();
  await expect(page.getByRole("heading", { name: "Unused capacity and headroom" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Emergency Energy Alert level" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "PowerOutage.us customer outages" })).toHaveCount(
    0,
  );

  await openMoreView(page, "Weather");
  await expect(page.getByRole("heading", { name: "Nearby METAR temperature" })).toBeAttached();

  await openMoreView(page, "Advanced");
  await expect(page.getByRole("heading", { name: "Time error and delta" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "System inertia" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Collector duty cycle" })).toHaveCount(0);

  await openMoreView(page, "Diagnostics");
  await expect(page.getByRole("heading", { name: "Collector duty cycle" })).toBeAttached();

  await page.getByRole("button", { name: "Market view" }).click();
  await page.locator('[data-chart-id="pricing"]').scrollIntoViewIfNeeded();
  await expect.poll(() => requests.flat().some((id) => id.startsWith("pricing:"))).toBe(true);
  const requestCount = requests.length;
  const analyze = await openAnalyze(page);
  await analyze.getByLabel("Compare time").selectOption("week");
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(requestCount);
  const hiddenViewPrefixes = ["supply-demand:", "frequency:", "time-error:", "inertia:"];
  expect(
    requests
      .slice(requestCount)
      .flat()
      .some((id) => hiddenViewPrefixes.some((prefix) => id.startsWith(prefix))),
  ).toBe(false);
});

test("view changes clear chart-specific inspect state and legacy inspect links find their view", async ({
  page,
}) => {
  await installApi(page);
  await page.goto("/?inspect=storage");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("generation");
  await expect(page.locator('[data-chart-id="storage"]')).toHaveClass(/chart-card-inspect/);

  await page.getByRole("button", { name: "Market view" }).evaluate((button: HTMLButtonElement) => {
    button.click();
  });
  await expect.poll(() => new URL(page.url()).searchParams.get("inspect")).toBeNull();
  await expect(page.locator(".inspect-backdrop")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("visual regression progressive-disclosure desktop views", async ({ page }) => {
  await installApi(page);
  await page.goto("/?view=overview");
  await expect(page).toHaveScreenshot("progressive-overview-desktop.png");

  await openMoreView(page, "Advanced");
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("progressive-advanced-desktop.png");

  await openMoreView(page, "Diagnostics");
  await expect(page.getByLabel("System health details")).toBeVisible();
  await expect(page).toHaveScreenshot("progressive-diagnostics-desktop.png");
});

for (const scenario of ["normal", "spike", "negative", "stale"] as const) {
  test(`visual regression ${scenario}`, async ({ page }) => {
    await installApi(page, scenario);
    await page.goto("/");
    if (scenario === "stale") await page.getByRole("button", { name: "Generation view" }).click();
    if (scenario === "spike" || scenario === "negative") {
      await page.getByRole("button", { name: "Market view" }).click();
    }
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
  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(storage).toHaveAttribute("data-visible", "true");
  await expect(storage.locator(".chart-placeholder")).toHaveCount(0);
  await expect.soft(storage).toHaveScreenshot("storage-charging.png");
  await page.getByRole("button", { name: "Reliability view" }).click();
  const events = page.getByRole("region", { name: "ERCOT operations messages" });
  await events.scrollIntoViewIfNeeded();
  await expect.soft(events).toHaveScreenshot("operations-event.png");
});

test("visual regression structured operational alert", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const alert = page.getByLabel("Active grid alerts");
  await expect(alert).toContainText("Recommended action");
  await expect(alert).toHaveScreenshot("structured-operational-alert.png");
});

test("visual regression Grid Health Score", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const scoreDetails = page.locator(".grid-health-details");
  await scoreDetails.getByText("How status is determined", { exact: true }).click();
  await expect(page.getByLabel("Grid Health Score factors").getByRole("listitem")).toHaveCount(8);
  await expect(scoreDetails).toHaveScreenshot("grid-health-score.png");
});

test("visual regression analytical dashboard", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  const cards = page.locator("[data-chart-id]");
  await expect(cards).toHaveCount(2);
  for (let index = 0; index < (await cards.count()); index += 1) {
    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute("data-mounted", "true");
  }
  await expect(page.locator(".chart-placeholder")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page).toHaveScreenshot("analytical-dashboard.png", { fullPage: true });
});
