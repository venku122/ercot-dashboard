import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

test("default physical catalog preserves native families and opt-in paired identity", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.goto("/");
  const catalog = await page.evaluate(async () => (await fetch("/api/v2/tile-catalog")).json());
  const keys = catalog.series.map((row: { key: string }) => row.key);
  expect(keys).toEqual([...keys].sort());
  for (const key of [
    "frequency.system",
    "storage.charging",
    "storage.discharging",
    "fuel-mix.wind",
    "fuel-mix.solar",
    "pricing.houston",
    "supply-demand.forecast-demand",
  ])
    expect(keys, key).toContain(key);
  expect(keys).not.toContain("supply-demand.paired-headroom");
  const included = await page.evaluate(async () =>
    (await fetch("/api/v2/tile-catalog?include=paired-headroom")).json(),
  );
  expect(included.series.map((row: { key: string }) => row.key)).toEqual([
    ...keys,
    "supply-demand.paired-headroom",
  ]);
  const start = FIXED_NOW_SECONDS - 3600;
  const body = await page.evaluate(
    async (start) => (await fetch(`/api/v2/tiles/frequency.system/1h/${start}/native`)).json(),
    start,
  );
  expect(body.native_interval_seconds).toBe(60);
  expect(body.buckets).toHaveLength(60);
  expect(body.buckets[1].state.first_ts - body.buckets[0].state.first_ts).toBe(60);
});

test("mobile fixed fallback honors exact minmax chunk context and rejects unknown sources", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ start, end }) => {
      const params = new URLSearchParams({
        aggregation: "minmax",
        metric: "ercot.Frequency.Instantaneous_Time_Error",
        start: String(start),
        end: String(end),
        resolution: "900",
        chunk_seconds: "3600",
      });
      const response = await fetch(`/api/v1/series/chunk?${params}`);
      return { status: response.status, body: await response.json() };
    },
    { start: FIXED_NOW_SECONDS - 3600, end: FIXED_NOW_SECONDS },
  );
  expect(result.status).toBe(200);
  expect(result.body.aggregation).toBe("minmax");
  expect(result.body.start).toBe(FIXED_NOW_SECONDS - 3600);
  expect(result.body.end).toBe(FIXED_NOW_SECONDS);
  expect(result.body.resolution).toBe(900);
  expect(result.body.points.length).toBeGreaterThan(0);
  expect(result.body.points.length).toBeLessThanOrEqual(8);
  expect(
    result.body.points.every(
      ([ts]: [number, number]) => ts >= result.body.start && ts < result.body.end,
    ),
  ).toBe(true);
  const bad = await page.evaluate(
    async () =>
      (
        await fetch(
          "/api/v1/series/chunk?aggregation=minmax&metric=made.up&start=0&end=3600&resolution=900&chunk_seconds=3600",
        )
      ).status,
  );
  expect(bad).toBe(400);
});

test("minute frequency and hourly future forecast share raw batch/tile epochs", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/");
  const frequency = "ercot.Frequency.Current_Frequency",
    forecast = "ercot.supply_demand.forecast_demand_mw";
  const result = await page.evaluate(
    async ({ now, frequency, forecast }) => {
      const batch = await (
        await fetch("/api/series/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            queries: [
              {
                id: "minute",
                metric: frequency,
                tags: [],
                since: now - 3600,
                until: now,
                max_points: 0,
              },
              {
                id: "future",
                metric: forecast,
                tags: ["source:supply_demand"],
                since: now,
                until: now + 7200,
                max_points: 0,
              },
            ],
          }),
        })
      ).json();
      const minute = await (
        await fetch(`/api/v2/tiles/frequency.system/1h/${now - 3600}/native`)
      ).json();
      const future = await (
        await fetch(`/api/v2/tiles/supply-demand.forecast-demand/1h/${now + 3600}/native`)
      ).json();
      return { batch, minute, future };
    },
    { now: FIXED_NOW_SECONDS, frequency, forecast },
  );
  expect(result.batch.series[0].points.length).toBe(61);
  expect(result.batch.series[0].meta.native_interval_seconds).toBe(60);
  expect(
    result.minute.buckets.map((bucket: { state: { first_ts: number; first_value: number } }) => [
      bucket.state.first_ts,
      bucket.state.first_value,
    ]),
  ).toEqual(result.batch.series[0].points.slice(0, -1));
  expect(result.batch.series[1].points.map(([ts]: [number, number]) => ts)).toEqual([
    FIXED_NOW_SECONDS,
    FIXED_NOW_SECONDS + 3600,
    FIXED_NOW_SECONDS + 7200,
  ]);
  expect(result.future.native_interval_seconds).toBe(3600);
  expect(result.future.buckets).toHaveLength(1);
  expect([
    result.future.buckets[0].state.first_ts,
    result.future.buckets[0].state.first_value,
  ]).toEqual(result.batch.series[1].points[1]);
});

for (const seconds of [21600, 86400, 604800])
  test(`fixed physical ${seconds}s has populated core consumers without unhandled history`, async ({
    page,
  }) => {
    const failures: string[] = [],
      fallbackBodies: Array<{ aggregation: string; metric: string; points: unknown[] }> = [];
    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/")) failures.push(request.url());
    });
    page.on("response", (response) => {
      if (response.url().includes("/api/v1/series/chunk") && response.ok())
        void response.json().then((body) => fallbackBodies.push(body));
    });
    await installMobileApi(page);
    const end = FIXED_NOW_SECONDS - 3600;
    await page.goto(
      `/?range=${seconds}&live=0&from=${end - seconds}&to=${end}&compare=previous_period`,
    );
    for (const id of [
      "supply-demand",
      "overview-headroom",
      "fuel-mix",
      "storage",
      "pricing-collection",
      "frequency",
    ]) {
      const card = page.locator(`[data-chart-id="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
      await expect(card).not.toContainText("No observations");
    }
    await expect(page.locator('[data-chart-id="pricing"] canvas')).toHaveCount(0);
    await expect(page.locator('[data-chart-id="pricing-collection"]')).toContainText(
      "Delivery interval unknown",
    );
    expect(failures).toEqual([]);
    for (const body of fallbackBodies)
      expect([
        "ercot.supply_demand.demand_mw",
        "ercot.supply_demand.available_capacity_mw",
        "ercot.supply_demand.forecast_demand_mw",
        "ercot.fuel_mix.generation_mw",
        "ercot.storage.charging_mw",
        "ercot.storage.discharging_mw",
        "ercot.storage.net_output_mw",
        "ercot.Frequency.Current_Frequency",
        "ercot.pricing",
      ]).not.toContain(body.metric);
    for (const body of fallbackBodies)
      expect(
        body.points.length,
        `explicit fixture fallback ${body.metric}/${body.aggregation}`,
      ).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(
      page
        .locator('[data-chart-id="supply-demand"]')
        .getByRole("button", { name: "Forecast issued before delivery", exact: true })
        .locator(".legend-latest"),
    ).toContainText("GW");
  });

test("native power energy uses every signed raw interval and nonpower has no MWh", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/");
  const result = await page.evaluate(async (now) => {
    const metrics = [
      "ercot.storage.charging_mw",
      "ercot.storage.discharging_mw",
      "ercot.storage.net_output_mw",
      "ercot.Frequency.Current_Frequency",
      "ercot.pricing",
    ];
    const queries = metrics.flatMap((metric, i) =>
      [0, 4].map((max_points) => ({
        id: `${i}/${max_points}`,
        metric,
        tags: metric.startsWith("ercot.storage")
          ? ["source:energy_storage"]
          : metric === "ercot.pricing"
            ? ["ercot_region:HB_HOUSTON"]
            : [],
        since: now - 3600,
        until: now,
        max_points,
        aggregation: "minmax",
      })),
    );
    return (
      await fetch("/api/series/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries }),
      })
    ).json();
  }, FIXED_NOW_SECONDS);
  for (let i = 0; i < 3; i++) {
    const raw = result.series[i * 2],
      bounded = result.series[i * 2 + 1];
    const area = raw.points
      .slice(1)
      .reduce(
        (sum: number, point: [number, number], index: number) =>
          sum +
          (((raw.points[index][1] + point[1]) / 2) * (point[0] - raw.points[index][0])) / 3600,
        0,
      );
    expect(
      raw.meta.stats.energy_mwh,
      "receiver trapezoidal area over complete raw observations",
    ).toBeCloseTo(area, 10);
    expect(bounded.meta.stats.energy_mwh).toBeCloseTo(area, 10);
    expect(bounded.meta.stats.count).toBe(raw.points.length);
  }
  expect(result.series[0].meta.stats.energy_mwh).toBeLessThan(0);
  expect(result.series[2].meta.stats.energy_mwh).toBeGreaterThan(0);
  expect(result.series[4].meta.stats.energy_mwh).toBeCloseTo(
    result.series[0].meta.stats.energy_mwh + result.series[2].meta.stats.energy_mwh,
    10,
  );
  for (const series of result.series.slice(6))
    expect(series.meta.stats).not.toHaveProperty("energy_mwh");
  const pair = await page.evaluate(
    async (now) =>
      (await fetch(`/api/v2/tiles/supply-demand.paired-headroom/1h/${now - 3600}/native`)).json(),
    FIXED_NOW_SECONDS,
  );
  expect(JSON.stringify(pair)).not.toContain('"energy_mwh"');
});

for (const days of [90, 365]) {
  test(`native ${days}d frequency and storage preserve full raw statistics without argument overflow`, async ({
    page,
  }) => {
    test.setTimeout(15000);
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.goto("/");
    const results = await page.evaluate(
      async ({ now, days }) => {
        const response = await fetch("/api/series/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            queries: [
              {
                id: "frequency",
                metric: "ercot.Frequency.Current_Frequency",
                tags: [],
                since: now - days * 86400,
                until: now,
                max_points: 1200,
                aggregation: "minmax",
              },
              {
                id: "charging",
                metric: "ercot.storage.charging_mw",
                tags: [],
                since: now - days * 86400,
                until: now,
                max_points: 1200,
                aggregation: "minmax",
              },
            ],
          }),
        });
        return (await response.json()).series;
      },
      { now: FIXED_NOW_SECONDS, days },
    );
    for (const [index, cadence] of [60, 300].entries()) {
      let sum = 0,
        minimum = Infinity,
        maximum = -Infinity,
        area = 0,
        previous: number | undefined;
      const count = (days * 86400) / cadence + 1;
      for (let slot = 0; slot < count; slot++) {
        const ts = FIXED_NOW_SECONDS - days * 86400 + slot * cadence;
        const nativeIndex =
          63 + (ts - Math.floor((FIXED_NOW_SECONDS - 30) / cadence) * cadence) / cadence;
        const wave = Math.sin(nativeIndex / 5),
          value = index === 0 ? 60.001 + wave * 0.018 : -900 - wave * 500;
        sum += value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
        if (previous !== undefined) area += (((previous + value) / 2) * cadence) / 3600;
        previous = value;
      }
      const series = results[index];
      expect(series.points.length).toBeLessThanOrEqual(1200);
      expect(series.meta.stats.count).toBe(count);
      expect(series.meta.stats.average).toBeCloseTo(sum / count, 10);
      expect(series.meta.stats.minimum).toBe(minimum);
      expect(series.meta.stats.maximum).toBe(maximum);
      expect(series.meta.stats.latest).toBe(previous);
      if (index === 0) expect(series.meta.stats).not.toHaveProperty("energy_mwh");
      else expect(series.meta.stats.energy_mwh).toBeCloseTo(area, 6);
    }
  });
}
