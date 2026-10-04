import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
import { installMarketGeographyApi } from "./market-geography-fixtures";
const first = Date.parse("2026-08-20T17:15:00Z") / 1000;
for (const gap of [false, true]) {
  test(`ERP05 verified interval geometry agrees with cursor and preserves gap=${gap}`, async ({
    page,
  }) => {
    await installMobileApi(page);
    await page.clock.setFixedTime(new Date((first + 3600) * 1000));
    await installMarketGeographyApi(page, []);
    const second = first + (gap ? 1800 : 900);
    await page.route("**/api/v2/tile-catalog", (r) =>
      r.fulfill({ status: 404, json: { error: "older_receiver_fixture" } }),
    );
    await page.route("**/api/v1/market-price-history?**", (r) =>
      r.fulfill({
        json: {
          product_id: "NP6-905-CD",
          identity: "HB_HOUSTON--HU",
          interval_seconds: 900,
          rows: [
            { target_ts: first, delivery_interval: 1, value: -50 },
            { target_ts: second, delivery_interval: gap ? 3 : 2, value: 99 },
          ].map((row) => ({
            ...row,
            raw_delivery_date: "08/20/2026",
            delivery_hour: 13,
            raw_dst_flag: "N",
            repeated_hour_flag: false,
            settlement_point: "HB_HOUSTON",
            settlement_point_type: "HU",
            unit: "$/MWh",
          })),
        },
      }),
    );
    await page.goto(
      `/?range=${second - first + 900}&live=0&from=${first - 900}&to=${second}&history=0`,
    );
    const chart = page.locator('[data-chart-id="pricing"]');
    await chart.scrollIntoViewIfNeeded();
    const canvas = chart.locator("canvas");
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    const evidence = await canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const rows: number[] = [];
      let left = 0,
        middle = 0;
      for (let y = 0; y < canvas.height; y++) {
        let count = 0;
        for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          if (
            data[index] === 96 &&
            data[index + 1] === 165 &&
            data[index + 2] === 250 &&
            data[index + 3]! > 150
          ) {
            count++;
            if (x > canvas.width * 0.15 && x < canvas.width * 0.3) left++;
            if (x > canvas.width * 0.45 && x < canvas.width * 0.58) middle++;
          }
        }
        rows.push(count);
      }
      return {
        width: canvas.width,
        left,
        middle,
        horizontalRows: rows.filter((count) => count > canvas.width * 0.2).length,
      };
    });
    expect(evidence.left).toBeGreaterThan(20);
    expect(evidence.horizontalRows).toBeGreaterThanOrEqual(2);
    if (gap) expect(evidence.middle).toBe(0);
    await canvas.focus();
    await page.keyboard.press("ArrowLeft");
    const price = page.locator(".homepage-readings > div").filter({ hasText: "Houston Hub" });
    await expect(price).toContainText("$99.00/MWh");
    await expect(price).toHaveAttribute("title", /Interval ending/);
    await chart.screenshot({
      path: `/tmp/ercot-post-release-2026-10/ERP05-interval-plot-gap-${gap}.png`,
    });
  });
}
