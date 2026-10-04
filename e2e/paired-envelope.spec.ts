import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

test("paired envelope cursor accessible table and CSV retain the final non-extreme observation", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.route("**/api/v1/series/chunk**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: {
        aggregation: "average",
        metric: url.searchParams.get("metric"),
        tags: url.searchParams.getAll("tag"),
        start: Number(url.searchParams.get("start")),
        end: Number(url.searchParams.get("end")),
        resolution: Number(url.searchParams.get("resolution")),
        points: [],
      },
    });
  });
  const epoch = Math.floor(FIXED_NOW_SECONDS / 3600) * 3600 - 2 * 86400;
  const to = epoch + 3600,
    from = to - 7 * 86400;
  const raw = [
    [epoch, 10],
    [epoch + 300, 5],
    [epoch + 600, 7],
  ];
  await page.route("**/api/v2/tiles/supply-demand.paired-headroom/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = /\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/.exec(path)!;
    const start = Number(match[2]),
      end = start + (match[1] === "1d" ? 86400 : 3600);
    const width =
      match[3] === "native" ? 0 : match[3] === "5m" ? 300 : match[3] === "15m" ? 900 : 3600;
    const rows = raw.filter(([ts]) => ts! >= start && ts! < end);
    const groups = new Map<number, number[][]>();
    for (const point of rows) {
      const anchor = width ? Math.floor(point[0]! / width) * width : point[0]!;
      groups.set(anchor, [...(groups.get(anchor) ?? []), point]);
    }
    const buckets = [...groups].map(([anchor, points]) => {
      const first = points[0]!,
        last = points.at(-1)!;
      const minimum = points.reduce((a, b) => (a[1]! < b[1]! ? a : b)),
        maximum = points.reduce((a, b) => (a[1]! > b[1]! ? a : b));
      return {
        start: anchor,
        end: anchor + width,
        state: {
          version: 2,
          count: points.length,
          first_ts: first[0],
          first_value: first[1],
          first_ordinal: 0,
          last_ts: last[0],
          last_value: last[1],
          last_ordinal: 0,
          minimum: minimum[1],
          minimum_ts: minimum[0],
          maximum: maximum[1],
          maximum_ts: maximum[0],
          value_sum: points.reduce((sum, point) => sum + point[1]!, 0),
          integral_value_seconds: 0,
        },
      };
    });
    await route.fulfill({
      json: {
        schema: 2,
        boundary_policy: "native_edges_coarse_aligned_interiors",
        buckets,
        lod: match[3],
        native_interval_seconds: 300,
        rollup: null,
        series_key: "supply-demand.paired-headroom",
        statistic_policy: "gauge",
        tile_start: start,
        tile_end: end,
        tile_span: match[1],
        unit: "MW",
        pairing: {
          policy: "supply-demand-observed-exact-epoch-v1",
          paired_count: rows.length,
          expected_count: (end - start) / 300,
          unpaired_count: 0,
          ambiguous_count: 0,
          first_observed_ts: rows[0]?.[0] ?? null,
          last_observed_ts: rows.at(-1)?.[0] ?? null,
          collection_history: "first_collection_time_not_recorded",
          reason: rows.length ? null : "no_matching_native_epochs",
          partial_buckets: width ? buckets.map((bucket) => bucket.start) : [],
          continuous_buckets: [],
        },
      },
    });
  });
  await page.goto(`/?view=overview&live=0&from=${from}&to=${to}&range=604800&compare=none`);
  const card = page.locator('[data-chart-id="overview-headroom"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await card.getByText("Accessible data table", { exact: true }).click();
  const rows = card.locator("tbody tr").filter({ hasText: "Derived headroom" });
  await expect(rows).toHaveCount(3);
  await expect(rows.locator("td:nth-child(2)")).toHaveText(
    raw.map(([ts]) => new Date(ts! * 1000).toISOString()),
  );
  await expect(rows.locator("td:nth-child(3)")).toHaveText(["10.0 MW", "5.0 MW", "7.0 MW"]);
  await card.getByRole("button", { name: /Open Capacity headroom/ }).click();
  await card.locator("canvas").focus();
  for (let index = 0; index < 10; index++) await page.keyboard.press("ArrowLeft");
  const readings = page.getByLabel("Time-aligned grid readings");
  await expect(readings.getByText("Derived headroom", { exact: true }).locator("..")).toContainText(
    "7.0 MW",
  );
  const download = page.waitForEvent("download");
  await card.getByLabel("Capacity headroom & PRC chart menu").click();
  await page.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
  const csv = readFileSync((await (await download).path())!, "utf8");
  expect(csv).toContain(
    `"Derived headroom",${new Date((epoch + 600) * 1000).toISOString()},${epoch + 600},7`,
  );
  expect(csv.split("\n").filter((row) => row.startsWith('"Derived headroom"'))).toHaveLength(3);
});
