import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { installMobileApi } from "./mobile-fixtures";

test("PERF-01 production homepage cold-load and cursor evidence", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const baseline = process.env.HOME_PERFORMANCE_BASELINE === "1";
  await mkdir("artifacts/post-release", { recursive: true });
  const coldMs: number[] = [];
  for (let run = 0; run < 5; run++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      timezoneId: "America/Chicago",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 100_000,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    const start = performance.now();
    await page.goto(`${baseURL}/?range=86400&live=1`);
    await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
      "data-chart-ready",
      "true",
    );
    if (!baseline)
      await expect(page.locator('[data-chart-id="overview-headroom"] canvas')).toHaveAttribute(
        "data-chart-ready",
        "true",
      );
    coldMs.push(performance.now() - start);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests, { nativeCadence: true });
  await page.goto(`${baseURL}/?range=86400&live=1`);
  await expect(
    page.locator(`[data-chart-id="${baseline ? "supply-demand" : "storage"}"] canvas`),
  ).toHaveAttribute("data-chart-ready", "true");
  const before = requests.length;
  const samples = await page
    .locator('[data-chart-id="supply-demand"] .chart-canvas-wrap')
    .evaluate(async (element) => {
      const samples: number[] = [];
      const bounds = element.getBoundingClientRect();
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        element.dispatchEvent(
          new MouseEvent("mousemove", {
            bubbles: true,
            clientX: bounds.left + 60 + (i % 150) * 4,
            clientY: bounds.top + 100,
          }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        samples.push(performance.now() - start);
      }
      return samples;
    });
  expect(requests.length).toBe(before);
  const result = {
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
    pointerSamples: samples.length,
    pointerP95Ms: [...samples].sort((a, b) => a - b)[189],
    hoverHistoryRequests: requests.length - before,
  };
  await writeFile(
    `artifacts/post-release/performance${baseline ? "-baseline" : ""}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  await context.close();
});
