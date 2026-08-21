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
  | "outlook-stale"
  | "quiet"
  | "spike"
  | "storage"
  | "warning";

export const FIXED_NOW = new Date("2026-07-21T18:00:00-05:00");
export const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);
export const LONG_SOURCE_ERROR =
  "Upstream settlement archive rejected the collector checkpoint after a gateway timeout; retry is scheduled and stale historical data remains available for review.";

export function outlookFixture(stale = false) {
  const forecastSource = "ercot_public_np3_565_weather_zone_forecast";
  const adequacySource = "ercot_public_np3_763_system_adequacy";
  const publication = (
    sourceId: typeof forecastSource | typeof adequacySource,
    productId: "NP3-565-CD" | "NP3-763-CD",
  ) => ({
    declared_unit: "MW",
    issued_at: FIXED_NOW_SECONDS - 3_600,
    product_id: productId,
    retrieved_at: FIXED_NOW_SECONDS - 1_800,
    source_id: sourceId,
    vintage_key: `v1-${(productId === "NP3-565-CD" ? "a" : "b").repeat(64)}`,
  });
  const health = (sourceId: string, displayName: string, sourceStale = false) => ({
    availability_status: "available",
    consecutive_failures: sourceStale ? 2 : 0,
    data_timestamp_ts: FIXED_NOW_SECONDS - (sourceStale ? 10_800 : 1_800),
    display_name: displayName,
    freshness_state: sourceStale ? "stale" : "fresh",
    last_success_ts: FIXED_NOW_SECONDS - (sourceStale ? 10_800 : 1_800),
    source_id: sourceId,
    source_timestamp_ts: FIXED_NOW_SECONDS - (sourceStale ? 10_800 : 3_600),
    state: sourceStale ? "stale" : "healthy",
  });
  const days = [
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25",
    "2026-07-26",
    "2026-07-27",
    "2026-07-28",
  ];
  const forecastRows = days.flatMap((deliveryDate, dayIndex) =>
    [1, 2].map((hourOffset) => ({
      delivery_date: deliveryDate,
      demand_mw: 68_000 + dayIndex * 850 + hourOffset * 1_200,
      dst_flag: false,
      hour_ending: `${String(13 + hourOffset).padStart(2, "0")}:00`,
      model: "A3",
      revision_mw: dayIndex * 75 - 150,
      target_ts: FIXED_NOW_SECONDS + dayIndex * 86_400 + hourOffset * 3_600,
    })),
  );
  const adequacyRows = forecastRows.map((row, index) => ({
    available_generation_mw: 90_000 - index * 100,
    delivery_date: row.delivery_date,
    hour_ending: row.hour_ending,
    projected_headroom_mw: 16_000 - index * 325,
    repeat_hour_flag: false,
    target_ts: row.target_ts,
  }));
  return {
    adequacy: {
      headroom_definition: "AvailCapGen minus forecasted Demand for each hour",
      headroom_field: "availCapRes",
      publication: publication(adequacySource, "NP3-763-CD"),
      rows: adequacyRows,
      source_health: health(adequacySource, "ERCOT NP3-763 System Adequacy"),
    },
    forecast: {
      publication: publication(forecastSource, "NP3-565-CD"),
      revision_policy: "latest_issued_at_least_24h_before_current",
      revision_reference: {
        ...publication(forecastSource, "NP3-565-CD"),
        issued_at: FIXED_NOW_SECONDS - 90_000,
        retrieved_at: FIXED_NOW_SECONDS - 88_200,
        vintage_key: `v1-${"c".repeat(64)}`,
      },
      rows: forecastRows,
      selection_policy: "in_use_flag_true",
      source_health: health(forecastSource, "ERCOT NP3-565 Load Forecast", stale),
    },
    interpretation: {
      kind: "dashboard_outlook",
      official_ercot_status: false,
      status: null,
    },
    schema: 1,
    weather_context: {
      driver: null,
      forecast_driver_available: false,
      observations: [
        {
          label: "Dallas–Fort Worth",
          observed_at: FIXED_NOW_SECONDS - 1_800,
          station_code: "KDFW",
          temperature_c: 36,
        },
        {
          label: "Houston",
          observed_at: FIXED_NOW_SECONDS - 1_800,
          station_code: "KHOU",
          temperature_c: 34,
        },
      ],
      source: {
        availability_status: "available",
        consecutive_failures: 0,
        data_timestamp_ts: FIXED_NOW_SECONDS - 1_800,
        display_name: "Aviation Weather METAR",
        expected_interval_seconds: 3_600,
        freshness_state: "fresh",
        last_success_ts: FIXED_NOW_SECONDS - 1_500,
        source_id: "metar",
        source_timestamp_ts: FIXED_NOW_SECONDS - 1_800,
        state: "healthy",
      },
      state: "current_observations_only",
    },
  };
}

function metricValue(metric: string, tags: string[], index: number, scenario: MobileScenario) {
  const wave = Math.sin(index / 5);
  if (metric.includes("demand_mw")) return 68_200 + wave * 3200;
  if (metric.includes("capacity_mw")) return 88_500 + wave * 1800;
  if (metric.includes("Frequency")) return 60.001 + wave * 0.018;
  if (metric.includes("charging_mw")) return -900 - wave * 500;
  if (metric.includes("discharging_mw")) return 450 + wave * 300;
  if (metric.includes("net_output_mw")) return -450 + wave * 800;
  if (metric.includes("eea_level")) return 0;
  if (metric.includes("metar.temperature")) return 31 + wave * 4;
  if (metric.includes("metar.winds.speed")) return 12 + wave * 4;
  if (metric.includes("duty_cycle")) return 12 + wave * 3;
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
  if (metric.includes("winds.direction")) return tags.includes("metar_code:KDFW") ? 315 : 180;
  if (metric.includes("winds.gust")) return 24;
  if (metric.includes("winds.speed")) return 12;
  return metricValue(metric, tags, 63, scenario);
}

function heroHistoryValue(
  metric: string,
  tags: string[],
  index: number,
  count: number,
  scenario: MobileScenario,
) {
  const progress = count <= 1 ? 1 : index / (count - 1);
  const current = metricValue(metric, tags, 63, scenario);
  if (metric.includes("demand_mw")) return 66_800 + (68_200 - 66_800) * progress;
  if (metric.includes("capacity_mw")) return 87_900 + (88_500 - 87_900) * progress;
  if (metric.includes("Frequency")) return 59.998 + (60.001 - 59.998) * progress;
  if (metric.includes("pricing")) return current + 9 * (1 - progress);
  return metricValue(metric, tags, index, scenario);
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
      body: "Operators are monitoring constrained transmission paths and the affected load zone.",
    },
    {
      dedupe_key: "fixture:event:heat",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 3600,
      event_type: "Advisory",
      status: "Closed",
      severity: "information",
      title: "Heat advisory asked consumers to conserve during the afternoon peak.",
    },
    {
      dedupe_key: "fixture:event:generator",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 4500,
      event_type: "Operational Information",
      status: "Closed",
      severity: "warning",
      title: "Generator unit trip removed 620 MW before returning to service.",
    },
    {
      dedupe_key: "fixture:event:reserve",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 5400,
      event_type: "Operational Information",
      status: "Closed",
      severity: "watch",
      title: "Reserve watch ended after Physical Responsive Capability recovered.",
    },
    {
      dedupe_key: "fixture:event:eea",
      source_id: "operations_messages",
      starts_at: FIXED_NOW_SECONDS - 6300,
      event_type: "Emergency Notice",
      status: "Closed",
      severity: "emergency",
      title: "EEA Level 2 ended after operating reserves stabilized.",
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
              query.id.startsWith("hero:")
                ? heroHistoryValue(query.metric, query.tags, index, count, scenario)
                : metricValue(query.metric, query.tags, index, scenario),
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
        latest: payload.queries.map((query) => {
          const tags = query.tags ?? [];
          const unavailableOptionalWind =
            (query.metric.includes("winds.gust") && !tags.includes("metar_code:KDFW")) ||
            (query.metric.includes("winds.direction") && tags.includes("metar_code:KSAT"));
          return {
            id: query.id,
            metric: query.metric,
            point: unavailableOptionalWind
              ? null
              : {
                  ts: FIXED_NOW_SECONDS - 30,
                  value: latestValue(query.id, query.metric, tags, scenario),
                  tags,
                },
            meta: { age_seconds: 30 },
          };
        }),
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
  await page.route("**/api/v1/outlook", (route) =>
    route.fulfill({ json: outlookFixture(scenario === "outlook-stale") }),
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
