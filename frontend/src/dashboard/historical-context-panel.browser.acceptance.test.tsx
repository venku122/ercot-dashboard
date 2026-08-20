// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoricalContextPanel } from "./HistoricalContextPanel";
import { historicalContextFixture } from "./historical-context-acceptance.test";
import type { HistoricalContextResolver } from "./historical-context";

const mocks = vi.hoisted(() => ({ loadHistoricalContext: vi.fn() }));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  loadHistoricalContext: mocks.loadHistoricalContext,
}));

const AS_OF = 1_800_003_600;
let revalidate: (() => Promise<unknown>) | null = null;

function RevalidationBridge({ asOf }: { asOf: number }) {
  const { mutate } = useSWRConfig();
  revalidate = () => mutate(["historical-context", asOf]);
  return null;
}

function fixture(asOf = AS_OF, selectedValue = 75_000): HistoricalContextResolver {
  const result = structuredClone(historicalContextFixture());
  result.summary.as_of = asOf;
  result.summary.selected_hour.start = asOf - 3_600;
  result.summary.selected_hour.end = asOf;
  result.summary.selected_hour.utc_intervals = [{ start: asOf - 3_600, end: asOf }];
  result.summary.selected_hour.value = { timestamp: asOf - 300, value: selectedValue };
  result.resource.url = `/api/v2/historical-context/supply-demand.demand/v1/${result.resource.content_version}/${String(asOf)}`;
  return result;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PR20 historical context browser lifecycle acceptance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.loadHistoricalContext.mockReset().mockResolvedValue(fixture());
    revalidate = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  function render(enabled: boolean, expanded: boolean, asOf = AS_OF) {
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <RevalidationBridge asOf={asOf} />
        <HistoricalContextPanel
          asOf={asOf}
          enabled={enabled}
          expanded={expanded}
          onExpandedChange={vi.fn()}
        />
      </SWRConfig>,
    );
  }

  it("makes zero requests outside Overview or collapsed and one resolver request when opened", async () => {
    await act(async () => render(false, false));
    await flush();
    expect(mocks.loadHistoricalContext).not.toHaveBeenCalled();

    await act(async () => render(true, false));
    await flush();
    expect(mocks.loadHistoricalContext).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Open historical context and records");

    await act(async () => render(true, true));
    await flush();
    expect(mocks.loadHistoricalContext).toHaveBeenCalledTimes(1);
    expect(mocks.loadHistoricalContext.mock.calls[0]![0]).toBe(AS_OF);
    expect(mocks.loadHistoricalContext.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(container.textContent).toContain("75.0 GW");
    expect(container.textContent).toContain("Previous local day, same hour");
    expect(container.textContent).toContain("Type 7");
    expect(container.textContent).toContain("not a forecast or an all-time ERCOT record");
    expect(container.querySelectorAll(".historical-context-exact tbody tr")).toHaveLength(10);
  });

  it("aborts on as-of change, collapse, and unmount while labeling last-good data", async () => {
    const signals: AbortSignal[] = [];
    const resolves: Array<(value: HistoricalContextResolver) => void> = [];
    mocks.loadHistoricalContext.mockImplementation(
      (_asOf: number, signal: AbortSignal) =>
        new Promise<HistoricalContextResolver>((resolve) => {
          signals.push(signal);
          resolves.push(resolve);
        }),
    );

    await act(async () => render(true, true));
    await flush();
    await act(async () => render(true, true, AS_OF + 3_600));
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => resolves[0]!(fixture(AS_OF, 74_000)));
    await flush();
    expect(container.textContent).not.toContain("74.0 GW");
    expect(container.textContent).toContain("Historical context pending");

    await act(async () => resolves[1]!(fixture(AS_OF + 3_600, 76_000)));
    await flush();
    expect(container.textContent).toContain("76.0 GW");

    await act(async () => render(true, true, AS_OF + 7_200));
    await flush();
    await act(async () => render(true, false, AS_OF + 7_200));
    expect(signals[2]!.aborted).toBe(true);

    await act(async () => render(true, true, AS_OF + 10_800));
    await flush();
    expect(signals).toHaveLength(4);
    await act(async () => root.unmount());
    expect(signals[3]!.aborted).toBe(true);
  });

  it("distinguishes partial, unavailable, and refresh-failed last-good states", async () => {
    const partial = fixture();
    partial.state = "partial";
    partial.summary.selected_hour.coverage = {
      state: "partial",
      expected_count: 12,
      observed_count: 9,
      ratio: 0.75,
      first_observed_at: AS_OF - 3_600,
      last_observed_at: AS_OF - 1_200,
    };
    partial.summary.selected_hour.value = null;
    mocks.loadHistoricalContext.mockResolvedValueOnce(partial);
    await act(async () => render(true, true));
    await flush();
    expect(container.closest("body")?.textContent).toContain("partial coverage");

    mocks.loadHistoricalContext.mockRejectedValueOnce(new Error("refresh_failed"));
    await act(async () => {
      await revalidate?.();
    });
    await flush();
    expect(container.textContent).toContain("Refresh failed");
    expect(container.textContent).toContain("last successfully loaded summary");
  });
});
