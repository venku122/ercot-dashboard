import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

for (const mode of ["disabled", "enabled"] as const) {
  test(`core collection pricing remains inspectable with optional MIS ${mode}`, async ({
    page,
  }) => {
    const requests: string[][] = [];
    await installMobileApi(page, "normal", requests, { marketGeography: mode });
    // Explicit older-receiver compatibility: core v1 collection data stays available.
    await page.route("**/api/v2/tile-catalog**", (route) =>
      route.fulfill({ status: 404, json: { error: "older_receiver_fixture" } }),
    );
    await page.goto("/?overviewPoint=HB_NORTH&range=21600&live=1");
    const native = page.locator('[data-chart-id="pricing"]');
    await native.scrollIntoViewIfNeeded();
    if (mode === "enabled") {
      await expect(native.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      await expect(native.locator(".legend-latest")).toContainText("$18.00/MWh");
    } else {
      await expect(native).toContainText("North Hub");
      await expect(native.locator("canvas")).toHaveCount(0);
    }
    const legacy = page.locator('[data-chart-id="pricing-collection"]');
    await expect(legacy).toContainText("collection history");
    await expect(legacy).toContainText("Delivery interval unknown");
    await legacy.scrollIntoViewIfNeeded();
    await expect(legacy.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    const houston = legacy.getByRole("button", { name: "Houston hub", exact: true });
    await expect(houston.locator(".legend-latest")).toContainText("$38.74/MWh");
    expect(requests.flat()).toContain("pricing:houston:current");
    await legacy.locator("summary").filter({ hasText: "Accessible data table" }).click();
    await expect(legacy.getByRole("columnheader", { name: "Timestamp" })).toBeVisible();
    await expect(legacy.getByRole("columnheader", { name: "Interval ending (UTC)" })).toHaveCount(
      0,
    );
    const downloadPromise = page.waitForEvent("download");
    await legacy.getByLabel(/chart menu/).click();
    await legacy.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
    const csv = await readFile((await (await downloadPromise).path())!, "utf8");
    expect(csv).toContain("series,timestamp_iso,timestamp_epoch,value");
    expect(csv).not.toContain("interval_ending_epoch");
    const expectedLast = FIXED_NOW_SECONDS - 21600 + Math.floor(21600 / 63) * 63;
    expect(csv).toContain(String(expectedLast));
    expect(csv).toContain("38.739707038865006");
    expect(csv.trim().split("\n")).toHaveLength(1 + 3 * 64);
    await expect(page.getByLabel("History point")).toHaveValue("HB_NORTH");
    if (mode === "enabled")
      await expect(native.locator(".legend-latest")).toContainText("$18.00/MWh");
    await legacy.screenshot({ path: `/tmp/ercot-post-release-2026-10/core-price-MIS-${mode}.png` });
  });
}

for (const [scenario, value] of [
  ["negative", "-425"],
  ["spike", "5250"],
] as const) {
  test(`legacy collection table retains ${scenario} observations with MIS disabled`, async ({
    page,
  }) => {
    await installMobileApi(page, scenario, [], { marketGeography: "disabled" });
    await page.route("**/api/v2/tile-catalog**", (route) =>
      route.fulfill({ status: 404, json: { error: "older_receiver_fixture" } }),
    );
    await page.goto("/?range=21600&live=1&overviewPoint=HB_NORTH");
    const legacy = page.locator('[data-chart-id="pricing-collection"]');
    await legacy.scrollIntoViewIfNeeded();
    await expect(legacy.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await legacy.locator("summary").filter({ hasText: "Accessible data table" }).click();
    await expect(
      legacy.getByRole("cell", {
        name: scenario === "negative" ? "-$425.00/MWh" : "$5,250.00/MWh",
        exact: true,
      }),
    ).toHaveCount(3);
    await expect(page.locator('[data-chart-id="pricing"] canvas')).toHaveCount(0);
    await legacy.locator("canvas").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(legacy.locator(".legend-latest").first()).toHaveAttribute(
      "data-value-scope",
      "cursor",
    );
    await expect(
      page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "North Hub" }),
    ).toContainText("—");
    await page.keyboard.press("Escape");
    await legacy.getByLabel(/chart menu/).click();
    await legacy.getByRole("menuitem", { name: "Open inspect", exact: true }).click();
    await expect(legacy).toHaveClass(/chart-card-inspect/);
    await expect(legacy).toContainText("Delivery interval unknown");
  });
}

test("current receiver collection pricing and explicit disabled MIS settle without retries", async ({
  page,
}) => {
  const history: string[] = [];
  await installMobileApi(page, "normal", [], { nativeCadence: true, marketGeography: "disabled" });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (request.method() === "POST" && url.pathname === "/api/series/batch") ||
      /^\/api\/(?:v1\/(?:series-chunk|market-price-history|historical-forecast)|v2\/tiles\/)/.test(
        url.pathname,
      )
    )
      history.push(url.pathname);
  });
  await page.goto("/?overviewPoint=HB_NORTH&range=21600&live=1");
  const legacy = page.locator('[data-chart-id="pricing-collection"]');
  await legacy.scrollIntoViewIfNeeded();
  await expect(legacy.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(
    legacy.getByRole("button", { name: "Houston hub", exact: true }).locator(".legend-latest"),
  ).toContainText(/\$[\d,.]+\/MWh/);
  await expect(page.getByLabel("Settlement price ranking")).toContainText(
    "Settlement source unavailable",
  );
  const count = history.length;
  // Cross SWR's five-second error retry interval; disabled fixtures produce no transport error.
  await page.waitForTimeout(6500);
  expect(history).toHaveLength(count);
  await expect(page.locator('[data-chart-id="pricing"] canvas')).toHaveCount(0);
});

test("390px core first plot precedes deferred collection history requests", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests, { marketGeography: "disabled" });
  await page.goto("/?range=21600&live=1");
  const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThanOrEqual(320);
  expect(requests.flat().filter((id) => id.startsWith("pricing:"))).toEqual([]);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    "/tmp/ercot-post-release-2026-10/core-price-390-geometry.json",
    JSON.stringify({
      viewport: 390,
      plotTop: box!.y,
      plotHeight: box!.height,
      target280: box!.y <= 280,
      retained320: box!.y <= 320,
      initialCollectionRequests: 0,
    }),
  );
});
