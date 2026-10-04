import { expect, test } from "@playwright/test";
import { recordSourceContainment } from "./source-containment-evidence";
import { installMobileApi } from "./mobile-fixtures";

const origin = process.env["SOURCE_REHEARSAL_ORIGIN"];
test.skip(
  !origin,
  "Requires the disposable live-source receiver started by scripts/rehearse_sources.py --browser",
);
if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("isolated_receiver_required");

for (const width of [390, 1440]) {
  test(`ERP-08 live publications match accessible tables at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.route(
      /\/api\/(v1|v2)\/(external-context|texas-grid|predictive-weather)(\/|\?|$)/,
      async (route) => {
        const url = new URL(route.request().url());
        const response = await request.get(origin + url.pathname + url.search);
        await route.fulfill({ response });
      },
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    const external = await (await request.get(origin + "/api/v1/external-context")).json();
    const annual = await (await request.get(origin + external.epa_egrid.selected.url)).json();
    await page.goto("/?view=external-context");
    await page.getByRole("button", { name: "Open eGRID evidence", exact: true }).click();
    const rates = page.getByRole("region", { name: "Exact eGRID ERCT annual rate evidence" });
    await expect(rates.locator("tbody tr")).toHaveCount(annual.rates.length);
    for (const rate of annual.rates) {
      const row = rates.getByRole("row").filter({ hasText: rate.metric_id });
      await expect(row.getByRole("cell").nth(2)).toHaveText(rate.value.toLocaleString("en-US"));
      await expect(row.getByRole("cell").nth(3)).toHaveText("lb/MWh");
    }
    await page.screenshot({
      path: `artifacts/post-release/source-egrid-${width}.png`,
      fullPage: true,
    });

    const planning = await (await request.get(origin + "/api/v1/texas-grid")).json();
    const gis = await (
      await request.get(origin + planning.generator_interconnection.selected.url)
    ).json();
    await page.goto("/?view=texas-grid");
    await page.getByRole("button", { name: "Open interconnection history", exact: true }).click();
    const aggregates = page.getByRole("region", {
      name: "Exact generator interconnection aggregate evidence",
    });
    await expect(aggregates.locator("tbody tr")).toHaveCount(gis.aggregates.length);
    for (let index = 0; index < gis.aggregates.length; index++) {
      const source = gis.aggregates[index];
      const row = aggregates.locator("tbody tr").nth(index);
      await expect(row.getByRole("cell").nth(2)).toHaveText(source.count.toLocaleString("en-US"));
      await expect(row.getByRole("cell").nth(3)).toHaveText(
        `${source.capacity_mw.toLocaleString("en-US")} MW`,
      );
    }
    await expect(aggregates).toContainText("MWH");
    await page.screenshot({
      path: `artifacts/post-release/source-gis-${width}.png`,
      fullPage: true,
    });

    const weather = await (await request.get(origin + "/api/v1/predictive-weather")).json();
    const point = weather.forecast.points.find(
      (item: { point_id: string }) => item.point_id === "KDFW",
    );
    await page.goto("/?view=outlook");
    await page.getByRole("button", { name: "Show predictive weather", exact: true }).click();
    await page.getByText("Exact NWS forecast intervals", { exact: true }).click();
    const intervals = page.getByRole("region", {
      name: `${point.label} exact NWS forecast intervals`,
    });
    await expect(intervals.locator("tbody tr")).toHaveCount(
      point.layers.flatMap((layer: { rows: unknown[] }) => layer.rows).length,
    );
    const sourceRows = point.layers.flatMap(
      (layer: { unit: string; rows: Array<{ value: number | null }> }) =>
        layer.rows.map((row) => ({ ...row, unit: layer.unit })),
    );
    const expectedValues = sourceRows.map((source: { value: number | null; unit: string }) =>
      source.value === null
        ? "Missing"
        : `${source.value.toFixed(1)} ${source.unit === "wmoUnit:degC" ? "°C" : "km/h"}`,
    );
    await expect(intervals.locator("tbody tr td:nth-child(4)")).toHaveText(expectedValues);
    await page.screenshot({
      path: `artifacts/post-release/source-nws-${width}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await recordSourceContainment(page, testInfo, "nws-source-containment");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
