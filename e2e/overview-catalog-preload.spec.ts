import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
import { observeHistory } from "./performance-observations";

test("Overview requests its shared catalog before the entry script and reuses the response", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  observeHistory(page, true);
  let releaseEntry!: () => void;
  const entryGate = new Promise<void>((resolve) => {
    releaseEntry = resolve;
  });
  const catalogs: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/tile-catalog") catalogs.push(url.pathname + url.search);
  });
  await page.route("**/assets/index-*.js", async (route) => {
    await entryGate;
    await route.continue();
  });
  const navigation = page.goto("/?view=overview&range=86400&live=1");
  try {
    await expect
      .poll(() => catalogs, { timeout: 3000 })
      .toEqual(["/api/v2/tile-catalog?include=paired-headroom"]);
  } finally {
    releaseEntry();
  }
  await navigation;
  const balance = page.locator('[data-chart-id="supply-demand"]');
  await expect(balance.locator('canvas[data-chart-ready="true"]')).toBeVisible();
  await page.waitForFunction(() => {
    const expected = (
      window as Window & {
        __performanceExpectedReadings?: { demand: string; capacity: string; headroom: string };
      }
    ).__performanceExpectedReadings;
    return (
      expected &&
      expected.demand !== "—" &&
      expected.headroom !== "—" &&
      document
        .querySelector('[data-chart-id="supply-demand"]')
        ?.textContent?.includes(expected.demand) &&
      document
        .querySelector('[data-chart-id="supply-demand"]')
        ?.textContent?.includes(expected.capacity) &&
      document
        .querySelector('[data-chart-id="overview-headroom"]')
        ?.textContent?.includes(expected.headroom)
    );
  });
  await expect
    .poll(() => catalogs.filter((url) => url.endsWith("include=paired-headroom")).length)
    .toBe(1);
});

test("A specialist deep link performs no speculative Overview catalog request", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const catalogs: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v2/tile-catalog") catalogs.push(request.url());
  });
  await page.goto("/?view=outlook");
  await expect(page.getByRole("heading", { name: "Outlook", exact: true })).toBeVisible();
  expect(catalogs).toEqual([]);
});
