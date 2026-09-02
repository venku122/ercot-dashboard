import { expect, test, type Page } from "@playwright/test";

import { outlookFixture } from "./mobile-fixtures";

type Scenario =
  | "empty"
  | "empty-panels"
  | "error"
  | "fuel-failed"
  | "missing-core"
  | "negative"
  | "no-events"
  | "normal"
  | "outlook-stale"
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
  if (metric.includes("duty_cycle")) return 12 + wave * 3;
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
  await expect(page.getByText(/Recent comparison unavailable for/)).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" });
  await installApi(page, "empty");
  await page.reload();
  await expect(page.locator('[data-hero-trend="demand"]')).toHaveCount(0);
});

test("derived insights exclude the superseded unconditioned history cards", async ({ page }) => {
  await installApi(page);
  await page.goto("/");

  await page.getByText("Calculated grid insights", { exact: true }).click();
  const metrics = page.getByLabel("Derived grid metrics");
  await expect(metrics.getByRole("article")).toHaveCount(7);
  await expect(metrics.locator('[data-derived-available="true"]')).toHaveCount(7);
  for (const label of [
    "Reserve Margin %",
    "Capacity Utilization %",
    "Renewable %",
    "Storage State",
    "Demand Growth",
    "Forecast Peak",
    "Hours Until Peak",
  ]) {
    await expect(metrics).toContainText(label);
  }
  await expect(metrics.getByText("Formula", { exact: true })).toHaveCount(7);
  await expect(metrics).not.toContainText("Price Percentile");
  await expect(metrics).not.toContainText("Historical Comparison");

  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (payload.queries.every((query) => query.id.startsWith("derived:"))) {
      await route.fulfill({ status: 503, body: "fixture derived history unavailable" });
      return;
    }
    await route.fallback();
  });
  await page.reload();
  for (const id of ["forecast-peak", "hours-until-peak"]) {
    const card = metrics.locator(`[data-derived-metric="${id}"]`);
    await expect(card).toHaveAttribute("data-derived-available", "false");
    await expect(card).toContainText("Required source data or comparison history is unavailable.");
  }
  await expect(page.locator(".global-error")).toHaveCount(0);
});

test("Grid Health Score is concise, bounded, explainable, and coverage-aware", async ({ page }) => {
  await installApi(page);
  await page.goto("/");

  await expect(page.locator(".grid-health-score-value")).toHaveCount(0);
  await expect(page.getByLabel("Current ERCOT status")).not.toContainText("/ 100");
  const summary = page.locator(".grid-health-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/\d+ \/ 100/);
  await expect(summary.locator(".grid-health-contribution")).toHaveCount(8);
  await expect(summary).toContainText("input coverage");

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
  await expect(page.getByText(/Current result: not enough fresh inputs/)).toBeVisible();
  await expect(page.locator(".grid-health-summary")).toContainText("Not enough fresh inputs");
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

test("fixed seven-day windows use canonical v2 aggregate tiles", async ({ page }) => {
  const chunkRequests: string[] = [];
  const tileRequests: string[] = [];
  await installApi(page, "normal", [], chunkRequests);
  const to = FIXED_NOW_SECONDS - 2 * 86_400;
  const from = to - 7 * 86_400;
  const catalogSeries = [
    {
      key: "supply-demand.available-capacity",
      match: "exact",
      metric: "ercot.supply_demand.available_capacity_mw",
      native_interval_seconds: 300,
      rollup: null,
      source: "supply_demand",
      statistic_policy: "power",
      supported_lods: ["native", "5m", "15m", "1h"],
      tags: ["source:supply_demand"],
      unit: "MW",
    },
    {
      key: "supply-demand.demand",
      match: "exact",
      metric: "ercot.supply_demand.demand_mw",
      native_interval_seconds: 300,
      rollup: null,
      source: "supply_demand",
      statistic_policy: "power",
      supported_lods: ["native", "5m", "15m", "1h"],
      tags: ["source:supply_demand"],
      unit: "MW",
    },
    {
      key: "supply-demand.forecast-demand",
      match: "exact",
      metric: "ercot.supply_demand.forecast_demand_mw",
      native_interval_seconds: 3600,
      rollup: null,
      source: "supply_demand",
      statistic_policy: "power",
      supported_lods: ["native", "1h"],
      tags: ["source:supply_demand"],
      unit: "MW",
    },
  ] as const;
  await page.route("**/api/v2/tile-catalog", async (route) => {
    await route.fulfill({
      json: {
        boundary_policy: {
          coarse_partial_clipping: false,
          edge_lod: "native",
          rule: "clients use native boundary tiles and coarse LOD only for aligned interiors",
        },
        derived_resources: [],
        lod_seconds: { "15m": 900, "1h": 3600, "5m": 300, native: null },
        schema: 2,
        series: catalogSeries,
        tile_spans: { "1d": 86_400, "1h": 3600 },
      },
    });
  });
  await page.route("**/api/v2/tiles/**", async (route) => {
    const url = new URL(route.request().url());
    tileRequests.push(url.toString());
    const match = url.pathname.match(
      /^\/api\/v2\/tiles\/([^/]+)\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/,
    );
    expect(match).not.toBeNull();
    const [, seriesKey, tileSpan, tileStartRaw, lod] = match!;
    const definition = catalogSeries.find((entry) => entry.key === seriesKey)!;
    const tileStart = Number(tileStartRaw);
    const tileEnd = tileStart + (tileSpan === "1d" ? 86_400 : 3600);
    const overlapStart = Math.max(tileStart, from);
    const overlapEnd = Math.min(tileEnd, to + 1);
    const nativeInterval = definition.native_interval_seconds;
    const lodSeconds =
      lod === "native" ? nativeInterval : lod === "5m" ? 300 : lod === "15m" ? 900 : 3600;
    const value = definition.key.includes("available-capacity")
      ? 93_000
      : definition.key.includes("forecast")
        ? 70_000
        : 68_000;
    const buckets = [];
    if (lod === "native") {
      const timestamp = overlapStart;
      if (timestamp < overlapEnd) {
        buckets.push({
          end: timestamp,
          start: timestamp,
          state: {
            count: 1,
            first_ordinal: 0,
            first_ts: timestamp,
            first_value: value,
            integral_value_seconds: 0,
            last_ordinal: 0,
            last_ts: timestamp,
            last_value: value,
            maximum: value,
            maximum_ts: timestamp,
            minimum: value,
            minimum_ts: timestamp,
            value_sum: value,
            version: 2,
          },
        });
      }
    } else {
      const bucketStart = Math.ceil(overlapStart / lodSeconds) * lodSeconds;
      if (bucketStart + lodSeconds <= overlapEnd) {
        const lastTimestamp = bucketStart + Math.floor(lodSeconds / 2);
        buckets.push({
          end: bucketStart + lodSeconds,
          start: bucketStart,
          state: {
            count: 2,
            first_ordinal: 0,
            first_ts: bucketStart,
            first_value: value,
            integral_value_seconds: value * (lastTimestamp - bucketStart),
            last_ordinal: 0,
            last_ts: lastTimestamp,
            last_value: value,
            maximum: value,
            maximum_ts: bucketStart,
            minimum: value,
            minimum_ts: bucketStart,
            value_sum: value * 2,
            version: 2,
          },
        });
      }
    }
    await route.fulfill({
      json: {
        boundary_policy: "native_edges_coarse_aligned_interiors",
        buckets,
        lod,
        native_interval_seconds: nativeInterval,
        rollup: null,
        schema: 2,
        series_key: seriesKey,
        statistic_policy: "power",
        tile_end: tileEnd,
        tile_span: tileSpan,
        tile_start: tileStart,
        unit: "MW",
      },
    });
  });
  await page.goto(
    `/?range=604800&live=0&from=${String(from)}&to=${String(to)}&compare=none&events=1`,
  );
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await expect(page.getByText("Viewing a fixed analysis window", { exact: true })).toHaveCount(0);
  await expect.poll(() => tileRequests.length).toBeGreaterThan(0);
  const tileUrls = tileRequests.map((request) => new URL(request));
  expect(tileUrls.every((url) => url.search === "")).toBe(true);
  expect(
    tileUrls.every((url) =>
      /^\/api\/v2\/tiles\/[^/]+\/(?:1h|1d)\/\d+\/(?:native|5m|15m|1h)$/.test(url.pathname),
    ),
  ).toBe(true);
  expect(
    tileUrls.some((url) =>
      /^\/api\/v2\/tiles\/supply-demand\.demand\/1d\/\d+\/15m$/.test(url.pathname),
    ),
  ).toBe(true);
  expect(
    tileUrls.some((url) =>
      /^\/api\/v2\/tiles\/supply-demand\.forecast-demand\/1d\/\d+\/native$/.test(url.pathname),
    ),
  ).toBe(true);
  const mappedMetrics = new Set(catalogSeries.map((entry) => entry.metric));
  expect(
    chunkRequests.filter((request) =>
      mappedMetrics.has(
        new URL(request).searchParams.get("metric") as (typeof catalogSeries)[number]["metric"],
      ),
    ),
  ).toEqual([]);
});

test("live background refresh keeps populated KPI text and dimensions stable", async ({ page }) => {
  await installApi(page, "normal", [], [], true);
  let standardRequests = 0;
  let releaseRefresh = () => {};
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route("**/api/latest/batch", async (route) => {
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; tags: string[] }>;
    };
    if (!payload.queries.some((query) => query.id === "demand")) {
      await route.fallback();
      return;
    }
    standardRequests += 1;
    if (standardRequests > 1) await refreshReleased;
    await route.fulfill({
      json: {
        latest: payload.queries.map((query) => ({
          id: query.id,
          point: {
            tags: query.tags ?? [],
            ts: FIXED_NOW_SECONDS - 30,
            value:
              query.id === "demand" && standardRequests > 1
                ? 71_000
                : metricValue(query.metric, query.tags ?? [], 63, "normal"),
          },
        })),
      },
    });
  });
  await page.goto("/");

  const card = page.locator('[data-metric-id="demand"]');
  const value = card.locator("strong");
  const originalText = await value.textContent();
  const originalBox = await card.boundingBox();
  await page.clock.fastForward(300_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => standardRequests).toBeGreaterThan(1);
  await expect(value).toHaveText(originalText ?? "");
  await expect(card.getByText("Loading…", { exact: true })).toHaveCount(0);
  expect(await card.boundingBox()).toEqual(originalBox);

  releaseRefresh();
  await expect(value).toContainText("71.0 GW");
  expect(await card.boundingBox()).toEqual(originalBox);
});

async function installApi(
  page: Page,
  scenario: Scenario = "normal",
  requests: string[][] = [],
  chunkRequests: string[] = [],
  installClock = false,
) {
  if (installClock) await page.clock.install({ time: FIXED_NOW });
  else await page.clock.setFixedTime(FIXED_NOW);
  await page.route("**/api/v2/tile-catalog", (route) =>
    route.fulfill({ status: 503, body: "fixture v2 catalog unavailable" }),
  );
  await page.route("**/api/v2/tiles/**", (route) =>
    route.fulfill({ status: 503, body: "fixture v2 tile unavailable" }),
  );
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
  await page.route("**/api/v1/outlook", (route) =>
    route.fulfill({ json: outlookFixture(scenario === "outlook-stale") }),
  );
}

test("net-load details remain lazy and accessible in Chromium", async ({ page }) => {
  const netLoadRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("net-load")) netLoadRequests.push(request.url());
  });
  await installApi(page);
  await page.goto("/?view=generation");
  await expect(page.getByRole("heading", { name: "Net load and ramp" })).toBeVisible();
  const disclosure = page.getByRole("button", { name: "Load net-load details" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("table", { name: /exact net-load values/ })).toHaveCount(0);
  expect(netLoadRequests).toEqual([]);
});

test("time, inspect, cursor, legend, compare, events, CSV and URL state", async ({ page }) => {
  const timeChunkRequests: string[] = [];
  await installApi(page, "normal", [], timeChunkRequests);
  await page.goto("/?range=21600&compare=none&events=1");
  await expect(page.getByRole("heading", { name: "ERCOT Grid Status" })).toBeVisible();

  let analyze = await openAnalyze(page);
  await analyze.getByRole("button", { name: "Close Analyze" }).click();
  const timeTrigger = page.getByRole("button", { name: "Choose time range" });
  await timeTrigger.click();
  await page
    .getByRole("dialog", { name: "Time range" })
    .getByRole("button", { name: "Pause" })
    .click();
  await expect(timeTrigger).toContainText("Paused");
  await timeTrigger.click();
  await page.getByRole("button", { name: "Previous window" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("0");
  const fixedFrom = new URL(page.url()).searchParams.get("from");
  expect(fixedFrom).not.toBeNull();
  await timeTrigger.click();
  await page.getByRole("button", { name: "Next window" }).click();
  await expect.poll(() => timeChunkRequests.length).toBeGreaterThan(0);

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
  await timeTrigger.click();
  await page.getByRole("button", { name: "Reset to live" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");
});

test("drag zoom and modified pan update the fixed global window", async ({ page }) => {
  await installApi(page);
  await page.goto("/?compare=previous_period");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute("aria-busy", "false");
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
  await expect.poll(() => new URL(page.url()).searchParams.get("compare")).toBe("previous_period");
  await expect(page.getByRole("button", { name: "Choose time range" })).toContainText("Zoom ·");
  const beforePan = new URL(page.url()).searchParams.get("from");
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 300, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 130, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => new URL(page.url()).searchParams.get("from")).not.toBe(beforePan);
  await card.getByLabel("Supply and demand chart menu").click();
  await page.getByRole("menuitem", { name: "Reset zoom" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");
  await expect(page.getByRole("button", { name: "Choose time range" })).toContainText(
    "Past 6 hours",
  );
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
  const geography = page.getByRole("region", { name: "Where are prices diverging?" });
  await expect(
    geography.getByRole("button", { name: "Load price-geography details" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(geography.getByRole("table")).toHaveCount(0);

  await openMoreView(page, "Diagnostics");
  const diagnostics = page.getByRole("region", { name: "System health details" });
  await expect(diagnostics.getByText("Waiting for first sample…")).toBeVisible();
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
    page.getByRole("heading", { name: "Dashboard outlook — not an ERCOT declaration" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Grid Outlook" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Dashboard views" }).getByRole("button"),
  ).toHaveCount(6);
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
  await expect(page.getByRole("heading", { name: "Instantaneous time error" })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Time error recovery trend" })).toBeAttached();
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

test("direct Outlook loads once without Overview requests and exposes exact values", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
  });
  await installApi(page);
  await page.goto("/?view=outlook");

  await expect(page.getByRole("heading", { name: "Outlook", exact: true })).toBeVisible();
  await expect(page.getByLabel("Global dashboard controls")).toHaveCount(0);
  await expect(page.locator(".freshness-state")).toHaveCount(0);
  await expect(page.getByLabel("Grid Outlook summary")).toBeVisible();
  await expect(page.getByText("Dashboard outlook — not an ERCOT declaration")).toBeVisible();
  await expect(
    page.getByText(
      "Current METAR observations are displayed independently from forecast and load evidence.",
    ),
  ).toBeVisible();
  await page.getByText("Hourly forecast values", { exact: true }).click();
  await expect(page.getByRole("table", { name: "Next 24 hour forecast values" })).toBeVisible();
  await expect(page.getByRole("table", { name: /hourly outlook/ })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("main")).toHaveAttribute("data-overview-refresh", "idle");

  await expect.poll(() => apiRequests.filter((path) => path === "/api/v1/outlook").length).toBe(1);
  const overviewPaths = new Set([
    "/api/latest/batch",
    "/api/series/batch",
    "/api/v1/events",
    "/api/v1/ranking",
    "/api/v1/source-health",
  ]);
  expect(apiRequests.filter((path) => overviewPaths.has(path))).toEqual([]);
});

test("Outlook reports stale forecast input without converting it into an ERCOT status", async ({
  page,
}) => {
  await installApi(page, "outlook-stale");
  await page.goto("/?view=outlook");
  const warning = page.getByLabel("Outlook source freshness");
  await expect(warning).toHaveAttribute("data-outlook-source-state", "partial");
  await expect(warning).toContainText("Load forecast: stale, data stale");
  await expect(page.getByText("Dashboard outlook — not an ERCOT declaration")).toBeVisible();
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

  await page.getByRole("button", { name: "Outlook view" }).click();
  await expect(page.getByLabel("Grid Outlook summary")).toBeVisible();
  await expect(page).toHaveScreenshot("progressive-outlook-desktop.png");

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
    const maxDiffPixelRatio = scenario === "negative" ? 0.025 : scenario === "stale" ? 0.02 : 0.005;
    await expect(card).toHaveScreenshot(`${scenario}-${chartId}.png`, { maxDiffPixelRatio });
  });
}

test("visual regression storage charging", async ({ page }) => {
  await installApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(storage).toHaveAttribute("data-visible", "true");
  await expect(storage.locator(".chart-placeholder")).toHaveCount(0);
  await expect(storage).toHaveScreenshot("storage-charging.png", {
    maxDiffPixelRatio: 0.02,
  });
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
