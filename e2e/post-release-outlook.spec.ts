import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi, outlookFixture } from "./mobile-fixtures";

async function installForecast(page: import("@playwright/test").Page) {
  const fixture = outlookFixture();
  const row = fixture.forecast.rows[0]!;
  fixture.forecast.rows = Array.from({ length: 24 }, (_, index) => ({
    ...row,
    target_ts: FIXED_NOW_SECONDS + (index + 1) * 3600,
    demand_mw: 70_000 + index * 100,
  }));
  let requests = 0;
  await page.route("**/api/v1/outlook", (route) => {
    requests++;
    return route.fulfill({ json: fixture });
  });
  return { fixture, count: () => requests };
}

for (const width of [390, 1440]) {
  test(`ERP-07 next24 current publication stays independent of historical pin at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    // This fixture exercises the existing older-receiver fixed-range compatibility path.
    await page.route("**/api/v2/tile-catalog", (route) =>
      route.fulfill({ status: 404, json: { error: "older_receiver_fixture" } }),
    );
    await page.route("**/api/v1/series/chunk?**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      const start = Number(params.get("start")),
        end = Number(params.get("end"));
      const metric = params.get("metric")!;
      const value = metric.includes("capacity")
        ? 90_000
        : metric.includes("demand")
          ? 70_000
          : metric.includes("Frequency")
            ? 60
            : 500;
      return route.fulfill({
        json: {
          aggregation: params.get("aggregation"),
          start,
          end,
          metric,
          resolution: Number(params.get("resolution")),
          tags: params.getAll("tag"),
          points: Array.from({ length: Math.floor((end - start) / 300) + 1 }, (_, index) => [
            start + index * 300,
            value,
          ]),
        },
      });
    });
    const source = await installForecast(page);
    await page.goto(
      `/?range=21600&live=0&from=${FIXED_NOW_SECONDS - 21600}&to=${FIXED_NOW_SECONDS}&history=0`,
    );
    const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
    await expect(surface).toContainText("72.3 GW");
    await expect(surface).toContainText("24 of 24 hourly values");
    await expect(surface).toContainText("independent of the selected historical period");
    await expect(surface.locator("svg")).toHaveCount(1);
    const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    const geometry = (await canvas.boundingBox())!;
    expect(geometry.y).toBeLessThanOrEqual(width === 390 ? 320 : 240);
    await canvas.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    const pinned = new URL(page.url()).searchParams.get("time_to_ms");
    await expect(surface).toContainText("72.3 GW");
    expect(source.count()).toBe(1);
    await surface.getByRole("button", { name: "Hourly forecast values", exact: true }).click();
    await expect(
      surface.getByRole("table", { name: "Next 24 hour forecast values" }).locator("tbody tr"),
    ).toHaveCount(24);
    await expect(surface.getByRole("table").locator("tbody tr").first()).toContainText("70,000");
    await surface.screenshot({
      path: `/tmp/ercot-post-release-2026-10/ERP-07-outlook-${width}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    source.fixture.forecast.rows[23]!.demand_mw = 88_000;
    source.fixture.forecast.publication.issued_at = FIXED_NOW_SECONDS - 10;
    source.fixture.forecast.publication.retrieved_at = FIXED_NOW_SECONDS - 5;
    source.fixture.forecast.publication.vintage_key = `v1-${"d".repeat(64)}`;
    await surface.getByRole("button", { name: "Refresh Outlook", exact: true }).click();
    await expect(surface).toContainText("88.0 GW");
    expect(new URL(page.url()).searchParams.get("time_to_ms")).toBe(pinned);
    expect(source.count()).toBe(2);
    await surface.getByRole("button", { name: "Open full Outlook", exact: true }).click();
    await expect(page.getByLabel("Grid Outlook summary")).toBeVisible();
    expect(source.count()).toBe(2);
    expect(new URL(page.url()).searchParams.get("time_to_ms")).toBe(pinned);
  });
}

test("ERP-07 optional publication failure never mounts an empty forecast plot", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.route("**/api/v1/outlook", (route) =>
    route.fulfill({ status: 503, json: { error: "outlook_unavailable" } }),
  );
  await page.goto("/?range=86400&live=1");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toContainText("publication unavailable");
  await expect(surface.locator("svg")).toHaveCount(0);
  await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  await surface.screenshot({ path: "/tmp/ercot-post-release-2026-10/ERP-07-unavailable.png" });
});

test("ERP-07 a publication request survives changing its view placement", async ({ page }) => {
  await installMobileApi(page);
  let release: (() => void) | undefined;
  let count = 0;
  const failures: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/api/v1/outlook"))
      failures.push(request.failure()?.errorText ?? "failed");
  });
  await page.route("**/api/v1/outlook", async (route) => {
    count++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: outlookFixture() });
  });
  await page.goto("/?range=86400&live=1");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toContainText("Loading current publication");
  await expect.poll(() => Boolean(release)).toBe(true);
  await surface.getByRole("button", { name: "Open full Outlook", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Outlook", exact: true })).toBeVisible();
  release!();
  await expect(page.getByLabel("Grid Outlook summary")).toBeVisible();
  expect(count).toBe(1);
  expect(failures).toEqual([]);
});

test("ERP-07 valid-empty and unverified availability remain distinct", async ({ page }) => {
  await installMobileApi(page);
  const input = outlookFixture();
  input.forecast.publication = null as never;
  input.forecast.revision_reference = null as never;
  input.forecast.rows = [];
  input.forecast.source_health.availability_status = "empty";
  await page.route("**/api/v1/outlook", (route) => route.fulfill({ json: input }));
  await page.goto("/?range=86400&live=1");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toHaveAttribute("data-outlook-state", "valid-empty");
  await expect(surface).toContainText("valid-empty");
  await expect(surface.locator("svg")).toHaveCount(0);
  input.forecast.source_health = null as never;
  await page.reload();
  await expect(surface).toHaveAttribute("data-outlook-state", "availability-unknown");
  await expect(surface).toContainText("source eligibility is unknown");
  await expect(surface.locator("svg")).toHaveCount(0);
});

test("ERP-07 stale publication retains forecast values with explicit age", async ({ page }) => {
  await installMobileApi(page, "outlook-stale");
  await page.goto("/?range=86400&live=1");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toHaveAttribute("data-outlook-state", "stale");
  await expect(surface).toContainText("70.4 GW");
  await expect(surface).toContainText("source stale, stale");
  await expect(surface).toContainText("2 of 24 hourly values");
});

test("ERP-07 compact forecast stays contained at small phone, tablet and 200 percent zoom", async ({
  page,
}) => {
  await installMobileApi(page);
  await installForecast(page);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/");
    const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
    await expect(surface).toContainText("72.3 GW");
    await surface.getByRole("button", { name: "Hourly forecast values", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(surface.getByRole("table")).toBeVisible();
    for (const zoom of width === 320 ? [1] : [1, 2]) {
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (pageWidth > width) {
        await page.screenshot({
          path: `/tmp/ercot-post-release-2026-10/ERP-07-overflow-${width}-zoom${zoom}.png`,
        });
      }
      expect(pageWidth, JSON.stringify({ width, zoom, pageWidth })).toBeLessThanOrEqual(width);
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
  }
});

// Retains the discovered whole-page reflow failure for ERP-09 integration repair.
test("ERP-09 retained regression: 320px viewport at CSS zoom 200 percent contains the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 960 });
  await installMobileApi(page);
  await installForecast(page);
  await page.goto("/");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toContainText("72.3 GW");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const evidence = await page.evaluate(() => ({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: Array.from(document.querySelectorAll("body *"))
      .filter((element) => element.getBoundingClientRect().right > innerWidth)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: element.getBoundingClientRect().right,
      }))
      .slice(0, 30),
  }));
  await page.screenshot({ path: "/tmp/ercot-post-release-2026-10/ERP-07-ERP09-320-zoom200.png" });
  expect(evidence.scrollWidth, JSON.stringify(evidence)).toBeLessThanOrEqual(evidence.viewport);
});

test("ERP-07 retained publications disclose latest valid-empty collection per product", async ({
  page,
}) => {
  await installMobileApi(page, "normal");
  const source = await installForecast(page);
  source.fixture.forecast.source_health.availability_status = "empty";
  source.fixture.adequacy.source_health.availability_status = "empty";
  await page.goto("/?view=overview");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toHaveAttribute("data-outlook-state", "valid-empty-retained");
  await expect(surface).toContainText("Load forecast: latest collection was valid-empty");
  await expect(surface).toContainText("System adequacy: latest collection was valid-empty");
  await expect(surface).toContainText("showing the retained publication");
  await expect(surface).toContainText("72.3 GW");
  await expect(surface.locator("svg")).toHaveCount(1);
  expect(source.count()).toBe(1);
  await surface.getByRole("button", { name: "Open full Outlook", exact: true }).click();
  await expect(page.getByLabel("Outlook source freshness")).toContainText(
    "Load forecast: latest collection was valid-empty",
  );
  await expect(page.getByLabel("Outlook source freshness")).toContainText(
    "System adequacy: latest collection was valid-empty",
  );
  expect(source.count()).toBe(1);
});

test("ERP-07 compact and specialist headroom require their own capacity basis", async ({
  page,
}) => {
  await installMobileApi(page, "normal");
  const source = await installForecast(page);
  source.fixture.adequacy.rows.forEach((row) => (row.available_generation_mw = null as never));
  await page.goto("/?view=overview");
  const surface = page.getByRole("region", { name: "Current next 24 hour Outlook" });
  await expect(surface).toContainText("72.3 GW");
  await expect(surface.locator(".overview-outlook-summary dd").nth(1)).toHaveText("—");
  await surface.getByRole("button", { name: "Open full Outlook", exact: true }).click();
  const summary = page.getByLabel("Grid Outlook summary");
  await expect(
    summary
      .getByText("Tightest projected headroom", { exact: true })
      .locator("..")
      .locator("strong"),
  ).toHaveText("Not available");
  expect(source.count()).toBe(1);
});
