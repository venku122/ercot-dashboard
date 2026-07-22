import type { Page } from "@playwright/test";

export type MobileScenario =
  | "active-event"
  | "delayed"
  | "empty"
  | "error"
  | "failed"
  | "fuel-mix"
  | "negative"
  | "normal"
  | "quiet"
  | "spike"
  | "storage"
  | "warning";

export const FIXED_NOW = new Date("2026-07-21T18:00:00-05:00");
export const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);
export const LONG_SOURCE_ERROR =
  "Upstream settlement archive rejected the collector checkpoint after a gateway timeout; retry is scheduled and stale historical data remains available for review.";

function metricValue(metric: string, tags: string[], index: number, scenario: MobileScenario) {
  const wave = Math.sin(index / 5);
  if (metric.includes("demand_mw")) return 68_200 + wave * 3200;
  if (metric.includes("capacity_mw")) return 88_500 + wave * 1800;
  if (metric.includes("Frequency")) return 60.001 + wave * 0.018;
  if (metric.includes("charging_mw")) return -900 - wave * 500;
  if (metric.includes("discharging_mw")) return 450 + wave * 300;
  if (metric.includes("net_output_mw")) return -450 + wave * 800;
  if (metric.includes("fuel_mix")) {
    if (tags.includes("fuel:wind")) return 18_000 + wave * 2200;
    if (tags.includes("fuel:solar")) return Math.max(0, 12_000 + wave * 9000);
    if (tags.includes("fuel:nuclear")) return 5100 + wave * 80;
    if (tags.includes("fuel:coal_and_lignite")) return 8200 + wave * 600;
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

function latestValue(id: string, metric: string, tags: string[], scenario: MobileScenario) {
  if (id === "demand") return 68_200;
  if (id === "capacity") return 88_500;
  if (id === "frequency") return 60.001;
  if (id === "grid-demand") return 68_100;
  if (id === "grid-capacity") return 73_500;
  if (id === "inertia") return 312;
  return metricValue(metric, tags, 63, scenario);
}

function sourceFixture(scenario: MobileScenario) {
  const definitions = [
    ["fuel_mix", "ERCOT Fuel Mix"],
    ["energy_storage", "ERCOT Energy Storage Resources"],
    ["supply_demand", "ERCOT Supply and Demand"],
    ["generation_outages", "ERCOT Generation Outages"],
    ["operations_messages", "ERCOT Operations Messages"],
    ["wind_solar", "ERCOT Combined Wind and Solar"],
    ["ercot_realtime", "ERCOT Real-time System Conditions"],
    ["ercot_ancillary", "ERCOT Ancillary Services"],
    ["ercot_eea", "ERCOT Emergency Energy Alerts"],
    ["metar", "Aviation Weather METAR"],
    ["poweroutages_us", "PowerOutage.us Texas"],
  ] as const;
  return definitions.map(([sourceId, displayName]) => {
    const affected = sourceId === "energy_storage" && ["delayed", "failed"].includes(scenario);
    const failed = affected && scenario === "failed";
    return {
      source_id: sourceId,
      display_name: displayName,
      expected_interval_seconds: 300,
      last_attempt_ts: FIXED_NOW_SECONDS - (failed ? 900 : 30),
      last_success_ts: FIXED_NOW_SECONDS - (affected ? 1080 : 30),
      source_timestamp_ts: FIXED_NOW_SECONDS - (affected ? 1080 : 60),
      last_row_count: affected ? 0 : 25,
      consecutive_failures: failed ? 3 : 0,
      last_error: affected ? LONG_SOURCE_ERROR : null,
      age_seconds: affected ? 1080 : 60,
      state: failed ? "failed" : affected ? "delayed" : "healthy",
      collection_age_seconds: failed ? 900 : 30,
      collection_state: failed ? "failed" : "healthy",
      data_age_seconds: affected ? 1080 : 60,
      freshness_state: affected ? "delayed" : "fresh",
      publication_mode: sourceId === "operations_messages" ? "event" : "polling",
      publication_interval_seconds: 300,
    };
  });
}

function rankingFixture(scenario: MobileScenario) {
  const prices = [
    ["HB_WEST", 104.16],
    ["LZ_WEST", 92.5],
    ["HB_HOUSTON", 48.25],
    ["HB_NORTH", scenario === "negative" ? -42.16 : 44.1],
    ["LZ_AEN", 39.75],
    ["LZ_LCRA", 36.2],
    ["HB_SOUTH", 31.05],
  ] as const;
  return prices.map(([name, value]) => ({
    tag: `ercot_region:${name}`,
    ts: FIXED_NOW_SECONDS - 30,
    value: scenario === "spike" && name === "HB_WEST" ? 5250 : value,
  }));
}

function eventFixture(scenario: MobileScenario) {
  if (!["active-event", "warning"].includes(scenario)) return [];
  return [
    {
      dedupe_key: "fixture:event:active-warning",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 1800,
      observed_at: FIXED_NOW_SECONDS - 1800,
      event_type: "Operational Information",
      status: "Active",
      severity: scenario === "warning" ? "emergency" : "warning",
      title: "Transmission constraint requires heightened grid awareness in the Houston area.",
      body: "Operators are monitoring reserves and constrained transmission paths.",
    },
    {
      dedupe_key: "fixture:event:history",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 7200,
      observed_at: FIXED_NOW_SECONDS - 7200,
      event_type: "Operational Information",
      status: "Closed",
      severity: "information",
      title: "Earlier transmission advisory is no longer active.",
    },
  ];
}

export async function installMobileApi(
  page: Page,
  scenario: MobileScenario = "normal",
  requests: string[][] = [],
) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route("**/api/series/batch", async (route) => {
    if (scenario === "error") {
      await route.fulfill({ status: 503, body: "fixture upstream unavailable" });
      return;
    }
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; since: number; tags: string[]; until: number }>;
    };
    requests.push(payload.queries.map((query) => query.id));
    const series = payload.queries.map((query) => {
      const count = query.id.includes("compare") ? 42 : 64;
      const step = Math.max(60, Math.floor((query.until - query.since) / (count - 1)));
      const points =
        scenario === "empty"
          ? []
          : Array.from({ length: count }, (_, index) => [
              query.since + index * step,
              metricValue(query.metric, query.tags, index, scenario),
            ]);
      return {
        id: query.id,
        metric: query.metric,
        points,
        meta: {
          since: query.since,
          until: query.until,
          max_points: 1200,
          bucket_seconds: step,
          partial_current_bucket: !query.id.includes("compare"),
          stats: {
            average: points.length
              ? points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length
              : null,
            count: points.length,
            energy_mwh: query.metric.endsWith("_mw") && points.length ? 412.5 : null,
            latest: points.length ? Number(points.at(-1)?.[1]) : null,
            maximum: points.length ? Math.max(...points.map((point) => Number(point[1]))) : null,
            minimum: points.length ? Math.min(...points.map((point) => Number(point[1]))) : null,
          },
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
            value: latestValue(query.id, query.metric, query.tags ?? [], scenario),
            tags: query.tags ?? [],
          },
          meta: { age_seconds: 30 },
        })),
      },
    });
  });
  await page.route("**/api/v1/ranking**", (route) =>
    route.fulfill({ json: { rows: rankingFixture(scenario) } }),
  );
  await page.route("**/api/v1/source-health", (route) =>
    route.fulfill({
      json: { sources: sourceFixture(scenario), summary: {}, as_of: FIXED_NOW_SECONDS },
    }),
  );
  await page.route("**/api/v1/events**", (route) =>
    route.fulfill({ json: { events: eventFixture(scenario) } }),
  );
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (dimensions.scrollWidth !== dimensions.clientWidth) {
    throw new Error(`page overflow: ${dimensions.scrollWidth} > ${dimensions.clientWidth}`);
  }
}
