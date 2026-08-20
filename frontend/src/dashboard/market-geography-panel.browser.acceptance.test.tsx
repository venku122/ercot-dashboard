// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketGeographyPanel } from "./MarketGeographyPanel";
import {
  MARKET_DISPLAY_POINTS,
  MARKET_PRICE_POINTS,
  MARKET_REFERENCE_POINTS,
  type MarketGeographyLink,
  type MarketGeographyManifest,
  type MarketGeographyResource,
} from "./market-geography";

const mocks = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  loadResource: vi.fn(),
}));

vi.mock("./market-geography", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-geography")>()),
  loadMarketGeographyManifest: mocks.loadManifest,
  loadMarketGeographyResource: mocks.loadResource,
}));

const DAY = Date.parse("2026-08-19T00:00:00Z") / 1_000;
const PRICE_TARGET = Date.parse("2026-08-20T18:15:00Z") / 1_000;
const SCED_TARGET = Date.parse("2026-08-20T17:40:18Z") / 1_000;
const VERSION = `mgr1-${"a".repeat(64)}`;
const CONSTRAINT_KEY = "a".repeat(24);

function link(kind: "prices" | "constraints", identity: string): MarketGeographyLink {
  return {
    kind,
    identity,
    tile_start: DAY,
    content_version: VERSION,
    lod: "native",
    url: `/api/v2/market-geography/${kind}/${identity}/v1/${VERSION}/1d/${DAY}/native`,
  };
}

function manifest(): MarketGeographyManifest {
  const prices = MARKET_DISPLAY_POINTS.map(([point, pointType], index) => ({
    target_ts: PRICE_TARGET,
    raw_delivery_date: "08/20/2026",
    delivery_hour: 13,
    delivery_interval: 1,
    raw_dst_flag: "N" as const,
    repeated_hour_flag: false,
    settlement_point: point,
    settlement_point_type: pointType,
    value: -50 + index * 50,
    unit: "$/MWh" as const,
  }));
  return {
    as_of: PRICE_TARGET + 60,
    settlement_interval: {
      state: "available",
      target_ts: PRICE_TARGET,
      rows: prices.filter((row) =>
        MARKET_PRICE_POINTS.some(
          ([point, pointType]) =>
            point === row.settlement_point && pointType === row.settlement_point_type,
        ),
      ),
      reference_prices: prices.filter((row) =>
        MARKET_REFERENCE_POINTS.some(
          ([point, pointType]) =>
            point === row.settlement_point && pointType === row.settlement_point_type,
        ),
      ),
      missing: [],
    },
    lmp_snapshot: {
      state: "available",
      target_ts: SCED_TARGET,
      rows: MARKET_DISPLAY_POINTS.map(([point], index) => ({
        target_ts: SCED_TARGET,
        raw_sced_timestamp: "08/20/2026 12:40:18",
        repeated_hour_flag: false,
        settlement_point: point,
        value: index,
        unit: "$/MWh",
      })),
      missing: [],
    },
    constraints: {
      state: "available",
      target_ts: SCED_TARGET,
      rows: [
        {
          constraint_key: CONSTRAINT_KEY,
          constraint_id: "101",
          constraint_name: "North transfer constraint",
          contingency_name: "Loss of parallel line",
          shadow_price: 125,
          max_shadow_price: 200,
          limit_mw: 1_000,
          value_mw: 995,
          violated_mw: 0,
          from_station: "NORTH A",
          to_station: "NORTH B",
          from_station_kv: 345,
          to_station_kv: 345,
          cct_status: "COMP",
          cct_status_label: "competitive",
          raw_sced_timestamp: "08/20/2026 12:40:18",
          repeated_hour_flag: false,
          target_ts: SCED_TARGET,
        },
      ],
      total_count: 1,
      truncated: false,
    },
    source_health: ["ercot_mis_np6_788", "ercot_mis_np6_86", "ercot_mis_np6_905"].map(
      (source_id) => ({
        source_id,
        state: "healthy" as const,
        availability_status: "available",
        last_success_ts: PRICE_TARGET,
        data_timestamp_ts: PRICE_TARGET,
        data_age_seconds: 60,
        gap_count: 0,
        consecutive_failures: 0,
        last_error: null,
      }),
    ),
    materialization_health: {
      state: "healthy",
      last_attempt_ts: PRICE_TARGET,
      last_success_ts: PRICE_TARGET,
      consecutive_failures: 0,
      last_error: null,
    },
    resources: [
      link("prices", "HB_HOUSTON--HU"),
      link("prices", "LZ_WEST--LZ"),
      link("constraints", CONSTRAINT_KEY),
    ],
  };
}

function resource(resourceLink: MarketGeographyLink): MarketGeographyResource {
  const source = { document_id: "123456789" };
  const targets = [DAY + 900, DAY + 1_800, DAY + 4_500, DAY + 5_400];
  return {
    kind: resourceLink.kind,
    identity: resourceLink.identity,
    tile_start: DAY,
    tile_end: DAY + 86_400,
    unit: resourceLink.kind === "constraints" ? "mixed_reviewed_fields" : "$/MWh",
    rows: targets.map((target_ts, index) =>
      resourceLink.kind === "prices"
        ? { target_ts, value: index * 10, source }
        : { target_ts, shadow_price: index * 5, source },
    ),
  };
}

let activeRoot: Root | null = null;

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
          onErrorRetry: () => undefined,
          shouldRetryOnError: false,
        }}
      >
        <MarketGeographyPanel enabled={enabled} />
      </SWRConfig>,
    );
  });
  return { host, root };
}

function button(host: HTMLElement, prefix: string) {
  return [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.trim().startsWith(prefix),
  )!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/?view=market");
  mocks.loadManifest.mockReset();
  mocks.loadResource.mockReset();
  mocks.loadManifest.mockResolvedValue(manifest());
  mocks.loadResource.mockImplementation(async (resourceLink) => resource(resourceLink));
});

afterEach(async () => {
  if (activeRoot) await act(async () => activeRoot?.unmount());
  activeRoot = null;
  document.body.replaceChildren();
});

describe("PR15 market geography panel lifecycle acceptance", () => {
  it("is disabled/collapsed lazy, then fetches one manifest and selected histories only", async () => {
    let rendered = renderPanel(false);
    activeRoot = rendered.root;
    await act(async () => button(rendered.host, "Load price-geography details").click());
    await flush();
    expect(mocks.loadManifest).not.toHaveBeenCalled();
    expect(mocks.loadResource).not.toHaveBeenCalled();

    await act(async () => activeRoot?.unmount());
    activeRoot = null;
    document.body.replaceChildren();
    rendered = renderPanel(true);
    activeRoot = rendered.root;
    expect(mocks.loadManifest).not.toHaveBeenCalled();
    await act(async () => button(rendered.host, "Load price-geography details").click());
    await flush();
    expect(mocks.loadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource.mock.calls[0]![0].identity).toBe("HB_HOUSTON--HU");
    expect(rendered.host.querySelectorAll(".market-price-matrix button")).toHaveLength(15);
    expect(
      rendered.host.querySelectorAll('[aria-label="Settlement price exact values"] tbody tr'),
    ).toHaveLength(15);
    expect(rendered.host.textContent).toContain("not a geographic boundary map");

    const westLoadZone = rendered.host.querySelector<HTMLButtonElement>(
      '.market-price-matrix button[aria-label^="West LZ"]',
    )!;
    await act(async () => westLoadZone.click());
    await flush();
    expect(mocks.loadResource.mock.calls.at(-1)![0].identity).toBe("LZ_WEST--LZ");
    await act(async () => button(rendered.host, "Coincident constraints").click());
    await flush();
    expect(rendered.host.textContent).toContain("not establish contribution");
    expect(mocks.loadResource.mock.calls.at(-1)![0].identity).toBe(CONSTRAINT_KEY);
    expect(mocks.loadResource).toHaveBeenCalledTimes(3);
  });

  it("aborts obsolete manifest and history requests", async () => {
    const manifestSignals: AbortSignal[] = [];
    mocks.loadManifest.mockImplementation((signal) => {
      manifestSignals.push(signal!);
      return new Promise<MarketGeographyManifest>(() => undefined);
    });
    let rendered = renderPanel();
    activeRoot = rendered.root;
    await act(async () => button(rendered.host, "Load price-geography details").click());
    await flush();
    await act(async () => button(rendered.host, "Hide price-geography details").click());
    expect(manifestSignals[0]?.aborted).toBe(true);

    await act(async () => activeRoot?.unmount());
    activeRoot = null;
    document.body.replaceChildren();
    mocks.loadManifest.mockResolvedValue(manifest());
    const historySignals: AbortSignal[] = [];
    mocks.loadResource.mockImplementation((_link, signal) => {
      historySignals.push(signal!);
      return new Promise<MarketGeographyResource>(() => undefined);
    });
    rendered = renderPanel();
    activeRoot = rendered.root;
    await act(async () => button(rendered.host, "Load price-geography details").click());
    await flush();
    const westLoadZone = rendered.host.querySelector<HTMLButtonElement>(
      '.market-price-matrix button[aria-label^="West LZ"]',
    )!;
    await act(async () => westLoadZone.click());
    await flush();
    expect(historySignals[0]?.aborted).toBe(true);
    await act(async () => button(rendered.host, "Hide price-geography details").click());
    expect(historySignals.at(-1)?.aborted).toBe(true);
  });

  it("restores a valid constraint URL and requests only that selected history", async () => {
    window.history.replaceState(
      null,
      "",
      `/?view=market&marketLayer=constraints&marketConstraint=${CONSTRAINT_KEY}`,
    );
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load price-geography details").click());
    await flush();
    expect(mocks.loadResource).toHaveBeenCalledTimes(1);
    expect(mocks.loadResource.mock.calls[0]![0].kind).toBe("constraints");
    expect(mocks.loadResource.mock.calls[0]![0].identity).toBe(CONSTRAINT_KEY);
    expect(button(host, "Coincident constraints").getAttribute("aria-pressed")).toBe("true");
  });

  it("sanitizes invalid URL identity without losing unrelated dashboard state", async () => {
    window.history.replaceState(
      null,
      "",
      "/?view=market&range=24h&marketPoint=INVENTED&marketLayer=prices",
    );
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load price-geography details").click());
    await flush();
    const url = new URL(window.location.href);
    expect(url.searchParams.get("marketPoint")).toBe("HB_HOUSTON--HU");
    expect(url.searchParams.get("range")).toBe("24h");
    expect(mocks.loadResource.mock.calls[0]![0].identity).toBe("HB_HOUSTON--HU");
  });

  it("uses one roving matrix tab stop with Arrow/Home/End selection", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load price-geography details").click());
    await flush();
    const matrix = [...host.querySelectorAll<HTMLButtonElement>(".market-price-matrix button")];
    expect(matrix.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(matrix.filter((item) => item.tabIndex === -1)).toHaveLength(14);
    matrix[0]!.focus();
    await act(async () =>
      matrix[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(matrix.at(-1)!.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(matrix.at(-1));
  });

  it("segments missing price history and keeps the exact table keyboard reachable", async () => {
    const { host, root } = renderPanel();
    activeRoot = root;
    await act(async () => button(host, "Load price-geography details").click());
    await flush();
    expect(host.querySelectorAll(".market-geography-profile polyline")).toHaveLength(2);
    expect(
      host
        .querySelector('[aria-label="Selected market geography exact history"]')
        ?.getAttribute("tabindex"),
    ).toBe("0");
  });
});
