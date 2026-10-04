import { afterEach, expect, it, vi } from "vitest";
import { loadSeries } from "./api";
import { chartDefinitions } from "./chart-config";
import { observationAt, temporalPolicy } from "./series-temporal-policy";
afterEach(() => vi.unstubAllGlobals());

it("NP3-565 cursor inside delivery interval must return its hour-ending value", async () => {
  const start = Date.parse("2026-08-18T07:00:00Z") / 1000,
    end = start + 10800;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("historical-forecast")
              ? {
                  product_id: "NP3-565-CD",
                  policy: "issued_before_delivery",
                  rows: [
                    {
                      target_ts: start + 3600,
                      interval_start: start,
                      interval_end: start + 3600,
                      issued_at: start - 7200,
                      value: 11000,
                      unit: "MW",
                    },
                    {
                      target_ts: start + 7200,
                      interval_start: start + 3600,
                      interval_end: start + 7200,
                      issued_at: start - 7200,
                      value: 42000,
                      unit: "MW",
                    },
                  ],
                }
              : { series: [] },
          ),
        ),
    ),
  );
  const chart = chartDefinitions.find((c) => c.id === "supply-demand")!;
  const result = await loadSeries(
    [chart],
    { mode: "live", paused: false, start, end, rangeSeconds: 10800 },
    "none",
    0,
    new AbortController().signal,
  );
  const loaded = result.get("supply-demand:forecast-demand")!;
  const policy = temporalPolicy(chart.id, chart.series.find((s) => s.id === "forecast-demand")!);
  const at = start + 5400;
  const observed = observationAt(loaded, at, policy);
  console.log(
    JSON.stringify({
      at: new Date(at * 1000).toISOString(),
      points: loaded.points,
      intervals: loaded.meta.intervals ?? null,
      policy,
      observed,
      expected: 42000,
    }),
  );
  expect(observed?.value).toBe(42000);
  expect(loaded.points).toEqual([
    [start + 3600, 11000],
    [start + 7200, 42000],
  ]);
  expect(observationAt(loaded, start, policy)?.value).toBe(11000);
  expect(observationAt(loaded, start + 3600, policy)?.value).toBe(42000);
  expect(observationAt(loaded, start + 7200, policy)).toBeNull();
  expect(observationAt(loaded, start - 1, policy)).toBeNull();
});

it("retains real closing epochs for delivery intervals crossing partial window edges", async () => {
  const hour = Date.parse("2026-08-18T08:00:00Z") / 1000;
  const start = hour + 900,
    end = hour + 1800;
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("historical-forecast")) return new Response(JSON.stringify({ series: [] }));
      requests.push(new URL(url, "http://localhost"));
      return new Response(
        JSON.stringify({
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          rows: [
            {
              target_ts: hour + 3600,
              interval_start: hour,
              interval_end: hour + 3600,
              issued_at: hour - 3600,
              value: 42000,
              unit: "MW",
            },
          ],
        }),
      );
    }),
  );
  const chart = chartDefinitions.find((item) => item.id === "supply-demand")!;
  const data = (
    await loadSeries(
      [chart],
      { start, end, rangeSeconds: end - start, mode: "live", paused: false },
      "none",
      0,
      new AbortController().signal,
    )
  ).get("supply-demand:forecast-demand")!;
  expect(Number(requests[0]!.searchParams.get("end"))).toBe(hour + 3601);
  expect(Number(requests[0]!.searchParams.get("as_of"))).toBe(end);
  expect(data.points).toEqual([[hour + 3600, 42000]]);
  const policy = temporalPolicy(
    chart.id,
    chart.series.find((item) => item.id === "forecast-demand")!,
  );
  expect(observationAt(data, start, policy)?.value).toBe(42000);
  expect(observationAt(data, end, policy)?.value).toBe(42000);
});

it("aligns comparison delivery bounds from its own source window", async () => {
  const hour = Date.parse("2026-11-01T08:00:00Z") / 1000;
  const chart = chartDefinitions.find((item) => item.id === "supply-demand")!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("historical-forecast")) return new Response(JSON.stringify({ series: [] }));
      const request = new URL(url, "http://localhost");
      const ending = Number(request.searchParams.get("end")) - 1;
      return new Response(
        JSON.stringify({
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          rows: [
            {
              target_ts: ending,
              interval_start: ending - 3600,
              interval_end: ending,
              issued_at: ending - 7200,
              value: ending === hour ? 42000 : 24000,
              unit: "MW",
            },
          ],
        }),
      );
    }),
  );
  const data = (
    await loadSeries(
      [chart],
      { start: hour - 3600, end: hour, rangeSeconds: 3600, mode: "live", paused: false },
      "day",
      0,
      new AbortController().signal,
    )
  ).get("supply-demand:forecast-demand")!;
  expect(data.meta.comparison_intervals).toEqual([
    { timestamp: hour, start: hour - 3600, end: hour },
  ]);
  const prior = {
    ...data,
    points: data.compare,
    meta: { ...data.meta, intervals: data.meta.comparison_intervals ?? [] },
  };
  expect(
    observationAt(
      prior,
      hour - 1800,
      temporalPolicy(chart.id, chart.series.find((item) => item.id === "forecast-demand")!),
    )?.value,
  ).toBe(24000);
});

for (const fractional of [0.4, 0.6]) {
  it(`bounds a fractional 366-day delivery window without advancing cutoff (${fractional})`, async () => {
    const start = Date.parse("2026-08-18T08:00:00Z") / 1000 + fractional;
    const end = start + 366 * 86400;
    let query: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("historical-forecast"))
          return new Response(JSON.stringify({ series: [] }));
        query = new URL(url, "http://localhost");
        const left = Number(query.searchParams.get("start"));
        const right = Number(query.searchParams.get("end"));
        const expected = Math.floor((right - 1) / 3600) - Math.ceil(left / 3600) + 1;
        // Real receiver guards independently tested in test_forecast_vintages.py.
        if (right - left > 366 * 86400 + 3600 || expected > 8785)
          return new Response(JSON.stringify({ error: "invalid_historical_forecast" }), {
            status: 400,
          });
        const target = Math.ceil(end / 3600) * 3600;
        return new Response(
          JSON.stringify({
            product_id: "NP3-565-CD",
            policy: "issued_before_delivery",
            rows: [
              {
                target_ts: target,
                interval_start: target - 3600,
                interval_end: target,
                issued_at: Math.floor(end) - 7200,
                value: 42000,
                unit: "MW",
              },
            ],
          }),
        );
      }),
    );
    const definition = chartDefinitions.find((c) => c.id === "supply-demand")!;
    const result = await loadSeries(
      [{ ...definition, series: definition.series.filter((s) => s.id === "forecast-demand") }],
      { mode: "fixed", paused: true, start, end, rangeSeconds: end - start },
      "none",
      0,
      new AbortController().signal,
    );
    expect(result.get("supply-demand:forecast-demand")?.error).toBeNull();
    expect(result.get("supply-demand:forecast-demand")?.points.at(-1)?.[1]).toBe(42000);
    expect(Number(query?.searchParams.get("start"))).toBe(Math.ceil(start));
    expect(Number(query?.searchParams.get("as_of"))).toBe(Math.floor(end));
  });
}
