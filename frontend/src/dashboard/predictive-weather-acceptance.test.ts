import { describe, expect, it } from "vitest";

import {
  intervalAt,
  parsePredictiveWeatherManifest,
  type PredictiveWeatherManifest,
} from "./predictive-weather";

const START = 1_777_000_000;
const VERSION = `pw1-${"a".repeat(64)}`;
const points = [
  ["KDFW", "Dallas/Fort Worth", 32.8974, -97.022, "FWD", 74, 103],
  ["KAUS", "Austin", 30.1831, -97.6806, "EWX", 156, 90],
  ["KHOU", "Houston Hobby", 29.6458, -95.2821, "HGX", 65, 92],
  ["KSAT", "San Antonio", 29.5443, -98.4839, "EWX", 133, 80],
] as const;
const layers = [
  ["temperature", "wmoUnit:degC", -1],
  ["apparentTemperature", "wmoUnit:degC", -3],
  ["heatIndex", "wmoUnit:degC", null],
  ["windChill", "wmoUnit:degC", -5],
  ["windSpeed", "wmoUnit:km_h-1", 35],
  ["windGust", "wmoUnit:km_h-1", 62],
] as const;

function fixture(): unknown {
  return {
    schema: 1,
    kind: "predictive_weather",
    registry_version: "representative-airport-points-v1",
    policy: "representative_point_weather_context_not_grid_alert_or_load_causality",
    generated_at: START + 300,
    forecast: {
      state: "available",
      content_version: VERSION,
      points: points.map(([point_id, label, latitude, longitude, grid_id, grid_x, grid_y]) => ({
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
        update_time: START,
        retrieved_at: START + 30,
        cache_fresh_until: START + 3_600,
        layers: layers.map(([key, unit, value]) => ({
          key,
          unit,
          rows: [{ valid_start: START, valid_end: START + 3_600, value }],
        })),
      })),
    },
    alerts: {
      state: "available",
      content_version: VERSION,
      coverage: "texas_statewide_not_ercot_footprint",
      collection_updated_at: START,
      retrieved_at: START + 30,
      cache_fresh_until: START + 600,
      truncated: false,
      items: [
        {
          id: "urn:oid:acceptance-alert",
          event: "High Wind Warning",
          headline: "High Wind Warning issued for acceptance fixture",
          area_desc: "North Texas",
          severity: "Severe",
          urgency: "Expected",
          certainty: "Likely",
          message_type: "Alert",
          sent: START,
          effective: START,
          onset: START + 60,
          expires: START + 3_600,
          ends: START + 3_600,
          description: "Official fixture description",
          instruction: "Follow official instructions.",
          response: "Prepare",
          affected_zones: ["https://api.weather.gov/zones/forecast/TXZ119"],
          references: [],
          source_url: "https://api.weather.gov/alerts/urn:oid:acceptance-alert",
        },
      ],
    },
    source_health: ["nws_grid_forecast", "nws_alerts_tx"].map((source_id) => ({
      source_id,
      state: "healthy",
      availability_status: "available",
      content_version: VERSION,
      last_attempt_ts: START + 30,
      last_success_ts: START + 30,
      source_updated_at: START,
      retrieved_at: START + 30,
      cache_fresh_until: START + 600,
      consecutive_failures: 0,
      last_error: null,
      materialization: {
        state: "healthy",
        last_success_ts: START + 30,
        consecutive_failures: 0,
        last_error: null,
      },
    })),
  };
}

function mutate(run: (value: Record<string, unknown>) => void) {
  const value = structuredClone(fixture()) as Record<string, unknown>;
  run(value);
  return value;
}

describe("PR18 predictive weather acceptance", () => {
  it("freezes four airport identities, exact units, negative/null values, and Texas coverage", () => {
    const manifest = parsePredictiveWeatherManifest(fixture());
    expect(manifest.forecast.points.map((point) => [point.point_id, point.label])).toEqual(
      points.map(([id, label]) => [id, label]),
    );
    expect(manifest.forecast.points[0]!.layers.map((layer) => [layer.key, layer.unit])).toEqual(
      layers.map(([key, unit]) => [key, unit]),
    );
    expect(manifest.forecast.points[0]!.layers.map((layer) => layer.rows[0]!.value)).toEqual(
      layers.map(([, , value]) => value),
    );
    expect(manifest.alerts.coverage).toBe("texas_statewide_not_ercot_footprint");
  });

  it("uses half-open interval containment and never borrows either boundary", () => {
    const point = parsePredictiveWeatherManifest(fixture()).forecast.points[0]!;
    expect(intervalAt(point, "temperature", START - 1)).toBeNull();
    expect(intervalAt(point, "temperature", START)?.value).toBe(-1);
    expect(intervalAt(point, "temperature", START + 3_599)?.value).toBe(-1);
    expect(intervalAt(point, "temperature", START + 3_600)).toBeNull();
  });

  it("rejects extra keys, reordered identities, wrong units, overlap, and duplicate alerts", () => {
    const cases = [
      mutate((root) => (root["unexpected"] = true)),
      mutate((root) => {
        const forecast = root["forecast"] as { points: unknown[] };
        [forecast.points[0], forecast.points[1]] = [forecast.points[1], forecast.points[0]];
      }),
      mutate((root) => {
        const forecast = root["forecast"] as { points: Array<{ layers: Array<{ unit: string }> }> };
        forecast.points[0]!.layers[0]!.unit = "degF";
      }),
      mutate((root) => {
        const forecast = root["forecast"] as {
          points: Array<{
            layers: Array<{
              rows: Array<{ valid_start: number; valid_end: number; value: number }>;
            }>;
          }>;
        };
        forecast.points[0]!.layers[0]!.rows.push({
          valid_start: START + 3_599,
          valid_end: START + 7_200,
          value: 2,
        });
      }),
      mutate((root) => {
        const alerts = root["alerts"] as { items: unknown[] };
        alerts.items.push(structuredClone(alerts.items[0]));
      }),
    ];
    for (const value of cases) expect(() => parsePredictiveWeatherManifest(value)).toThrow();
  });

  it("keeps valid-empty, failed, partial, and stale states structurally distinct", () => {
    const empty = mutate((root) => {
      const alerts = root["alerts"] as { state: string; items: unknown[] };
      alerts.state = "valid_empty";
      alerts.items = [];
    });
    expect(parsePredictiveWeatherManifest(empty).alerts.state).toBe("valid_empty");

    const partial = mutate((root) => {
      const forecast = root["forecast"] as {
        state: string;
        points: Array<{
          state: string;
          mapping: unknown;
          update_time: number | null;
          retrieved_at: number | null;
          cache_fresh_until: number | null;
        }>;
      };
      forecast.state = "partial";
      Object.assign(forecast.points[3]!, {
        state: "unavailable",
        mapping: null,
        update_time: null,
        retrieved_at: null,
        cache_fresh_until: null,
      });
    });
    expect(parsePredictiveWeatherManifest(partial).forecast.state).toBe("partial");

    const stale = mutate((root) => {
      const forecast = root["forecast"] as { state: string; points: Array<{ state: string }> };
      forecast.state = "stale";
      forecast.points.forEach((point) => (point.state = "stale"));
    });
    expect(parsePredictiveWeatherManifest(stale).forecast.state).toBe("stale");
  });

  it("exposes only the noncausal policy identity", () => {
    const encoded = JSON.stringify(parsePredictiveWeatherManifest(fixture())).toLowerCase();
    expect(encoded).toContain("not_grid_alert_or_load_causality");
    for (const forbidden of ["caused_by", "weather_driver", "ercot_footprint_alert"]) {
      expect(encoded).not.toContain(`"${forbidden}"`);
    }
  });
});

export function predictiveWeatherAcceptanceFixture(): PredictiveWeatherManifest {
  return parsePredictiveWeatherManifest(fixture());
}
