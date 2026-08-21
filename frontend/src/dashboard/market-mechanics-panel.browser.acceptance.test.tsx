// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketMechanicsPanel } from "./MarketMechanicsPanel";
import {
  MARKET_SERIES,
  type MarketManifest,
  type MarketResource,
  type MarketResourceLink,
  type MarketSeriesKey,
} from "./market-mechanics";

const mocks = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  loadResource: vi.fn(),
}));

vi.mock("./market-mechanics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-mechanics")>()),
  loadMarketManifest: mocks.loadManifest,
  loadMarketResource: mocks.loadResource,
}));

const DAY = 1_787_011_200;
const NOW = DAY + 64_800;
const VERSION = `mmr1-${"a".repeat(64)}`;

function productFor(key: MarketSeriesKey): [string, string] {
  if (key === "market.sced.system-lambda") return ["ercot_mis_np6_322", "NP6-322-CD"];
  if (key.includes("price-adder") || key.includes("adder-input")) {
    return ["ercot_mis_np6_323", "NP6-323-CD"];
  }
  if (key.includes("as-capability")) return ["ercot_mis_np6_328", "NP6-328-CD"];
  return ["ercot_mis_np6_332", "NP6-332-CD"];
}

function source(key: MarketSeriesKey) {
  const [sourceId, productId] = productFor(key);
  return {
    source_id: sourceId,
    product_id: productId,
    vintage_key: `mm1-${"b".repeat(64)}`,
    document_id: "123456789",
    issued_at: NOW - 60,
    raw_publish_datetime: "2026-08-18T12:59:00-05:00",
    raw_sced_timestamp: "08/18/2026 12:58:58",
    repeated_hour_flag: false,
  };
}

function link(key: MarketSeriesKey): MarketResourceLink {
  return {
    series_key: key,
    tile_start: DAY,
    content_version: VERSION,
    lod: "native",
    url: `/api/v2/market-mechanics/${key}/v1/${VERSION}/1d/${DAY}/native`,
  };
}

function manifest(): MarketManifest {
  const readings = Object.fromEntries(
    (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key, index) => [
      key,
      { value: index + 0.25, unit: MARKET_SERIES[key], source: source(key) },
    ]),
  ) as MarketManifest["current"] extends { readings: infer Readings } ? Readings : never;
  return {
    explanation_policy: "time_adjacent_context_not_causal_decomposition",
    current: {
      target_ts: NOW - 62,
      alignment: "exact_same_sced_timestamp",
      readings,
      lambda_parity: { state: "match", delta: 0, tolerance: 0.00005 },
    },
    previous: null,
    changes: Object.fromEntries(
      (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key) => [
        key,
        { delta: null, unit: MARKET_SERIES[key] },
      ]),
    ) as MarketManifest["changes"],
    elapsed_seconds: null,
    source_health: [
      {
        source_id: "ercot_mis_np6_322",
        state: "healthy",
        data_timestamp_ts: NOW - 62,
        gap_count: 0,
        last_error: null,
      },
      {
        source_id: "ercot_mis_np6_323",
        state: "delayed",
        data_timestamp_ts: NOW - 662,
        gap_count: 1,
        last_error: "document_gap",
      },
      {
        source_id: "ercot_mis_np6_328",
        state: "healthy",
        data_timestamp_ts: NOW - 62,
        gap_count: 0,
        last_error: null,
      },
      {
        source_id: "ercot_mis_np6_332",
        state: "healthy",
        data_timestamp_ts: NOW - 62,
        gap_count: 0,
        last_error: null,
      },
    ],
    materialization_health: {
      state: "healthy",
      last_success_ts: NOW,
      consecutive_failures: 0,
      last_error: null,
    },
    resources: [link("market.sced.price-adder.regup"), link("market.sced.system-lambda")],
  };
}

function resource(resourceLink: MarketResourceLink): MarketResource {
  return {
    series_key: resourceLink.series_key,
    tile_start: DAY,
    tile_end: DAY + 86_400,
    unit: MARKET_SERIES[resourceLink.series_key],
    rows: [
      { target_ts: DAY + 60, value: 1, source: source(resourceLink.series_key) },
      { target_ts: DAY + 360, value: 2, source: source(resourceLink.series_key) },
      { target_ts: DAY + 660, value: 1.5, source: source(resourceLink.series_key) },
    ],
  };
}

let activeRoot: Root | null = null;
let revalidateManifest: (() => Promise<unknown>) | null = null;

function RevalidationProbe() {
  const { mutate } = useSWRConfig();
  revalidateManifest = () => mutate(["market-mechanics", "manifest"]);
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
        <MarketMechanicsPanel enabled={enabled} />
        <RevalidationProbe />
      </SWRConfig>,
    );
  });
  return { host, root };
}

function button(host: HTMLElement, prefix: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent?.startsWith(prefix))!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.loadManifest.mockReset();
  mocks.loadResource.mockReset();
  mocks.loadManifest.mockResolvedValue(manifest());
  mocks.loadResource.mockImplementation(async (resourceLink) => resource(resourceLink));
  revalidateManifest = null;
});

afterEach(async () => {
  if (activeRoot) await act(async () => activeRoot?.unmount());
  activeRoot = null;
  revalidateManifest = null;
  document.body.replaceChildren();
});

describe("market mechanics panel independent lifecycle acceptance", () => {
  it("is collapsed-lazy and fetches one manifest plus selected history only", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    expect(mocks.loadManifest).not.toHaveBeenCalled();
    expect(mocks.loadResource).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Context, not a price decomposition or proof of cause");

    await act(async () => button(host, "Load market-mechanics details").click());
    await flush();
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource.mock.calls[0]![0].series_key).toBe("market.sced.system-lambda");
    expect(host.textContent).toContain(
      "Some market-mechanics sources or derived history are stale",
    );
    expect(host.textContent).toContain("RTDLL (source field; definition pending)");
    expect(host.textContent).toContain("RTBLT import (source field)");
    expect(host.textContent).toContain("1 official document gap recorded");
    expect(host.querySelector('[aria-label="System Lambda completed-day profile"]')).not.toBeNull();
    expect(
      host.querySelector('[aria-label="System Lambda exact values"]')?.getAttribute("tabindex"),
    ).toBe("0");

    await act(async () => button(host, "Reg-Up adder").click());
    await flush();
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource).toHaveBeenCalledTimes(2);
    expect(mocks.loadResource.mock.calls[1]![0].series_key).toBe("market.sced.price-adder.regup");
    expect(button(host, "Reg-Up adder").getAttribute("aria-pressed")).toBe("true");
  });

  it("aborts manifest/history on collapse or selection change", async () => {
    const manifestSignals: AbortSignal[] = [];
    mocks.loadManifest.mockImplementation((signal) => {
      manifestSignals.push(signal!);
      return new Promise<MarketManifest>(() => undefined);
    });
    let rendered = renderPanel();
    activeRoot = rendered.root;
    await act(async () => button(rendered.host, "Load market-mechanics details").click());
    await flush();
    await act(async () => button(rendered.host, "Hide market-mechanics details").click());
    expect(manifestSignals[0]?.aborted).toBe(true);

    await act(async () => activeRoot?.unmount());
    activeRoot = null;
    document.body.replaceChildren();
    mocks.loadManifest.mockResolvedValue(manifest());
    const historySignals: AbortSignal[] = [];
    mocks.loadResource.mockImplementation((_resourceLink, signal) => {
      historySignals.push(signal!);
      return new Promise<MarketResource>(() => undefined);
    });
    rendered = renderPanel();
    activeRoot = rendered.root;
    await act(async () => button(rendered.host, "Load market-mechanics details").click());
    await flush();
    await act(async () => button(rendered.host, "Reg-Up adder").click());
    await flush();
    expect(historySignals[0]?.aborted).toBe(true);
    await act(async () => button(rendered.host, "Hide market-mechanics details").click());
    expect(historySignals.at(-1)?.aborted).toBe(true);
  });

  it("keeps labeled last-good data when manifest revalidation fails", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load market-mechanics details").click());
    await flush();
    expect(host.querySelector('[aria-label="System Lambda exact values"]')).not.toBeNull();

    mocks.loadManifest.mockRejectedValueOnce(new Error("sanitized_market_refresh_failure"));
    await act(async () => revalidateManifest!());
    await flush();
    expect(host.textContent).toContain(
      "Refresh failed; showing the last successful market snapshot",
    );
    expect(host.querySelector('[aria-label="System Lambda exact values"]')).not.toBeNull();
  });
});
