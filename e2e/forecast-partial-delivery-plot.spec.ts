import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
for (const bounds of [true, false]) {
  test(`archived hourly forecast draws only verified partial delivery support bounds=${bounds}`, async ({
    page,
  }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    const target = Date.parse("2026-08-18T08:00:00Z") / 1000;
    await page.route("**/api/v1/historical-forecast?**", (route) =>
      route.fulfill({
        json: {
          product_id: "NP3-565-CD",
          policy: "issued_before_delivery",
          rows: [
            {
              target_ts: target,
              issued_at: target - 7200,
              value: 42000,
              unit: "MW",
              ...(bounds ? { interval_start: target - 3600, interval_end: target } : {}),
            },
          ],
        },
      }),
    );
    // Explicit synthetic NP3-565 delivery fixture; isolate its independent 42 GW value.
    await page.route("**/api/series/batch", async (route) => {
      const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
      return route.fulfill({
        json: {
          series: body.queries.map((q) => ({
            id: q.id,
            points: [],
            meta: { bucket_seconds: 300 },
          })),
        },
      });
    });
    const start = target - 2400,
      end = target - 1200;
    await page.goto(
      `/?view=overview&live=0&from=${start}&to=${end}&range=1200&compare=none&legend=compact`,
    );
    const chart = page.locator('[data-chart-id="supply-demand"]');
    if (!bounds) {
      await expect(chart.locator("canvas")).toHaveCount(0);
      return;
    }
    const canvas = chart.locator("canvas");
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    await canvas.focus();
    await page.keyboard.press("ArrowLeft");
    const forecast = chart
      .locator(".legend-row")
      .filter({ hasText: "Forecast issued before delivery" })
      .locator(".legend-latest");
    await expect(forecast).toContainText("42.0 GW");
    await expect(forecast).toHaveAttribute("title", /Delivery interval.*hour ending/);
    const painted = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement,
        d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let longest = 0;
      for (let y = 0; y < c.height; y++) {
        let count = 0;
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] === 148 && d[i + 1] === 163 && d[i + 2] === 184 && d[i + 3]! > 150) count++;
        }
        longest = Math.max(longest, count);
      }
      return { longest, width: c.width };
    });
    expect(painted.longest).toBeGreaterThan(painted.width * 0.25);
  });
}
