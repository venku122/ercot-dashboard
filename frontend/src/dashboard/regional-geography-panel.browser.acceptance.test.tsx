// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegionalGeographyPanel } from "./RegionalGeographyPanel";
import type {
  RegionalManifest,
  RegionalMode,
  RegionalPoint,
  RegionalResource,
} from "./regional-geography";

const mocks = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  loadResource: vi.fn(),
}));

vi.mock("./regional-geography", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./regional-geography")>()),
  loadRegionalManifest: mocks.loadManifest,
  loadRegionalResource: mocks.loadResource,
}));

const DAY_START = 1_787_011_200;
const VERSION = `rg1-${"a".repeat(64)}`;
const TAXONOMIES: Record<RegionalMode, string[]> = {
  load: [
    "coast",
    "east",
    "far-west",
    "north",
    "north-central",
    "south-central",
    "southern",
    "west",
  ],
  wind: ["panhandle", "coastal", "south", "west", "north"],
  solar: ["center-west", "north-west", "far-west", "far-east", "south-east", "center-east"],
};

function loadPoint(region: string, index: number): RegionalPoint {
  return {
    region,
    current_target_ts: DAY_START + 3_600,
    current_mw: 60_000 + index,
    share_percent: 12 + index,
    change_1h_mw: index === 0 ? null : 100 + index,
    forecast_mw: 59_000 + index,
    forecast_error_mw: 1_000,
    forecast_horizon_seconds: 3_600,
  };
}

function renewablePoint(region: string, index: number): RegionalPoint {
  return {
    region,
    current_target_ts: DAY_START + 3_600,
    current_mw: 1_000 + index,
    share_percent: 10 + index,
    change_1h_mw: 50 + index,
    forecast_error_available: false,
    forecast_error_unavailable_reason: "generation_is_curtailment_affected_forecast_targets_hsl",
    next_24h_forecast_peak: { target_ts: DAY_START + 7_200, forecast_mw: 2_000 + index },
  };
}

function manifest(): RegionalManifest {
  const resources = (["load", "wind", "solar"] as const).flatMap((mode) =>
    TAXONOMIES[mode].map((region) => {
      const seriesKey =
        mode === "load"
          ? `regional.load.weather-zone.${region}.actual`
          : `regional.${mode}.${region}.hourly`;
      return {
        series_key: seriesKey,
        tile_start: DAY_START,
        content_version: VERSION,
        lod: "native" as const,
        url: `/api/v2/regional/${seriesKey}/v1/${VERSION}/1d/${DAY_START}/native`,
      };
    }),
  );
  return {
    title: "ERCOT region schematic — not geographic boundaries",
    taxonomies: TAXONOMIES,
    deferred_products: ["NP4-743-CD", "NP4-746-CD"],
    current: {
      load: {
        availability: "available",
        regions: TAXONOMIES.load.map(loadPoint),
        source: {
          source_id: "ercot_public_np6_345_weather_zone_actual_load",
          observed_at: DAY_START + 3_600,
          retrieved_at: DAY_START + 3_660,
        },
      },
      wind: {
        availability: "available",
        regions: TAXONOMIES.wind.map(renewablePoint),
        source: {
          source_id: "ercot_mis_np4_742",
          vintage_key: `rgv1-${"b".repeat(64)}`,
          issued_at: DAY_START,
          retrieved_at: DAY_START + 60,
        },
      },
      solar: {
        availability: "available",
        regions: TAXONOMIES.solar.map(renewablePoint),
        source: {
          source_id: "ercot_mis_np4_745",
          vintage_key: `rgv1-${"c".repeat(64)}`,
          issued_at: DAY_START,
          retrieved_at: DAY_START + 60,
        },
      },
    },
    source_health: [
      {
        source_id: "ercot_mis_np4_742",
        state: "stale",
        data_age_seconds: 10_800,
        last_success_ts: DAY_START + 60,
      },
      {
        source_id: "ercot_mis_np4_745",
        state: "healthy",
        data_age_seconds: 60,
        last_success_ts: DAY_START + 60,
      },
    ],
    materialization_health: {
      pipeline: "load",
      state: "healthy",
      last_attempt_ts: DAY_START,
      last_success_ts: DAY_START,
      consecutive_failures: 0,
      last_error: null,
    },
    resources,
  };
}

function resource(seriesKey: string): RegionalResource {
  const match = /^regional\.(load\.weather-zone|wind|solar)\.([a-z-]+)(?:\.actual|\.hourly)$/.exec(
    seriesKey,
  )!;
  const kind: RegionalMode = match[1] === "load.weather-zone" ? "load" : (match[1] as RegionalMode);
  return {
    series_key: seriesKey,
    region: match[2]!,
    kind,
    rows: [
      {
        target_ts: DAY_START + 3_600,
        current_mw: 1_200,
        share_percent: 15,
        change_1h_mw: 100,
        forecast_mw: 1_500,
        forecast_error_mw: null,
      },
      {
        target_ts: DAY_START + 7_200,
        current_mw: null,
        share_percent: null,
        change_1h_mw: null,
        forecast_mw: 1_600,
        forecast_error_mw: null,
      },
      {
        target_ts: DAY_START + 10_800,
        current_mw: 1_300,
        share_percent: 16,
        change_1h_mw: null,
        forecast_mw: 1_700,
        forecast_error_mw: null,
      },
    ],
  };
}

let revalidateManifest: (() => Promise<unknown>) | null = null;

function RevalidationProbe() {
  const { mutate } = useSWRConfig();
  revalidateManifest = () => mutate(["regional-geography", "current"]);
  return null;
}

function renderPanel(enabled = true) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          errorRetryInterval: 100,
          focusThrottleInterval: 1,
          onErrorRetry: () => undefined,
          shouldRetryOnError: false,
        }}
      >
        <RegionalGeographyPanel enabled={enabled} />
        <RevalidationProbe />
      </SWRConfig>,
    );
  });
  return { host, root };
}

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function traverseHistory(direction: "back" | "forward") {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener("popstate", () => resolve(), { once: true });
      window.history[direction]();
    });
  });
  await flush();
}

let activeRoot: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/");
  mocks.loadManifest.mockReset();
  mocks.loadResource.mockReset();
  mocks.loadManifest.mockResolvedValue(manifest());
  mocks.loadResource.mockImplementation(async (link) => resource(link.series_key));
  revalidateManifest = null;
});

afterEach(async () => {
  if (activeRoot) await act(async () => activeRoot?.unmount());
  activeRoot = null;
  revalidateManifest = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("regional geography panel independent lifecycle acceptance", () => {
  it("is collapsed-lazy, fetches one manifest and only selected history, and renders truthful semantics", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    expect(mocks.loadManifest).not.toHaveBeenCalled();
    expect(mocks.loadResource).not.toHaveBeenCalled();

    await act(async () => button(host, "Load regional details").click());
    await flush();
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource.mock.calls[0]![0].series_key).toBe(
      "regional.load.weather-zone.coast.actual",
    );
    expect(host.textContent).toContain("ERCOT region schematic — not geographic boundaries");
    expect(host.textContent).toContain("Some regional sources are stale, failed, or unavailable");
    expect(host.querySelector('[aria-label="Regional source freshness"]')?.textContent).toContain(
      "ercot_mis_np4_742: stale; data age 10800 seconds; last success",
    );
    expect(host.textContent).toContain("actual minus NP3-565 forecast");
    expect(host.querySelector("caption")?.textContent).toBe("Exact weather-zone load values");

    await act(async () => button(host, "Wind regions").click());
    await flush();
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource).toHaveBeenCalledTimes(2);
    expect(mocks.loadResource.mock.calls[1]![0].series_key).toBe("regional.wind.panhandle.hourly");
    expect(host.textContent).toContain("HSL-potential forecast peak");
    expect(host.textContent).toContain(
      "generation is curtailment-affected while forecast targets HSL",
    );
    expect(host.querySelector("caption")?.textContent).toBe("Exact wind regions values");
    expect(host.querySelector('svg[aria-label="panhandle hourly generation"]')).not.toBeNull();
    expect(
      host.querySelectorAll('svg[aria-label="panhandle hourly generation"] polyline'),
    ).toHaveLength(2);
    expect(
      host.querySelector('[aria-label="Selected-region history table"]')?.textContent,
    ).toContain("Unavailable");
    expect(host.textContent).toContain("source_id ercot_mis_np4_742");
    expect(host.textContent).toContain("issued_at");
    expect(host.textContent).toContain("retrieved_at");
    expect(host.textContent).toContain("Hourly NP4-742/745 only");
  });

  it("restores URL state, handles popstate, supports roving arrow keys, and aborts stale history", async () => {
    window.history.replaceState(null, "", "/?regionalLayer=wind&regionalRegion=coastal");
    const signals: AbortSignal[] = [];
    mocks.loadResource.mockImplementation((_link, signal) => {
      signals.push(signal!);
      return new Promise<RegionalResource>(() => undefined);
    });
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load regional details").click());
    await flush();
    expect(button(host, "Wind regions").getAttribute("aria-pressed")).toBe("true");
    const coastal = host.querySelector<HTMLButtonElement>('button[aria-label^="coastal,"]')!;
    expect(coastal.getAttribute("aria-pressed")).toBe("true");

    coastal.focus();
    await act(async () =>
      coastal.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await flush();
    const south = host.querySelector<HTMLButtonElement>('button[aria-label^="south,"]')!;
    expect(south).toBe(document.activeElement);
    expect(new URL(window.location.href).searchParams.get("regionalRegion")).toBe("south");
    expect(signals[0]?.aborted).toBe(true);

    await traverseHistory("back");
    expect(button(host, "Wind regions").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('button[aria-label^="coastal,"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(signals.at(-2)?.aborted).toBe(true);

    await traverseHistory("forward");
    expect(host.querySelector('button[aria-label^="south,"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    await act(async () => button(host, "Hide regional details").click());
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
  });

  it("keeps labeled last-good data visible when manifest revalidation fails", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load regional details").click());
    await flush();
    expect(host.querySelector("caption")?.textContent).toBe("Exact weather-zone load values");

    mocks.loadManifest.mockRejectedValueOnce(new Error("sanitized_revalidation_failure"));
    await act(async () => revalidateManifest!());
    await flush();
    expect(host.textContent).toContain(
      "Refresh failed; showing the last successful regional snapshot and its source timestamps.",
    );
    expect(host.querySelector('[data-lifecycle-state="unavailable"]')).toBeNull();
    expect(host.querySelector("caption")?.textContent).toBe("Exact weather-zone load values");
    expect(host.querySelector('[aria-label="Regional source freshness"]')?.textContent).toContain(
      "last success",
    );
  });
});
