import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const coreFailure of [false, true]) {
  test(`cold history queue gives core plots a frame opportunity and continues after coreFailure=${coreFailure}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const trace = {
        frame: 0,
        readyFrame: null as number | null,
        frequency: [] as Array<{ frame: number; readyFrame: number | null; ready: boolean }>,
      };
      (window as unknown as { coldQueueTrace: typeof trace }).coldQueueTrace = trace;
      const coreReady = () =>
        ["supply-demand", "overview-headroom"].every(
          (id) =>
            document
              .querySelector(`[data-chart-id="${id}"] canvas`)
              ?.getAttribute("data-chart-ready") === "true",
        );
      const frames = () => {
        trace.frame += 1;
        requestAnimationFrame(frames);
      };
      requestAnimationFrame(frames);
      new MutationObserver(() => {
        if (trace.readyFrame === null && coreReady()) trace.readyFrame = trace.frame;
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-chart-ready"],
      });
      const original = window.fetch;
      window.fetch = (...args) => {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof URL
              ? args[0].href
              : args[0].url;
        if (url.includes("/api/series/batch") && typeof args[1]?.body === "string") {
          const body = JSON.parse(args[1].body) as { queries: Array<{ id: string }> };
          if (body.queries.some((query) => query.id === "frequency:frequency:current"))
            trace.frequency.push({
              frame: trace.frame,
              readyFrame: trace.readyFrame,
              ready: coreReady(),
            });
        }
        return original(...args);
      };
    });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    let failCore = coreFailure;
    if (coreFailure) {
      await page.route("**/api/v2/tile-catalog**", (route) =>
        failCore
          ? route.fulfill({ status: 503, json: { error: "synthetic_core_source_unavailable" } })
          : route.fallback(),
      );
      await page.route("**/api/v1/historical-forecast**", (route) =>
        failCore
          ? route.fulfill({ status: 503, json: { error: "synthetic_archive_unavailable" } })
          : route.fallback(),
      );
      await page.route("**/api/series/batch", async (route) => {
        const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
        if (
          failCore &&
          body.queries.some(
            (query) =>
              query.id.startsWith("supply-demand:") || query.id.startsWith("capacity-headroom:"),
          )
        ) {
          await route.fulfill({
            status: 503,
            json: { error: "synthetic_core_source_unavailable" },
          });
        } else await route.fallback();
      });
    }
    await page.goto("/?range=86400&live=1");
    await expect(
      page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "Frequency" }),
    ).toContainText("Hz");
    const observed = await page.evaluate(
      () =>
        (
          window as unknown as {
            coldQueueTrace: {
              frequency: Array<{ frame: number; readyFrame: number | null; ready: boolean }>;
            };
          }
        ).coldQueueTrace.frequency,
    );
    await test.info().attach("actual-frequency-fetch-start", {
      body: JSON.stringify(observed, null, 2),
      contentType: "application/json",
    });
    expect(observed).toHaveLength(1);
    if (!coreFailure) {
      expect(observed[0]!.ready).toBe(true);
      expect(observed[0]!.readyFrame).not.toBeNull();
      expect(observed[0]!.frame - observed[0]!.readyFrame!).toBeGreaterThanOrEqual(1);
    } else {
      const core = page.locator('[data-chart-id="supply-demand"]');
      await expect(core).toContainText("Temporarily unavailable");
      await expect(core).not.toContainText("Waiting for first sample");
      const frequency = page.locator('[data-chart-id="frequency"]');
      await frequency.scrollIntoViewIfNeeded();
      await expect(frequency).toHaveAttribute("aria-busy", "false");
      await expect(frequency.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      await expect(frequency).not.toContainText("Temporarily unavailable");
      failCore = false;
      await page.getByLabel("Active grid alerts").locator("summary").click();
      await page.getByRole("button", { name: "Retry data", exact: true }).click();
      await expect(core.locator(".legend-latest").first()).toContainText("GW");
      await expect(core).not.toContainText("Temporarily unavailable");
      await expect(core).not.toContainText("Waiting for first sample");
    }
  });
}

test("leaving cold Overview cancels its deferred frequency cohort while the next view progresses", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const frequency: string[] = [];
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (body.queries.some((query) => query.id === "supply-demand:available-capacity:current")) {
      started();
      await gate;
    }
    await route.fallback();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/series/batch") return;
    const body = request.postDataJSON() as { queries: Array<{ id: string }> };
    if (body.queries.some((query) => query.id === "frequency:frequency:current"))
      frequency.push(request.url());
  });
  try {
    await page.goto("/?range=86400&live=1");
    await pending;
    await page.getByRole("button", { name: "Generation view", exact: true }).click();
    release();
    await expect(page.locator('[data-chart-id="fuel-mix"] canvas')).toHaveAttribute(
      "data-chart-ready",
      "true",
    );
    await expect(page.locator('[data-chart-id="fuel-mix"]')).toHaveAttribute("aria-busy", "false");
    expect(frequency).toEqual([]);
  } finally {
    release();
  }
});
