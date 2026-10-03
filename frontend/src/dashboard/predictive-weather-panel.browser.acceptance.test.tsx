// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PredictiveWeatherPanel } from "./PredictiveWeatherPanel";
import type { PredictiveWeatherManifest } from "./predictive-weather";

const mocks = vi.hoisted(() => ({ loadPredictiveWeather: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadPredictiveWeather: mocks.loadPredictiveWeather,
}));

const START = 1_777_000_000;
const VERSION = `pw1-${"b".repeat(64)}`;
const identities = [
  ["KDFW", "Dallas/Fort Worth", 32.8974, -97.022, "FWD"],
  ["KAUS", "Austin", 30.1831, -97.6806, "EWX"],
  ["KHOU", "Houston Hobby", 29.6458, -95.2821, "HGX"],
  ["KSAT", "San Antonio", 29.5443, -98.4839, "EWX"],
] as const;

function manifest(
  alertState: "available" | "valid_empty" = "available",
): PredictiveWeatherManifest {
  return {
    schema: 1,
    kind: "predictive_weather",
    registry_version: "representative-airport-points-v1",
    policy: "representative_point_weather_context_not_grid_alert_or_load_causality",
    generated_at: START + 300,
    forecast: {
      state: "available",
      content_version: VERSION,
      points: identities.map(([point_id, label, latitude, longitude, grid_id], index) => ({
        point_id,
        label,
        latitude,
        longitude,
        state: "available",
        mapping: {
          grid_id,
          grid_x: 70 + index,
          grid_y: 90 + index,
          forecast_grid_data_url: `https://api.weather.gov/gridpoints/${grid_id}/${70 + index},${90 + index}`,
          time_zone: "America/Chicago",
        },
        update_time: START,
        retrieved_at: START + 30,
        cache_fresh_until: START + 3_600,
        layers: [
          ["temperature", "wmoUnit:degC", -2],
          ["apparentTemperature", "wmoUnit:degC", -4],
          ["heatIndex", "wmoUnit:degC", null],
          ["windChill", "wmoUnit:degC", -7],
          ["windSpeed", "wmoUnit:km_h-1", 38],
          ["windGust", "wmoUnit:km_h-1", 65],
        ].map(([key, unit, value]) => ({
          key,
          unit,
          rows: [{ valid_start: START, valid_end: START + 3_600, value }],
        })) as PredictiveWeatherManifest["forecast"]["points"][number]["layers"],
      })),
    },
    alerts: {
      state: alertState,
      coverage: "texas_statewide_not_ercot_footprint",
      collection_updated_at: START,
      retrieved_at: START + 30,
      cache_fresh_until: START + 600,
      content_version: VERSION,
      truncated: false,
      items:
        alertState === "valid_empty"
          ? []
          : [
              {
                id: "urn:oid:wind",
                area_desc: "North Texas",
                sent: START,
                effective: START,
                onset: START,
                expires: START + 3_600,
                ends: START + 3_600,
                event: "High Wind Warning",
                severity: "Severe",
                urgency: "Expected",
                certainty: "Likely",
                headline: "High Wind Warning",
                description: "Official description",
                instruction: null,
                message_type: "Alert",
                response: "Prepare",
                affected_zones: [],
                references: [],
                source_url: "https://api.weather.gov/alerts/urn:oid:wind",
              },
            ],
    },
    source_health: [],
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PR18 predictive weather panel browser acceptance", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mocks.loadPredictiveWeather.mockReset().mockResolvedValue(manifest());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  const render = async (enabled = true) => {
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <PredictiveWeatherPanel enabled={enabled} peakTargetTs={START + 1_800} />
        </SWRConfig>,
      );
    });
  };

  it("has zero collapsed/off-view fanout and one selected current request on expand", async () => {
    await render();
    expect(mocks.loadPredictiveWeather).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    expect(mocks.loadPredictiveWeather).toHaveBeenCalledTimes(1);
    expect(mocks.loadPredictiveWeather.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(host.textContent).toContain("Dallas/Fort Worth exact forecast context");

    await render(false);
    expect(host.textContent).not.toContain("Predictive weather at representative points");
    expect(mocks.loadPredictiveWeather).toHaveBeenCalledTimes(1);
  });

  it("aborts on collapse, disable, and unmount", async () => {
    const signals: AbortSignal[] = [];
    mocks.loadPredictiveWeather.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="true"]')!.click());
    expect(signals[0]?.aborted).toBe(true);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    await render(false);
    expect(signals[1]?.aborted).toBe(true);

    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    await act(async () => root.unmount());
    expect(signals.at(-1)?.aborted).toBe(true);
    root = createRoot(host);
  });

  it("renders exact half-open evidence, derived freeze context, and distinct alert semantics", async () => {
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    expect(host.textContent).toContain("Dashboard derived: forecast at or below freezing");
    expect(host.textContent).toContain("Official NWS · Severe");
    expect(host.textContent).toContain("Texas statewide, not ERCOT footprint");
    expect(host.textContent).toContain("not an ERCOT grid alert, EEA, or conservation status");
    expect(host.textContent).toContain(
      "Temporal overlap is context only and does not establish attribution",
    );
    expect(host.textContent).not.toMatch(
      /weather caused|weather drove|weather driver|weather triggered/i,
    );
    expect(host.textContent).toContain("-2.0 °C");
    const exact = host.querySelector<HTMLElement>(
      '[aria-label="Dallas/Fort Worth exact NWS forecast intervals"]',
    )!;
    expect(exact.tabIndex).toBe(0);
    expect(exact.querySelectorAll("tbody tr")).toHaveLength(6);
    const alertSummary = [...host.querySelectorAll("summary")].find(
      (summary) => summary.textContent === "Exact NWS alert evidence",
    )!;
    await act(async () => alertSummary.click());
    const alertEvidence = host.querySelector<HTMLElement>(
      '[aria-label="Exact Texas NWS alert evidence"]',
    )!;
    expect(alertEvidence.tabIndex).toBe(0);
    expect(alertEvidence.textContent).toContain("urn:oid:wind");
    expect(alertEvidence.textContent).toContain("Severe / Likely / Expected");
  });

  it("distinguishes a valid empty alert collection from unavailable evidence", async () => {
    mocks.loadPredictiveWeather.mockResolvedValue(manifest("valid_empty"));
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click(),
    );
    await flush();
    expect(host.textContent).toContain("No active Texas NWS alerts in the latest valid collection");
    expect(host.textContent).not.toContain("Texas NWS alert evidence is unavailable");
  });
});
