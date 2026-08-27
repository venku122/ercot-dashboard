// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GridEventTimeline } from "./GridEventTimeline";
import type { GridEventTimeline as GridEventTimelineData } from "./grid-event-timeline";
import type { TimeState } from "./types";

const mocks = vi.hoisted(() => ({ loadGridEventTimeline: vi.fn() }));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadGridEventTimeline: mocks.loadGridEventTimeline,
}));

const START = 1_800_000_000;
const VERSION = `ge1-${"a".repeat(64)}`;
let revalidate: (() => Promise<unknown>) | null = null;

function RevalidationBridge() {
  const { mutate } = useSWRConfig();
  revalidate = () => mutate(["grid-events", START, START + 3_600]);
  return null;
}

function fixed(from = START, to = START + 3_600): TimeState {
  return { end: to, mode: "fixed", paused: false, rangeSeconds: to - from, start: from };
}

function timeline(
  from = START,
  to = START + 3_600,
  title = "Official operations message",
): GridEventTimelineData {
  return {
    schema: 1,
    kind: "grid_event_timeline",
    policy: "multi_source_temporal_context_not_causal_attribution",
    generated_at: to,
    content_version: VERSION,
    window: { from, to, basis: "utc", semantics: "half_open" },
    coverage: {
      txans: "unavailable_unverified_source",
      eea: "collector_accumulated_source_observations",
      operations_messages: "collector_accumulated_official_messages",
      nws_alerts: "texas_statewide_not_ercot_footprint_collected_after_pr19",
    },
    gaps: [
      "txans_unavailable_unverified_source",
      "operations_messages_repeated_hour_ambiguous",
      "history_begins_at_collection",
    ],
    limits: {
      max_window_seconds: 2_678_400,
      max_page_size: 500,
      official_source_retention_seconds: 34_560_000,
      derived_retention_seconds: 7_776_000,
    },
    events: [
      {
        identity: `ops:${from}`,
        source_id: "ercot_operations_messages",
        source_type: "operations_messages",
        evidence_class: "official_ercot",
        event_type: "Operational Information",
        status: "Active",
        severity: "Information",
        title,
        body: null,
        starts_at: from + 60,
        starts_at_candidates: [from + 60],
        ends_at: null,
        observed_at: from + 90,
        source_updated_at: from + 60,
        time_basis: "utc_exact",
        source_url: null,
        derivation: null,
        content_version: VERSION,
      },
      {
        identity: `nws:${from}`,
        source_id: "nws_alerts_tx",
        source_type: "nws_alerts",
        evidence_class: "official_weather",
        event_type: "High Wind Warning",
        status: null,
        severity: "Severe",
        title: "Official NWS wind alert",
        body: "Statewide weather context",
        starts_at: from + 30,
        starts_at_candidates: [from + 30],
        ends_at: from + 600,
        observed_at: from + 40,
        source_updated_at: from + 30,
        time_basis: "utc_exact",
        source_url: "https://api.weather.gov/alerts/urn:oid:test",
        derivation: null,
        content_version: VERSION,
      },
    ],
    next_cursor: null,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PR19 unified grid event timeline browser acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState({}, "", "/?view=reliability&events=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.loadGridEventTimeline.mockReset().mockResolvedValue(timeline());
    revalidate = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  function render(enabled: boolean, time: TimeState) {
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <RevalidationBridge />
        <GridEventTimeline enabled={enabled} time={time} />
      </SWRConfig>,
    );
  }

  it("makes no request while disabled or beyond 31 days, then fetches one exact window", async () => {
    await act(async () => render(false, fixed()));
    await flush();
    expect(mocks.loadGridEventTimeline).not.toHaveBeenCalled();

    await act(async () => render(true, fixed(START, START + 2_678_401)));
    await flush();
    expect(mocks.loadGridEventTimeline).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no event request was made");

    await act(async () => render(true, fixed()));
    await flush();
    expect(mocks.loadGridEventTimeline).toHaveBeenCalledTimes(1);
    expect(mocks.loadGridEventTimeline.mock.calls[0]!.slice(0, 2)).toEqual([START, START + 3_600]);
    expect(mocks.loadGridEventTimeline.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
  });

  it("aborts on window switch, collapse, and unmount without mixing stale windows", async () => {
    const signals: AbortSignal[] = [];
    const resolves: Array<(value: GridEventTimelineData) => void> = [];
    mocks.loadGridEventTimeline.mockImplementation(
      (_from: number, _to: number, signal: AbortSignal) =>
        new Promise<GridEventTimelineData>((resolve) => {
          signals.push(signal);
          resolves.push(resolve);
        }),
    );

    await act(async () => render(true, fixed()));
    await flush();
    await act(async () => render(true, fixed(START + 10_000, START + 13_600)));
    await flush();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);

    await act(async () => resolves[0]!(timeline(START, START + 3_600, "Stale old window")));
    await flush();
    expect(container.textContent).not.toContain("Stale old window");
    await act(async () =>
      resolves[1]!(timeline(START + 10_000, START + 13_600, "Current switched window")),
    );
    await flush();
    expect(container.textContent).toContain("Current switched window");

    await act(async () => render(true, fixed(START + 20_000, START + 23_600)));
    await flush();
    expect(signals).toHaveLength(3);
    await act(async () => render(false, fixed(START + 20_000, START + 23_600)));
    expect(signals[2]!.aborted).toBe(true);

    await act(async () => render(true, fixed(START + 30_000, START + 33_600)));
    await flush();
    expect(signals).toHaveLength(4);
    await act(async () => root.unmount());
    expect(signals[3]!.aborted).toBe(true);
    root = createRoot(container);
  });

  it("renders provenance, statewide weather limits, focus, fixed links, and an exact table", async () => {
    window.history.replaceState({}, "", `/?view=reliability&events=1&event=ops:${START}`);
    await act(async () => render(true, fixed()));
    await flush();

    expect(container.textContent).toContain("Temporal overlap does not establish attribution");
    expect(container.textContent).toContain("Texas statewide, not ERCOT footprint");
    expect(container.textContent).toContain("no events are synthesized");
    expect(container.textContent).toContain("Official ERCOT event");
    expect(container.textContent).toContain("Official NWS weather alert");
    expect(container.textContent).toContain("not an ERCOT grid alert, EEA, or conservation level");
    expect(container.querySelector('[data-event-focused="true"]')).not.toBeNull();

    const links = [...container.querySelectorAll("a")];
    const permalink = new URL(links.find((link) => link.textContent?.includes("Permalink"))!.href);
    expect(permalink.searchParams.get("view")).toBe("reliability");
    expect(permalink.searchParams.get("event")).toBe(`ops:${START}`);
    const replay = new URL(
      links.find((link) => link.textContent?.includes("synchronized storage-context"))!.href,
    );
    expect(replay.searchParams.get("view")).toBe("generation");
    expect(replay.searchParams.get("inspect")).toBe("storage");
    expect(replay.toString()).not.toMatch(/cause|join|attribution/);

    const exact = container.querySelector<HTMLElement>(
      '[aria-label="Unified grid event exact evidence"]',
    )!;
    expect(exact.tabIndex).toBe(0);
    expect(exact.textContent).toContain("Source updated at");
    expect(exact.textContent).toContain("Source URL not supplied");
  });

  it("distinguishes unavailable initial load from refresh-failed last-good evidence", async () => {
    mocks.loadGridEventTimeline.mockRejectedValueOnce(new Error("fixture unavailable"));
    await act(async () => render(true, fixed()));
    await flush();
    expect(container.textContent).toContain(
      "selected multi-source event window could not be loaded",
    );
    expect(container.textContent).not.toContain("No collected events overlap this window");

    mocks.loadGridEventTimeline.mockResolvedValueOnce(timeline());
    await act(async () => {
      await revalidate?.();
    });
    await flush();
    expect(container.textContent).toContain("Official operations message");

    mocks.loadGridEventTimeline.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      await revalidate?.();
    });
    await flush();
    expect(container.textContent).toContain(
      "Refresh failed; showing the last successful event-window response",
    );
    expect(container.textContent).toContain("Official operations message");
  });
});
