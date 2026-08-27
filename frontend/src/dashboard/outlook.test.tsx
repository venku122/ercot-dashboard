import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutlookContent } from "./OutlookView";
import { loadOutlook } from "./api";
import { buildGridOutlook, parseOutlookResponse } from "./outlook";

const NOW = 1_800_000_000;
const VINTAGE = `v1-${"a".repeat(64)}`;
const REFERENCE = `v1-${"b".repeat(64)}`;
const days = [
  "2027-01-15",
  "2027-01-16",
  "2027-01-17",
  "2027-01-18",
  "2027-01-19",
  "2027-01-20",
  "2027-01-21",
  "2027-01-22",
];

afterEach(() => vi.unstubAllGlobals());

function sourceHealth(sourceId: string) {
  return {
    source_id: sourceId,
    display_name: "ERCOT source",
    availability_status: "available",
    state: "healthy",
    freshness_state: "fresh",
    consecutive_failures: 0,
    last_success_ts: NOW - 60,
    source_timestamp_ts: NOW - 120,
    data_timestamp_ts: NOW - 120,
  };
}

function fixture() {
  const rows = Array.from({ length: 192 }, (_, index) => ({
    target_ts: NOW + (index + 1) * 3_600,
    delivery_date: days[Math.floor(index / 24)],
    hour_ending: `${String((index % 24) + 1)}:00`,
    dst_flag: false,
    model: "A3",
    demand_mw: 70_000 + index,
    revision_mw: index % 2 ? 100 : -50,
  }));
  return {
    schema: 1,
    forecast: {
      publication: {
        source_id: "ercot_public_np3_565_weather_zone_forecast",
        product_id: "NP3-565-CD",
        vintage_key: VINTAGE,
        issued_at: NOW - 7_200,
        retrieved_at: NOW - 60,
        declared_unit: "MW",
      },
      selection_policy: "in_use_flag_true",
      revision_reference: {
        source_id: "ercot_public_np3_565_weather_zone_forecast",
        product_id: "NP3-565-CD",
        vintage_key: REFERENCE,
        issued_at: NOW - 93_600,
        retrieved_at: NOW - 86_000,
        declared_unit: "MW",
      },
      revision_policy: "latest_issued_at_least_24h_before_current",
      source_health: sourceHealth("ercot_public_np3_565_weather_zone_forecast"),
      rows,
    },
    adequacy: {
      publication: {
        source_id: "ercot_public_np3_763_system_adequacy",
        product_id: "NP3-763-CD",
        vintage_key: `v1-${"c".repeat(64)}`,
        issued_at: NOW - 1_800,
        retrieved_at: NOW - 30,
        declared_unit: "MW",
      },
      source_health: sourceHealth("ercot_public_np3_763_system_adequacy"),
      headroom_field: "availCapRes",
      headroom_definition: "AvailCapGen minus forecasted Demand for each hour",
      rows: rows.map((row, index) => ({
        target_ts: row.target_ts,
        delivery_date: row.delivery_date,
        hour_ending: row.hour_ending,
        repeat_hour_flag: false,
        available_generation_mw: 90_000,
        projected_headroom_mw: 10_000 - index,
      })),
    },
    weather_context: {
      state: "current_observations_only",
      forecast_driver_available: false,
      driver: null,
      source: {
        ...sourceHealth("metar"),
        source_id: "metar",
        display_name: "Aviation weather observations",
        expected_interval_seconds: 300,
      },
      observations: [
        ["KDFW", "Dallas/Fort Worth", 37],
        ["KAUS", "Austin", 36],
        ["KHOU", "Houston", 35],
        ["KSAT", "San Antonio", null],
      ].map(([station_code, label, temperature_c]) => ({
        station_code,
        label,
        temperature_c,
        observed_at: temperature_c === null ? null : NOW - 120,
      })),
    },
    interpretation: {
      kind: "dashboard_outlook",
      official_ercot_status: false,
      status: null,
    },
  };
}

describe("Grid Outlook contract", () => {
  it("loads the one fixed current endpoint and validates before returning", async () => {
    const fetchMock = vi.fn(async () => Response.json(fixture()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadOutlook();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/outlook", { method: "GET" });
    expect(result.adequacy.headroom_field).toBe("availCapRes");
  });

  it("builds bounded 24-hour and seven-day projections from exact reviewed fields", () => {
    const parsed = parseOutlookResponse(fixture());
    const outlook = buildGridOutlook(parsed, NOW);

    expect(outlook.next24Hours).toHaveLength(24);
    expect(outlook.cards).toHaveLength(7);
    expect(outlook.days).toHaveLength(7);
    expect(outlook.cards[0]).toMatchObject({
      deliveryDate: "2027-01-15",
      peakDemandMw: 70_023,
      projectedHeadroomMw: 9_977,
    });
    expect(outlook.forecastAgeSeconds).toBe(7_200);
    expect(parsed.forecast.publication?.retrieved_at).toBe(NOW - 60);
    expect(parsed.adequacy.headroom_field).toBe("availCapRes");
    expect(JSON.stringify(parsed)).not.toContain("capGenRes");
    expect(outlook.weather.driver).toBeNull();
  });

  it("groups 23-hour and 25-hour delivery days without UTC calendar inference", () => {
    const input = fixture();
    input.forecast.rows = input.forecast.rows.slice(0, 48);
    input.adequacy.rows = input.adequacy.rows.slice(0, 48);
    input.forecast.rows.forEach((row, index) => {
      row.delivery_date = index < 23 ? "2027-03-14" : "2027-11-07";
    });
    input.adequacy.rows.forEach((row, index) => {
      row.delivery_date = index < 23 ? "2027-03-14" : "2027-11-07";
    });

    const outlook = buildGridOutlook(parseOutlookResponse(input), NOW);

    expect(outlook.days.map((day) => day.hours.length)).toEqual([23, 25]);
  });

  it("rejects coerced flags, malformed vintage identity, and publication-row drift", () => {
    const badFlag = fixture();
    badFlag.forecast.rows[0]!.dst_flag = "false" as never;
    expect(() => parseOutlookResponse(badFlag)).toThrow("invalid_outlook_dst_flag");

    const badVintage = fixture();
    badVintage.forecast.publication.vintage_key = "not-content-addressed";
    expect(() => parseOutlookResponse(badVintage)).toThrow("invalid_outlook_vintage_key");

    const missingAdequacy = fixture();
    missingAdequacy.adequacy.publication = null as never;
    expect(() => parseOutlookResponse(missingAdequacy)).toThrow(
      "invalid_outlook_adequacy_presence",
    );
  });

  it("renders exact hourly equivalents, selectable detail, freshness, and disclaimers", () => {
    const outlook = buildGridOutlook(parseOutlookResponse(fixture()), NOW);
    outlook.adequacySourceHealth = {
      ...outlook.adequacySourceHealth!,
      availability_status: "empty",
      freshness_state: "unknown",
    };

    const html = renderToStaticMarkup(<OutlookContent outlook={outlook} />);

    expect(html).toContain('aria-label="Next 24 hour forecast values"');
    expect(html).toContain("View Sat, Jan 16 hourly detail");
    expect(html).toContain("Some Outlook inputs are partial or stale");
    expect(html).toContain("Current observations only");
    expect(html).toContain("Current METAR observations are displayed independently");
    expect(html).toContain("not an ERCOT declaration");
  });

  it("does not label stale or failed METAR observations as current", () => {
    const input = fixture();
    input.weather_context.source.state = "failed";
    input.weather_context.source.freshness_state = "stale";
    input.weather_context.source.consecutive_failures = 3;

    const html = renderToStaticMarkup(
      <OutlookContent outlook={buildGridOutlook(parseOutlookResponse(input), NOW)} />,
    );

    expect(html).toContain('data-weather-state="stale-or-unavailable"');
    expect(html).toContain("Latest observations only");
    expect(html).toContain("Weather observations: failed, data stale");
    expect(html).not.toContain(">Current observations only<");
  });
});
