import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("PERF-02 separate production receiver query and browser costs", async ({ browser }) => {
  const origin = process.env.PERFORMANCE_RECEIVER_ORIGIN;
  test.skip(
    !origin,
    "Start scripts/serve_performance_receiver.py and set PERFORMANCE_RECEIVER_ORIGIN",
  );
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: "America/Chicago",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const requests: { url: string; duration: number; bytes: number; status: number }[] = [];
  const starts = new Map<string, number>();
  const responses = new Map<string, { url: string; status: number }>();
  cdp.on("Network.requestWillBeSent", ({ requestId, timestamp }) =>
    starts.set(requestId, timestamp),
  );
  cdp.on("Network.responseReceived", ({ requestId, response }) =>
    responses.set(requestId, { url: response.url, status: response.status }),
  );
  cdp.on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) => {
    const response = responses.get(requestId);
    if (response)
      requests.push({
        ...response,
        duration: (timestamp - (starts.get(requestId) ?? timestamp)) * 1000,
        bytes: encodedDataLength,
      });
  });
  const fixture = await (await page.request.get(`${origin}/performance-fixture.json`)).json();
  const end = fixture.end as number;
  await page.clock.setFixedTime(new Date((end + 1) * 1000));
  const start = performance.now();
  await page.goto(`${origin}/?range=86400&live=1`);
  await page.waitForFunction(() => {
    const balance = document.querySelector('[data-chart-id="supply-demand"]');
    const headroom = document.querySelector('[data-chart-id="overview-headroom"]');
    return (
      balance?.querySelector('canvas[data-chart-ready="true"]') &&
      headroom?.querySelector('canvas[data-chart-ready="true"]') &&
      balance.textContent?.includes("71.0 GW") &&
      balance.textContent.includes("90.1 GW") &&
      headroom.textContent?.includes("19.1 GW")
    );
  });
  const firstUsefulMs = performance.now() - start;
  const coldMetrics = await cdp.send("Performance.getMetrics");
  const rangeEvidence = [];
  for (const seconds of [21600, 86400, 604800, 2592000, 7776000, 31536000]) {
    const before = performance.now();
    const result = await page.request.get(
      `${origin}/api/series?metric=ercot.supply_demand.demand_mw&since=${end - seconds}&until=${end}&bucket_seconds=${seconds > 86400 ? 3600 : 300}&max_points=1200&aggregation=minmax`,
    );
    expect(result.ok()).toBe(true);
    const body = await result.json();
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.points.length).toBeLessThanOrEqual(1200);
    expect(body.meta.stats.count).toBeGreaterThanOrEqual(Math.floor(seconds / 300) - 2);
    expect(body.meta.stats.minimum).toBeLessThan(69025);
    expect(body.meta.stats.maximum).toBeGreaterThan(72975);
    rangeEvidence.push({
      seconds,
      requestAndParseMs: performance.now() - before,
      bytes: (await result.body()).length,
      points: body.points.length,
      sourceObservations: body.meta.stats.count,
      minimum: body.meta.stats.minimum,
      maximum: body.meta.stats.maximum,
    });
  }
  await mkdir("artifacts/post-release", { recursive: true });
  await writeFile(
    "artifacts/post-release/performance-receiver.json",
    JSON.stringify(
      {
        conditions:
          "Real disposable SQLite receiver; production assets; unthrottled loopback; no route fulfillment; separate from controlled numeric contract",
        fixture,
        browser: browser.version(),
        firstUsefulMs,
        coldMetrics,
        requests,
        rangeEvidence,
      },
      null,
      2,
    ) + "\n",
  );
  await context.close();
});
