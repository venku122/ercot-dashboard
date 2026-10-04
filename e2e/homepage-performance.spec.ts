import { expect, test } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { installMobileApi } from "./mobile-fixtures";
import { evaluatePerformanceBudget } from "./performance-budget";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

test("PERF-01 production homepage cold-load and cursor evidence", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const baseline = process.env.HOME_PERFORMANCE_BASELINE === "1";
  await mkdir("artifacts/post-release", { recursive: true });
  const coldMs: number[] = [];
  const profiles: unknown[] = [];
  for (let run = 0; run < 5; run++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      timezoneId: "America/Chicago",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable");
    const transfers: Record<string, unknown>[] = [];
    const responses = new Map<string, Record<string, unknown>>();
    cdp.on("Network.responseReceived", ({ requestId, response }) =>
      responses.set(requestId, {
        url: response.url.split(baseURL!).at(-1),
        timing: response.timing,
      }),
    );
    cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) =>
      transfers.push({ ...responses.get(requestId), encodedDataLength }),
    );
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 100_000,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.addInitScript(() => {
      const tasks: number[] = [];
      new PerformanceObserver((list) =>
        tasks.push(...list.getEntries().map((entry) => entry.duration)),
      ).observe({ type: "longtask", buffered: true });
      Object.assign(window, { __performanceLongTasks: tasks });
    });
    const start = performance.now();
    await page.goto(`${baseURL}/?range=86400&live=1`);
    // One predicate observes the same populated correctness contract without
    // accumulating five sequential protocol assertion round trips.
    await page.waitForFunction(
      () => {
        const balance = document.querySelector('[data-chart-id="supply-demand"]');
        const headroom = document.querySelector('[data-chart-id="overview-headroom"]');
        const ready = (card: Element | null) =>
          card?.querySelector('canvas[data-chart-ready="true"]');
        return (
          ready(balance) &&
          ready(headroom) &&
          balance?.textContent?.includes("71.0 GW") &&
          balance?.textContent?.includes("90.1 GW") &&
          headroom?.textContent?.includes("19.1 GW")
        );
      },
      undefined,
      { polling: 20 },
    );
    coldMs.push(performance.now() - start);
    profiles.push({
      network: transfers,
      metrics: await cdp.send("Performance.getMetrics"),
      page: await page.evaluate(() => ({
        resources: performance.getEntriesByType("resource").map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            name: resource.name.split(location.origin).at(-1),
            duration: resource.duration,
            transferSize: resource.transferSize,
            encodedBodySize: resource.encodedBodySize,
          };
        }),
        longTasks: (window as unknown as { __performanceLongTasks: number[] })
          .__performanceLongTasks,
        heap:
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
      })),
    });

    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests, { nativeCadence: true });
  await page.goto(`${baseURL}/?range=86400&live=1`);
  await expect(page.locator(`[data-chart-id="storage"] canvas`)).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  const before = requests.length;
  const samples = await page
    .locator('[data-chart-id="supply-demand"] canvas')
    .evaluate(async (element) => {
      const samples: number[] = [];
      let readoutChanges = 0;
      let previousValues = "";
      let attempts = 0;
      const bounds = element.getBoundingClientRect();
      for (let i = 0; i < 1000 && samples.length < 200; i++) {
        const start = performance.now();
        element.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerType: "mouse",
            bubbles: true,
            clientX: bounds.left + 80 + (i % 250) * Math.max(1, (bounds.width - 180) / 249),
            clientY: bounds.top + 100,
          }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const elapsed = performance.now() - start;
        attempts += 1;
        const values = [
          ...document.querySelectorAll(
            '[data-chart-id="supply-demand"] .legend-latest[data-value-scope="cursor"]',
          ),
        ]
          .map((node) => node.textContent)
          .join("|");
        if (values && !values.split("|").every((value) => value === "—")) {
          if (values !== previousValues) {
            samples.push(elapsed);
            readoutChanges += 1;
          }
          previousValues = values;
        }
      }
      return { samples, readoutChanges, attempts };
    });
  expect(requests.length).toBe(before);
  const budget = evaluatePerformanceBudget({
    coldMs,
    pointerMs: samples.samples,
    readoutChanges: samples.readoutChanges,
    hoverHistoryRequests: requests.length - before,
  });
  const result = {
    candidateSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    fixtureHash: createHash("sha256")
      .update(await readFile("e2e/mobile-fixtures.ts"))
      .digest("hex"),
    readiness:
      "both populated demand/capacity balance and paired headroom; expected native fixture last values 71.0/90.1/19.1 GW",
    profiles,
    numericBudget: budget,
    browser: browser.version(),
    viewport: "1440x900",
    dpr: 1,
    build: "production vite preview",
    coldConditions:
      "4x CPU, 1.6 Mb/s, 150ms network latency; API route-fulfilled deterministic native-cadence fixture",
    coldMs,
    coldMedianMs: [...coldMs].sort((a, b) => a - b)[2],
    pointerConditions:
      "unthrottled, event through two animation frames (conservative proxy; not a paint timestamp)",
    pointerSamples: samples.samples.length,
    pointerMs: samples.samples,
    readoutChanges: samples.readoutChanges,
    pointerAttempts: samples.attempts,
    pointerP95Ms: [...samples.samples].sort((a, b) => a - b)[189],
    hoverHistoryRequests: requests.length - before,
  };
  await writeFile(
    `artifacts/post-release/performance${baseline ? "-baseline" : ""}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, profiles: undefined, pointerMs: undefined }));
  if (process.env.PERFORMANCE_REPORT_ONLY !== "1") expect(budget.failures).toEqual([]);
  await context.close();
});

for (const seconds of [21600, 86400, 604800, 2592000, 7776000, 31536000]) {
  test(`PERF-03 populated balance survives ${seconds}s bounded range`, async ({ page }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.goto(`/?range=${seconds}&live=1`);
    const card = page.locator('[data-chart-id="supply-demand"]');
    await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await expect(
      card.locator(".legend-row").filter({ hasText: "Actual demand" }).locator(".legend-latest"),
    ).toContainText("GW");
    await expect(
      card
        .locator(".legend-row")
        .filter({ hasText: "Available capacity" })
        .locator(".legend-latest"),
    ).toContainText("GW");
    await expect(card.getByRole("button", { name: /inspect/i })).toBeVisible();
  });
}
