// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOverviewData } from "./data-hooks";
import type { TimeState } from "./types";

const overviewQueries = [
  { id: "demand", metric: "ercot.supply_demand.demand_mw" },
  { id: "frequency", metric: "ercot.frequency" },
] as const;
const time: TimeState = {
  end: 1_800_000_000,
  mode: "fixed",
  paused: true,
  rangeSeconds: 86_400,
  start: 1_799_913_600,
};

type Snapshot = ReturnType<typeof useOverviewData>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("overview background refresh", () => {
  it("retains the last snapshot while a replacement is validating", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let standardRequestCount = 0;
    let resolveReplacement = (_response: Response) => {};
    const replacement = new Promise<Response>((resolve) => {
      resolveReplacement = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/latest/batch") {
          const body = JSON.parse(String(init?.body)) as {
            queries: Array<{ id: string; tags: string[] }>;
          };
          const isStandard = body.queries.some((query) => query.id === "demand");
          if (isStandard) {
            standardRequestCount += 1;
            if (standardRequestCount === 2) return replacement;
          }
          return Response.json({
            latest: body.queries.map((query) => ({
              id: query.id,
              point: {
                tags: query.tags,
                ts: time.end - 30,
                value:
                  isStandard && standardRequestCount > 1 && query.id === "demand" ? 71_000 : 68_000,
              },
            })),
          });
        }
        if (url === "/api/v1/source-health") return Response.json({ sources: [] });
        if (url.startsWith("/api/v1/ranking")) return Response.json({ rows: [] });
        if (url.startsWith("/api/v1/events")) return Response.json({ events: [] });
        if (url === "/api/series/batch") {
          const body = JSON.parse(String(init?.body)) as { queries: Array<{ id: string }> };
          return Response.json({
            series: body.queries.map((query) => ({ id: query.id, points: [] })),
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    let snapshot = {} as Snapshot;
    function Probe() {
      snapshot = useOverviewData({ enabled: true, eventsEnabled: false, overviewQueries, time });
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <Probe />
        </SWRConfig>,
      );
    });
    await vi.waitFor(() => expect(snapshot.latest.get("demand")?.value).toBe(68_000));
    expect(standardRequestCount).toBe(1);

    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    await vi.waitFor(() => expect(standardRequestCount).toBe(2));
    expect(snapshot.isLoading).toBe(false);
    expect(snapshot.isValidating).toBe(true);
    expect(snapshot.latest.get("demand")?.value).toBe(68_000);

    await act(async () => {
      resolveReplacement(
        Response.json({
          latest: [
            { id: "demand", point: { tags: [], ts: time.end, value: 71_000 } },
            { id: "frequency", point: { tags: [], ts: time.end, value: 60 } },
          ],
        }),
      );
    });
    await vi.waitFor(() => expect(snapshot.latest.get("demand")?.value).toBe(71_000));
    expect(snapshot.isValidating).toBe(false);

    await act(async () => root.unmount());
  });

  it("does not request overview resources while disabled", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    let snapshot = {} as Snapshot;
    function Probe() {
      snapshot = useOverviewData({ enabled: false, eventsEnabled: true, overviewQueries, time });
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <Probe />
        </SWRConfig>,
      );
      await Promise.resolve();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(snapshot.isLoading).toBe(false);
    expect(snapshot.isValidating).toBe(false);
    expect(snapshot.latest.size).toBe(0);
    expect(snapshot.statusEvents).toEqual([]);

    await act(async () => root.unmount());
  });
});
