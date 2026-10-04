import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import captured from "./fixtures/np6-905-captured-history.json" with { type: "json" };
import { installMobileApi } from "./mobile-fixtures";
import { installMarketGeographyApi } from "./market-geography-fixtures";
const row = captured.rows[0]!;
const target = row.target_ts;
for (const fraction of [0, 1]) {
  test(`captured NP6-905 partial delivery cursor/table/CSV retains real closing epoch ${fraction}`, async ({
    page,
  }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.clock.setFixedTime(new Date(row.publication.retrieved_at * 1000));
    await installMarketGeographyApi(page, []);
    await page.route("**/api/v2/tile-catalog**", (r) =>
      r.fulfill({ status: 404, json: { error: "legacy_receiver_diagnostic" } }),
    );
    const requests: Array<{ start: number; end: number }> = [];
    await page.route("**/api/v1/market-price-history?**", (r) => {
      const q = new URL(r.request().url());
      const start = Number(q.searchParams.get("start")),
        end = Number(q.searchParams.get("end"));
      requests.push({ start, end });
      return r.fulfill({
        json: {
          ...captured,
          start,
          end,
          rows: captured.rows.filter((r) => r.target_ts >= start && r.target_ts < end),
        },
      });
    });
    const start = target - 900 + fraction,
      end = target - 300 + fraction;
    await page.goto(`/?range=600&live=0&from=${start}&to=${end}&history=0`);
    const chart = page.locator('[data-chart-id="pricing"]');
    await chart.scrollIntoViewIfNeeded();
    const canvas = chart.locator("canvas");
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    expect(requests).toContainEqual({ start: Math.ceil(start), end: target + 1 });
    await canvas.focus();
    await page.keyboard.press("ArrowLeft");
    const price = page.locator(".homepage-readings > div").filter({ hasText: "Houston Hub" });
    const value = `$${row.value.toFixed(2)}/MWh`;
    await expect(price).toContainText(value);
    await expect(price).toHaveAttribute("title", /Interval ending.*10:45 PM CDT/);
    await page.keyboard.press("Escape");
    await expect(chart.locator(".legend-latest")).toContainText(value);
    await chart.locator("summary").filter({ hasText: "Accessible data table" }).click();
    await expect(chart.getByRole("columnheader", { name: "Interval ending (UTC)" })).toBeVisible();
    await expect(chart.getByRole("cell", { name: value, exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await chart.getByLabel(/chart menu/).click();
    await chart.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
    const download = await downloadPromise;
    const csv = await readFile((await download.path())!, "utf8");
    expect(csv).toContain(`${target},${row.value},"$/MWh",${target - 900},${target}`);
    const painted = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let pixels = 0;
      for (let i = 0; i < d.length; i += 4)
        if (d[i] === 96 && d[i + 1] === 165 && d[i + 2] === 250 && d[i + 3]! > 150) pixels++;
      return pixels;
    });
    expect(painted).toBeGreaterThan(100);
    await test.info().attach("captured-source-request", {
      body: JSON.stringify({ requests, row, selected: { start, end } }),
      contentType: "application/json",
    });
  });
}
