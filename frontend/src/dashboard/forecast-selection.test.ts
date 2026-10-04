import missingHour from "../../test-fixtures/forecast/valid-missing-hour.json";
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
                    interval_end: 7200,
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

it("historical comparison selects its own allowed window and aligns calendar targets", async () => {
  const end = Date.parse("2026-11-01T08:00:00Z") / 1000;
  const start = end - 3600;
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("historical-forecast")) return new Response(JSON.stringify({ series: [] }));
      const request = new URL(url, "http://localhost");
      requests.push(request);
      const target = Number(request.searchParams.get("end")) - 1;
      return new Response(
        JSON.stringify({
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          rows: [
            {
              target_ts: target,
              interval_start: target - 3600,
              interval_end: target,
              issued_at: target - 7200,
              value: requests.length === 1 ? 42 : 24,
              unit: "MW",
            },
          ],
        }),
      );
    }),
  );
  const result = await loadSeries(
    [chartDefinitions.find((c) => c.id === "supply-demand")!],
    { start, end, mode: "live", paused: false, rangeSeconds: 3600 },
    "day",
    0,
    new AbortController().signal,
  );
  expect(requests).toHaveLength(2);
  expect(Number(requests[1]!.searchParams.get("as_of"))).toBe(end - 90000);
  expect(result.get("supply-demand:forecast-demand")?.compare).toEqual([[end, 24]]);
});

for (const comparisonFailure of [false, true]) {
  it(`successful empty archive is distinct from comparison failure=${comparisonFailure}`, async () => {
    let selected = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("historical-forecast"))
          return new Response(JSON.stringify({ series: [] }));
        selected += 1;
        if (comparisonFailure && selected === 2)
          return new Response("upstream unavailable", { status: 503 });
        return new Response(
          JSON.stringify({
            product_id: "NP3-565-CD",
            policy: "issued_before_delivery",
            rows: [],
            coverage: {
              expected_target_count: 1,
              available_value_count: 0,
              missing_value_count: 1,
              truncated: false,
            },
          }),
        );
      }),
    );
    const result = await loadSeries(
      [chartDefinitions.find((chart) => chart.id === "supply-demand")!],
      { start: 3600, end: 7200, mode: "live", paused: false, rangeSeconds: 3600 },
      "previous_period",
      0,
      new AbortController().signal,
    );
    const forecast = result.get("supply-demand:forecast-demand")!;
    expect(forecast.points).toEqual([]);
    expect(forecast.compare).toEqual([]);
    expect(forecast.errorKind).toBe(comparisonFailure ? undefined : "no-eligible-vintage");
    expect(forecast.error).toContain(
      comparisonFailure ? "comparison unavailable" : "No eligible archived forecast",
    );
  });
}

for (const variant of [
  "wrong-unit",
  "wrong-duration",
  "invalid-issue",
  "nonnumeric",
  "left-touching",
] as const) {
  it(`empty selected forecast retains source validity for ${variant}`, async () => {
    const row = {
      target_ts: 3600,
      interval_start: 0,
      interval_end: 3600,
      issued_at: -7200,
      value: 42 as number | string,
      unit: "MW",
    };
    if (variant === "wrong-unit") row.unit = "GW";
    if (variant === "wrong-duration") row.interval_start = 300;
    if (variant === "invalid-issue") row.issued_at = 1;
    if (variant === "nonnumeric") row.value = "NaN";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("historical-forecast")
                ? { product_id: "NP3-565-CD", policy: "issued_before_delivery", rows: [row] }
                : { series: [] },
            ),
          ),
      ),
    );
    const result = await loadSeries(
      [chartDefinitions.find((chart) => chart.id === "supply-demand")!],
      { start: 3600, end: 7200, mode: "live", paused: false, rangeSeconds: 3600 },
      "none",
      0,
      new AbortController().signal,
    );
    const forecast = result.get("supply-demand:forecast-demand")!;
    expect(forecast.points).toEqual([]);
    expect(forecast.errorKind).toBe(
      variant === "left-touching" ? "no-eligible-vintage" : undefined,
    );
    expect(forecast.error).not.toBeNull();
  });
}

it("normal receiver null-value archive is successful missingness with no invented zero", async () => {
  expect(missingHour.response.rows[0]!.value).toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("historical-forecast") ? missingHour.response : { series: [] },
          ),
        ),
    ),
  );
  const result = await loadSeries(
    [chartDefinitions.find((chart) => chart.id === "supply-demand")!],
    { ...missingHour.selected_time, mode: "live" },
    "none",
    0,
    new AbortController().signal,
  );
  const loaded = result.get("supply-demand:forecast-demand")!;
  expect(loaded.points).toEqual([]);
  expect(loaded.errorKind).toBe("missing-forecast-values");
  expect(loaded.error).toBe("Archived pre-delivery forecast has missing reported values");
  expect(missingHour.response.coverage.available_value_count).toBe(0);
  expect(missingHour.response.coverage.selected_target_count).toBe(1);
});

it("a valid missing-value current archive cannot hide a comparison transport failure", async () => {
  let selections = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("historical-forecast")) return new Response(JSON.stringify({ series: [] }));
      selections += 1;
      return selections === 1
        ? new Response(JSON.stringify(missingHour.response))
        : new Response("upstream unavailable", { status: 503 });
    }),
  );
  const result = await loadSeries(
    [chartDefinitions.find((chart) => chart.id === "supply-demand")!],
    { ...missingHour.selected_time, mode: "live" },
    "previous_period",
    0,
    new AbortController().signal,
  );
  const loaded = result.get("supply-demand:forecast-demand")!;
  expect(loaded.points).toEqual([]);
  expect(loaded.errorKind).toBeUndefined();
  expect(loaded.error).toContain("comparison unavailable");
});

for (const field of ["unit", "interval_start", "issued_at"] as const) {
  it(`null source value cannot excuse malformed ${field}`, async () => {
    const row = {
      ...missingHour.response.rows[0]!,
      [field]: field === "unit" ? "GW" : missingHour.selected_time.end + 1,
    };
    const payload = { ...missingHour.response, rows: [row] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(url.includes("historical-forecast") ? payload : { series: [] }),
          ),
      ),
    );
    const result = await loadSeries(
      [chartDefinitions.find((chart) => chart.id === "supply-demand")!],
      { ...missingHour.selected_time, mode: "live" },
      "none",
      0,
      new AbortController().signal,
    );
    const loaded = result.get("supply-demand:forecast-demand")!;
    expect(loaded.points).toEqual([]);
    expect(loaded.errorKind).toBeUndefined();
    expect(loaded.error).not.toBeNull();
  });
}
