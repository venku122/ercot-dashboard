// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageContextReplay } from "./StorageContextReplay";
import { StorageOperationsSummary } from "./StorageOperationsSummary";
import type { MarketManifest } from "./market-mechanics";
import type { LoadedSeries, SourceHealth, TimeState } from "./types";

const mocks = vi.hoisted(() => ({
  loadMarketManifest: vi.fn(),
  loadSeries: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadSeries: mocks.loadSeries,
}));
vi.mock("./market-mechanics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-mechanics")>()),
  loadMarketManifest: mocks.loadMarketManifest,
}));

const END = 1_777_000_000;
const live: TimeState = {
  end: END,
  mode: "live",
  paused: false,
  rangeSeconds: 21_600,
  start: END - 21_600,
};

function loaded(points: Array<[number, number]>): LoadedSeries {
  return { compare: [], error: null, meta: {}, points };
}

function storageData(offset = 0) {
  return new Map<string, LoadedSeries>([
    ["storage:charging", loaded([[END - 900, -120 - offset]])],
    ["storage:discharging", loaded([[END - 900, 30]])],
    ["storage:net-output", loaded([[END - 900, -90 - offset]])],
  ]);
}

function sourceHealth(state: "healthy" | "stale" | "failed" = "healthy"): SourceHealth {
  return {
    age_seconds: state === "healthy" ? 30 : 3_600,
    collection_age_seconds: state === "healthy" ? 30 : 900,
    collection_state: state === "failed" ? "failed" : "healthy",
    consecutive_failures: state === "failed" ? 2 : 0,
    data_age_seconds: state === "healthy" ? 30 : 3_600,
    data_timestamp_ts: END - 900,
    display_name: "ERCOT Energy Storage Resources",
    expected_interval_seconds: 300,
    freshness_state: state === "healthy" ? "fresh" : "stale",
    last_attempt_ts: END,
    last_error: state === "healthy" ? null : "fixture_failure",
    last_row_count: 3,
    last_success_ts: END - 900,
    publication_interval_seconds: 300,
    publication_mode: "polling",
    source_id: "energy_storage",
    source_timestamp_ts: END - 900,
    state,
  };
}

function reading(
  sourceId: "ercot_mis_np6_322" | "ercot_mis_np6_328",
  productId: "NP6-322-CD" | "NP6-328-CD",
  value: number,
) {
  return {
    source: {
      document_id: productId === "NP6-322-CD" ? "322123" : "328123",
      issued_at: END - 590,
      product_id: productId,
      raw_publish_datetime: "2026-04-25T11:50:10-05:00",
      raw_sced_timestamp: "04/25/2026 11:50:00",
      repeated_hour_flag: false,
      source_id: sourceId,
      vintage_key: `mm1-${"a".repeat(64)}`,
    },
    unit: productId === "NP6-322-CD" ? "$/MWh" : "MW",
    value,
  };
}

function manifest(options: { stale?: boolean; target?: number } = {}) {
  const target = options.target ?? END - 600;
  return {
    current: {
      alignment: "exact_same_sced_timestamp",
      lambda_parity: { delta: 0, state: "match", tolerance: 0.00005 },
      readings: {
        "market.sced.as-capability.regup-rrs-ecrs-nonspin": reading(
          "ercot_mis_np6_328",
          "NP6-328-CD",
          4_250,
        ),
        "market.sced.system-lambda": reading("ercot_mis_np6_322", "NP6-322-CD", -15.25),
      },
      target_ts: target,
    },
    previous: null,
    source_health: [
      {
        data_timestamp_ts: target,
        gap_count: options.stale ? 1 : 0,
        last_error: options.stale ? "document_gap" : null,
        source_id: "ercot_mis_np6_322",
        state: options.stale ? "delayed" : "healthy",
      },
      {
        data_timestamp_ts: target,
        gap_count: 0,
        last_error: null,
        source_id: "ercot_mis_np6_328",
        state: "healthy",
      },
    ],
  } as MarketManifest;
}

function frequency(value = 59.98, timestamp = END - 601) {
  return new Map([["storage-context-frequency:frequency", loaded([[timestamp, value]])]]);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PR17 storage context replay browser acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.loadSeries.mockReset().mockResolvedValue(frequency());
    mocks.loadMarketManifest.mockReset().mockResolvedValue(manifest());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("makes zero replay requests while collapsed, then loads only frequency and market context", async () => {
    await act(async () => {
      root.render(
        <StorageOperationsSummary
          seriesData={storageData()}
          sourceHealth={sourceHealth()}
          time={live}
        />,
      );
    });
    expect(mocks.loadSeries).not.toHaveBeenCalled();
    expect(mocks.loadMarketManifest).not.toHaveBeenCalled();

    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Open multi-cadence storage context replay"),
    )!;
    await act(async () => button.click());
    await flush();

    expect(mocks.loadSeries).toHaveBeenCalledTimes(1);
    expect(mocks.loadSeries.mock.calls[0]![0]).toHaveLength(1);
    expect(mocks.loadSeries.mock.calls[0]![0][0].series).toHaveLength(1);
    expect(mocks.loadSeries.mock.calls[0]![0][0].series[0].metric).toBe(
      "ercot.Frequency.Current_Frequency",
    );
    expect(mocks.loadMarketManifest).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Recent two-hour source-observation view");
    expect(container.textContent).toContain(
      "timing alone does not establish attribution or operational intent",
    );
  });

  it("aborts replay-owned requests on collapse and unmount", async () => {
    const signals: AbortSignal[] = [];
    mocks.loadSeries.mockImplementation(
      (_charts, _time, _compare, _offset, signal: AbortSignal) =>
        new Promise(() => signals.push(signal)),
    );
    mocks.loadMarketManifest.mockImplementation(
      (signal: AbortSignal) => new Promise(() => signals.push(signal)),
    );
    await act(async () => {
      root.render(
        <StorageOperationsSummary
          seriesData={storageData()}
          sourceHealth={sourceHealth()}
          time={live}
        />,
      );
    });
    const open = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith("Open multi-cadence storage context replay"),
    )!;
    await act(async () => open.click());
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    const close = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.startsWith("Close multi-cadence storage context replay"),
    )!;
    await act(async () => close.click());
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    mocks.loadSeries.mockImplementation(
      (_charts, _time, _compare, _offset, signal: AbortSignal) =>
        new Promise(() => signals.push(signal)),
    );
    mocks.loadMarketManifest.mockImplementation(
      (signal: AbortSignal) => new Promise(() => signals.push(signal)),
    );
    await act(async () => open.click());
    await flush();
    const unmountSignals = signals.slice(-2);
    await act(async () => root.unmount());
    expect(unmountSignals.every((signal) => signal.aborted)).toBe(true);
    root = createRoot(container);
  });

  it("aborts a switched window and does not mix its late result into the current replay", async () => {
    type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; signal?: AbortSignal };
    const frequencies: Array<Deferred<Map<string, LoadedSeries>>> = [];
    const markets: Array<Deferred<MarketManifest>> = [];
    mocks.loadSeries.mockImplementation(
      (_charts, _time, _compare, _offset, signal: AbortSignal) => {
        let resolve!: (value: Map<string, LoadedSeries>) => void;
        const promise = new Promise<Map<string, LoadedSeries>>((next) => (resolve = next));
        frequencies.push({ promise, resolve, signal });
        return promise;
      },
    );
    mocks.loadMarketManifest.mockImplementation((signal: AbortSignal) => {
      let resolve!: (value: MarketManifest) => void;
      const promise = new Promise<MarketManifest>((next) => (resolve = next));
      markets.push({ promise, resolve, signal });
      return promise;
    });

    await act(async () => {
      root.render(
        <StorageContextReplay
          seriesData={storageData()}
          sourceHealth={sourceHealth()}
          time={live}
        />,
      );
    });
    const nextTime = { ...live, end: END + 600, start: live.start + 600 };
    await act(async () => {
      root.render(
        <StorageContextReplay
          seriesData={storageData(100)}
          sourceHealth={sourceHealth()}
          time={nextTime}
        />,
      );
    });
    expect(frequencies[0].signal?.aborted).toBe(true);
    expect(markets[0].signal?.aborted).toBe(true);

    await act(async () => {
      frequencies[1].resolve(frequency(60.02, END));
      markets[1].resolve(manifest({ target: END }));
      await Promise.all([frequencies[1].promise, markets[1].promise]);
    });
    await flush();
    expect(container.textContent).toContain("60.02");
    expect(container.textContent).toContain("-220");

    await act(async () => {
      frequencies[0].resolve(frequency(58.5));
      markets[0].resolve(manifest({ target: END - 600 }));
      await Promise.all([frequencies[0].promise, markets[0].promise]);
    });
    await flush();
    expect(container.textContent).not.toContain("58.5");
    expect(container.textContent).toContain("60.02");
  });

  it("renders separate scales, exact native provenance, negative values, and degraded states", async () => {
    mocks.loadSeries.mockRejectedValue(new Error("frequency_refresh_failed"));
    mocks.loadMarketManifest.mockResolvedValue(manifest({ stale: true }));
    await act(async () => {
      root.render(
        <StorageContextReplay
          seriesData={storageData()}
          sourceHealth={sourceHealth("failed")}
          time={live}
        />,
      );
    });
    await flush();

    expect(container.querySelectorAll(".storage-context-lane")).toHaveLength(4);
    expect(container.textContent).toContain("Storage fleet (MW)");
    expect(container.textContent).toContain("System frequency (Hz)");
    expect(container.textContent).toContain("System Lambda ($/MWh)");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "One or more context sources could not be loaded",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("stale or unhealthy");
    expect(container.textContent).toContain("Official annotations are unavailable");
    expect(container.textContent).toContain("window_extrema_v1");

    const exact = container.querySelector<HTMLElement>(
      '[role="region"][aria-label="Storage context replay exact observations"]',
    );
    expect(exact?.tabIndex).toBe(0);
    expect(exact?.textContent).toContain("-120");
    expect(exact?.textContent).toContain("-15.25");
    expect(exact?.textContent).toContain("source_epoch");
    expect(exact?.textContent).toContain("raw SCED 04/25/2026 11:50:00");
    expect(exact?.textContent).not.toContain("58.5");
  });

  it("fails individual fulfilled-but-partial or nonnative lanes closed without zero filling", async () => {
    const partialFrequency = loaded([[END - 601, 59.75]]);
    partialFrequency.error = "partial_frequency";
    mocks.loadSeries.mockResolvedValue(
      new Map([["storage-context-frequency:frequency", partialFrequency]]),
    );
    const partialStorage = storageData();
    partialStorage.get("storage:charging")!.meta.bucket_seconds = 900;
    await act(async () => {
      root.render(
        <StorageContextReplay
          seriesData={partialStorage}
          sourceHealth={sourceHealth()}
          time={live}
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain(
      "Frequency is unavailable because its request failed or was not native 60-second data",
    );
    expect(container.textContent).toContain("Native five-minute storage unavailable: charging");
    expect(container.textContent).not.toContain("59.75");
    expect(container.textContent).not.toContain("Charging minimum");
    expect(container.textContent).toContain("No exact source observations in this two-hour window");
  });
});
