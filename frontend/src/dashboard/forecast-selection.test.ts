import { afterEach, expect, it, vi } from "vitest";
import { loadSeries } from "./api";
import { chartDefinitions } from "./chart-config";
afterEach(() => vi.unstubAllGlobals());
it("retrospective demand uses archived issued-before-delivery values and never legacy future snapshots", async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("historical-forecast")
            ? {
                product_id: "NP3-565-CD",
                policy: "issued_before_delivery",
                rows: [
                  {
                    target_ts: 7200,
                    interval_start: 3600,
                    issued_at: 3500,
                    retrieved_at: 7300,
                    first_seen_at: 7300,
                    value: 42,
                    unit: "MW",
                    vintage_key: "v1",
                  },
                ],
              }
            : {
                series: [
                  { id: "supply-demand:forecast-demand:current", points: [[7200, 99]], meta: {} },
                ],
              },
        ),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await loadSeries(
    [chartDefinitions.find((c) => c.id === "supply-demand")!],
    { start: 3600, end: 8000, mode: "live", paused: false, rangeSeconds: 4400 },
    "none",
    0,
    new AbortController().signal,
  );
  expect(result.get("supply-demand:forecast-demand")?.points).toEqual([[7200, 42]]);
  expect(fetcher.mock.calls.some(([url]) => url.includes("policy=issued_before_delivery"))).toBe(
    true,
  );
});
