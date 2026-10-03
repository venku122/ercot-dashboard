// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageOperationsSummary } from "./StorageOperationsSummary";
import type { LoadedSeries, SourceHealth, TimeState } from "./types";

const OBSERVED = Date.parse("2026-08-20T17:15:00Z") / 1_000;

function loaded(points: Array<[number, number]>): LoadedSeries {
  return { compare: [], error: null, meta: {}, points };
}

function seriesData(
  options: { charging?: number; discharging?: number; noSharedTime?: boolean; net?: number } = {},
) {
  const charging = options.charging ?? -120;
  const discharging = options.discharging ?? 30;
  return new Map<string, LoadedSeries>([
    [
      "storage:charging",
      loaded([
        [OBSERVED - 300, -90],
        [OBSERVED, charging],
        [OBSERVED + 300, -500],
      ]),
    ],
    [
      "storage:discharging",
      loaded([[options.noSharedTime ? OBSERVED + 600 : OBSERVED, discharging]]),
    ],
    [
      "storage:net-output",
      loaded([
        [OBSERVED, options.net ?? charging + discharging],
        [OBSERVED + 300, -450],
      ]),
    ],
  ]);
}

function health(state: "healthy" | "stale" | "failed" = "healthy"): SourceHealth {
  return {
    age_seconds: state === "healthy" ? 60 : 3_600,
    collection_age_seconds: state === "healthy" ? 30 : 900,
    collection_state: state === "failed" ? "failed" : "healthy",
    consecutive_failures: state === "failed" ? 3 : 0,
    data_age_seconds: state === "healthy" ? 60 : 3_600,
    data_timestamp_ts: OBSERVED,
    display_name: "ERCOT Energy Storage Resources",
    expected_interval_seconds: 300,
    freshness_state: state === "healthy" ? "fresh" : "stale",
    last_attempt_ts: OBSERVED,
    last_error: state === "healthy" ? null : "fixture_failure",
    last_row_count: 3,
    last_success_ts: OBSERVED,
    publication_interval_seconds: 300,
    publication_mode: "polling",
    source_id: "energy_storage",
    source_timestamp_ts: OBSERVED,
    state,
  };
}

const live: TimeState = {
  end: OBSERVED + 300,
  mode: "live",
  paused: false,
  rangeSeconds: 21_600,
  start: OBSERVED - 21_300,
};

describe("PR16 storage operations summary browser acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function render(
    data: Map<string, LoadedSeries>,
    sourceHealth: SourceHealth | null = health(),
    time: TimeState = live,
  ) {
    await act(async () => {
      root.render(
        <StorageOperationsSummary seriesData={data} sourceHealth={sourceHealth} time={time} />,
      );
    });
  }

  it("renders one coherent observation and never makes a request", async () => {
    await render(seriesData());
    expect(container.textContent).toContain("Charging");
    expect(container.textContent).toContain("-120.0 MW");
    expect(container.textContent).toContain("30.0 MW");
    expect(container.textContent).toContain("-90.0 MW");
    expect(container.textContent).not.toContain("-500.0 MW");
    expect(fetchMock).not.toHaveBeenCalled();

    const exact = container.querySelector<HTMLElement>(
      '[role="region"][aria-label="Exact coherent storage observation"]',
    );
    expect(exact?.tabIndex).toBe(0);
    expect(exact?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(exact?.textContent).toContain("2026-08-20T17:15:00.000Z");
    expect(exact?.textContent).toContain("0.0 MW");
  });

  it("states partial coherence without borrowing independently latest values", async () => {
    await render(seriesData({ noSharedTime: true }));
    expect(container.textContent).toContain("Coherent fleet snapshot unavailable");
    expect(container.textContent).toContain("shared-timestamp");
    expect(container.textContent).toContain("Older values are not borrowed");
    expect(container.querySelector(".storage-operations-grid")).toBeNull();
  });

  it("keeps the last coherent snapshot visibly stale and rejects causal or SOC inference", async () => {
    await render(seriesData(), health("failed"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "last coherent storage snapshot; source is stale",
    );
    expect(container.textContent).toContain("does not report state of charge");
    expect(container.textContent).toContain("individual resources");
    expect(container.textContent).toContain("context—not attributed causes");
  });

  it("uses strict deadband copy at both boundaries", async () => {
    await render(seriesData({ charging: -80, discharging: 30, net: -50 }));
    expect(container.textContent).toContain("Near idle");
    await render(seriesData({ charging: -10, discharging: 60, net: 50 }));
    expect(container.textContent).toContain("Near idle");
    await render(seriesData({ charging: -10, discharging: 60.01, net: 50.01 }));
    expect(container.textContent).toContain("Discharging");
  });

  it("surfaces source-balance mismatch as partial without values", async () => {
    await render(seriesData({ net: -88 }));
    expect(container.textContent).toContain("Coherent fleet snapshot unavailable");
    expect(container.textContent).toContain("source-balance");
    expect(container.querySelector(".storage-operations-grid")).toBeNull();
  });

  it("does not present a current fleet mode for a fixed history window", async () => {
    await render(seriesData(), health(), { ...live, mode: "fixed", paused: true });
    expect(container.textContent).toContain("Fleet operating mode is shown only in Live mode");
    expect(container.textContent).toContain("chart and exact table remain the reviewed history");
    expect(container.querySelector(".storage-operations-grid")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
