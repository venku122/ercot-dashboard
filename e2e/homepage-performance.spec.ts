import { expect, test } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { observeHistory, selectedPairedTileProof } from "./performance-observations";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";
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
    const history = observeHistory(page, true);
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
        const expected = (
          window as Window & {
            __performanceExpectedReadings?: { demand: string; capacity: string; headroom: string };
          }
        ).__performanceExpectedReadings;
        const outlook = document.querySelector('[aria-label="Current next 24 hour Outlook"]');
        // Older baseline has no inline widget. The same predicate on both heads
        // includes actual populated SVG geometry whenever the widget exists.
        const outlookReady =
          !outlook ||
          (outlook.querySelector(
            'svg[aria-label^="Next 24 hour demand forecast"] polyline, svg[aria-label^="Next 24 hour demand forecast"] circle',
          ) &&
            ["ready", "partial", "stale"].includes(
              outlook.getAttribute("data-outlook-state") ?? "",
            ));
        return (
          expected &&
          expected.demand !== "—" &&
          expected.capacity !== "—" &&
          expected.headroom !== "—" &&
          outlookReady &&
          ready(balance) &&
          ready(headroom) &&
          balance?.textContent?.includes(expected.demand) &&
          balance?.textContent?.includes(expected.capacity) &&
          headroom?.textContent?.includes(expected.headroom)
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

    await history.settled();
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const history = observeHistory(page);
  await page.goto(`${baseURL}/?range=86400&live=1`);
  await expect(page.locator(`[data-chart-id="storage"] canvas`)).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  await expect(page.locator('[data-chart-id="overview-headroom"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  const inlineOutlook = page.getByRole("region", {
    name: "Current next 24 hour Outlook",
    exact: true,
  });
  if (await inlineOutlook.count())
    await expect(
      inlineOutlook.locator('svg[aria-label^="Next 24 hour demand forecast"]'),
    ).toBeVisible();
  await history.settled();
  const before = history.requests.length;
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
        if (
          values &&
          values.split("|").length >= 2 &&
          values.split("|").every((value) => value !== "—" && value !== "")
        ) {
          if (values !== previousValues) {
            samples.push(elapsed);
            readoutChanges += 1;
          }
          previousValues = values;
        }
      }
      return { samples, readoutChanges, attempts };
    });
  expect(samples.readoutChanges).toBeGreaterThanOrEqual(200);
  const balanceCard = page.locator('[data-chart-id="supply-demand"]');
  const demandToggle = balanceCard.getByRole("button", { name: "Actual demand", exact: true });
  await demandToggle.click();
  await expect(demandToggle).toHaveAttribute("aria-pressed", "true");
  await expect(
    balanceCard.getByRole("button", { name: "Available capacity", exact: true }),
  ).toHaveClass(/legend-row-hidden/);
  await demandToggle.click();
  await expect(
    balanceCard.getByRole("button", { name: "Available capacity", exact: true }),
  ).not.toHaveClass(/legend-row-hidden/);
  await history.settled();
  const budget = evaluatePerformanceBudget({
    coldMs,
    pointerMs: samples.samples,
    readoutChanges: samples.readoutChanges,
    hoverHistoryRequests: history.requests.length - before,
  });
  const fixtureFiles: Record<string, string | null> = {};
  const fixtureHasher = createHash("sha256");
  for (const path of [
    "e2e/mobile-fixtures.ts",
    "e2e/paired-headroom-fixtures.ts",
    "e2e/archived-forecast-fixtures.ts",
    "e2e/market-geography-fixtures.ts",
  ]) {
    const content = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    fixtureFiles[path] = content ? createHash("sha256").update(content).digest("hex") : null;
    fixtureHasher.update(path).update(content ?? "ABSENT");
  }
  const result = {
    candidateSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    fixtureHash: fixtureHasher.digest("hex"),
    fixtureFiles,
    readiness:
      "populated demand/capacity and headroom with consistent epoch-source response values; populated inline next24 SVG (including truthful partial) when present; baseline lacks widget",
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
    hoverHistoryRequests: history.requests.length - before,
    interactionHistoryRequests: history.requests.slice(before),
  };
  await writeFile(
    `artifacts/post-release/performance${baseline ? "-baseline" : ""}.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, profiles: undefined, pointerMs: undefined }));
  expect(
    history.requests.slice(before),
    "all GET/POST history requests during 200 changed readouts and solo/restore",
  ).toEqual([]);
  if (process.env.PERFORMANCE_REPORT_ONLY !== "1") expect(budget.failures).toEqual([]);
  await context.close();
});

for (const seconds of [21600, 86400, 604800, 2592000, 7776000, 31536000]) {
  test(`PERF-03 populated balance survives ${seconds}s bounded range`, async ({ page }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    test.setTimeout(120_000);
    const history = observeHistory(page);
    const expectsPaired = (
      await readFile("frontend/src/dashboard/homepage-model.ts", "utf8")
    ).includes("HEADROOM_METRIC");
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
    const headroom = page.locator('[data-chart-id="overview-headroom"]');
    await expect(headroom.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    if (expectsPaired || seconds <= 86400) {
      await expect(
        headroom
          .getByRole("button", { name: "Derived headroom", exact: true })
          .locator(".legend-latest"),
      ).toContainText("GW");
    } else {
      await expect(headroom).toContainText("Headroom unavailable at this resolution");
    }
    await history.settled();
    const proof = selectedPairedTileProof(
      history.tiles.values(),
      FIXED_NOW_SECONDS - seconds,
      FIXED_NOW_SECONDS,
    );
    if (expectsPaired) {
      expect(
        proof.count,
        "actual source pairs across selected native edges and coarse interiors",
      ).toBe(seconds / 300 + 1);
      await expect(headroom.locator("..")).toContainText(`${proof.count} paired observations`);
      const downloaded = page.waitForEvent("download");
      await headroom.getByLabel("Capacity headroom & PRC chart menu", { exact: true }).click();
      await headroom.getByRole("menuitem", { name: "Download CSV" }).click();
      const stream = await (await downloaded).createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const rows = Buffer.concat(chunks)
        .toString("utf8")
        .trim()
        .split("\n")
        .slice(1)
        .filter((row) => row.startsWith('"Derived headroom",'))
        .map((row) => {
          const fields = row.split(",");
          return [Number(fields[2]), Number(fields[3])] as [number, number];
        });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length, "canonical CSV retains distinct first/last/min/max vertices").toBe(
        proof.requiredPoints.size,
      );
      expect(rows.length).toBeLessThanOrEqual(proof.maximumVertices);
      expect(new Set(rows.map(([epoch]) => epoch)).size).toBe(rows.length);
      const values = new Map(rows);
      for (const [epoch, value] of proof.requiredPoints)
        expect(values.get(epoch), `CSV retains source extremum at ${epoch}`).toBe(value);
      expect(Math.min(...rows.map(([, value]) => value))).toBe(proof.minimum);
      expect(Math.max(...rows.map(([, value]) => value))).toBe(proof.maximum);
      test.info().annotations.push({
        type: "paired-envelope",
        description: `${proof.count} native pairs; ${rows.length} real vertices; bound ${proof.maximumVertices}`,
      });
    } else {
      expect(proof.count).toBe(0);
      test.info().annotations.push({
        type: "legacy-headroom",
        description:
          "This head derives headroom locally; does not validate final paired implementation.",
      });
    }
  });
}
