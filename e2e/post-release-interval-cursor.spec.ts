import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
import { installMarketGeographyApi } from "./market-geography-fixtures";
const target = Date.parse("2026-08-20T17:15:00Z") / 1000;

test("NP6-905 actual cursor, table and export preserve interval ending and halfopen lookup", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.clock.setFixedTime(new Date((target + 60) * 1000));
  await installMarketGeographyApi(page, []);
  await page.route("**/api/v2/tile-catalog", (route) =>
    route.fulfill({ status: 404, json: { error: "older_receiver_fixture" } }),
  );
  await page.route("**/api/v1/market-price-history?**", (route) =>
    route.fulfill({
      json: {
        product_id: "NP6-905-CD",
        identity: "HB_HOUSTON--HU",
        interval_seconds: 900,
        rows: [
          {
            target_ts: target,
            raw_delivery_date: "08/20/2026",
            delivery_hour: 13,
            delivery_interval: 1,
            raw_dst_flag: "N",
            repeated_hour_flag: false,
            settlement_point: "HB_HOUSTON",
            settlement_point_type: "HU",
            value: -42.16,
            unit: "$/MWh",
          },
        ],
      },
    }),
  );
  await page.goto(`/?range=1200&live=0&from=${target - 1200}&to=${target}&history=0`);
  const chart = page.locator('[data-chart-id="pricing"]');
  await chart.scrollIntoViewIfNeeded();
  const canvas = chart.locator("canvas");
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
  const price = page.locator(".homepage-readings > div").filter({ hasText: "Houston Hub" });
  await expect(price).toContainText("-$42.16/MWh");
  await expect(price).toHaveAttribute("title", /Interval ending.*12:15 PM CDT/);
  await expect(chart.locator(".legend-latest")).toHaveAttribute("title", /Interval ending/);
  await page.keyboard.press("ArrowRight");
  await expect(price).toContainText("—");
  await page.keyboard.press("Escape");
  await chart.locator("summary").filter({ hasText: "Accessible data table" }).click();
  await expect(chart.getByRole("columnheader", { name: "Interval ending (UTC)" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await chart.getByLabel(/chart menu/).click();
  await chart.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const { readFile } = await import("node:fs/promises");
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain("interval_ending_epoch,value,unit,interval_start_epoch,interval_end_epoch");
  expect(csv).toContain(`${target},-42.16,"$/MWh",${target - 900},${target}`);
  await chart.screenshot({ path: "/tmp/ercot-post-release-2026-10/ERP05-followup-interval.png" });
});
