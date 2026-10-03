import type { Page } from "@playwright/test";

import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const VERSION = `pw1-${"d".repeat(64)}`;
const identities = [
  ["KDFW", "Dallas/Fort Worth", 32.8974, -97.022, "FWD", 74, 103],
  ["KAUS", "Austin", 30.1831, -97.6806, "EWX", 156, 90],
  ["KHOU", "Houston Hobby", 29.6458, -95.2821, "HGX", 65, 92],
  ["KSAT", "San Antonio", 29.5443, -98.4839, "EWX", 133, 80],
] as const;

export function predictiveWeatherFixture(validEmpty = false) {
  const start = FIXED_NOW_SECONDS - 3_600;
  const end = start + 8 * 86_400;
  return {
    schema: 1,
    kind: "predictive_weather",
    registry_version: "representative-airport-points-v1",
    policy: "representative_point_weather_context_not_grid_alert_or_load_causality",
    generated_at: FIXED_NOW_SECONDS,
    forecast: {
      state: "available",
      content_version: VERSION,
      points: identities.map(([point_id, label, latitude, longitude, grid_id, grid_x, grid_y]) => ({
        point_id,
        label,
        latitude,
        longitude,
        state: "available",
        mapping: {
          grid_id,
          grid_x,
          grid_y,
          forecast_grid_data_url: `https://api.weather.gov/gridpoints/${grid_id}/${grid_x},${grid_y}`,
          time_zone: "America/Chicago",
        },
        update_time: FIXED_NOW_SECONDS - 900,
        retrieved_at: FIXED_NOW_SECONDS - 840,
        cache_fresh_until: FIXED_NOW_SECONDS + 2_700,
        layers: [
          ["temperature", "wmoUnit:degC", point_id === "KDFW" ? -2 : 39],
          ["apparentTemperature", "wmoUnit:degC", point_id === "KDFW" ? -5 : 43],
          ["heatIndex", "wmoUnit:degC", point_id === "KDFW" ? null : 45],
          ["windChill", "wmoUnit:degC", point_id === "KDFW" ? -7 : null],
          ["windSpeed", "wmoUnit:km_h-1", 38],
          ["windGust", "wmoUnit:km_h-1", 65],
        ].map(([key, unit, value]) => ({
          key,
          unit,
          rows: [{ valid_start: start, valid_end: end, value }],
        })),
      })),
    },
    alerts: {
      state: validEmpty ? "valid_empty" : "available",
      content_version: VERSION,
      coverage: "texas_statewide_not_ercot_footprint",
      collection_updated_at: FIXED_NOW_SECONDS - 120,
      retrieved_at: FIXED_NOW_SECONDS - 60,
      cache_fresh_until: FIXED_NOW_SECONDS + 240,
      truncated: false,
      items: validEmpty
        ? []
        : [
            {
              id: "urn:oid:wind-acceptance",
              event: "High Wind Warning",
              headline: "High Wind Warning for North Texas",
              area_desc: "North Texas counties with a deliberately long area description",
              severity: "Severe",
              urgency: "Expected",
              certainty: "Likely",
              message_type: "Alert",
              sent: FIXED_NOW_SECONDS - 600,
              effective: FIXED_NOW_SECONDS - 300,
              onset: FIXED_NOW_SECONDS,
              expires: FIXED_NOW_SECONDS + 7_200,
              ends: FIXED_NOW_SECONDS + 7_200,
              description: "Official NWS fixture description",
              instruction: null,
              response: "Prepare",
              affected_zones: ["https://api.weather.gov/zones/forecast/TXZ119"],
              references: [],
              source_url: "https://api.weather.gov/alerts/urn:oid:wind-acceptance",
            },
          ],
    },
    source_health: ["nws_grid_forecast", "nws_alerts_tx"].map((source_id) => ({
      source_id,
      state: "healthy",
      availability_status: validEmpty && source_id === "nws_alerts_tx" ? "empty" : "available",
      content_version: VERSION,
      last_attempt_ts: FIXED_NOW_SECONDS - 60,
      last_success_ts: FIXED_NOW_SECONDS - 60,
      source_updated_at: FIXED_NOW_SECONDS - 120,
      retrieved_at: FIXED_NOW_SECONDS - 60,
      cache_fresh_until: FIXED_NOW_SECONDS + 240,
      consecutive_failures: 0,
      last_error: null,
      materialization: {
        state: "healthy",
        last_success_ts: FIXED_NOW_SECONDS - 60,
        consecutive_failures: 0,
        last_error: null,
      },
    })),
  };
}

export async function installPredictiveWeatherApi(
  page: Page,
  requests: string[],
  validEmpty = false,
) {
  await installMobileApi(page, "normal");
  await page.route("**/api/v1/predictive-weather", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: predictiveWeatherFixture(validEmpty) });
  });
}
