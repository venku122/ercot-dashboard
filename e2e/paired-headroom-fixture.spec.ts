import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";
import { nativeFixtureIndex, observedTileFixture } from "./paired-headroom-fixtures";

test("populated fixture derives native source pairs before aggregate statistics", () => {
  const day = Math.floor((FIXED_NOW_SECONDS - 86400) / 86400) * 86400;
  const value = (metric: string, index: number) =>
    metric.includes("available_capacity") ? 100 + (index % 7) : 90 + (index % 3);
  const tile = observedTileFixture(
    `/api/v2/tiles/supply-demand.paired-headroom/1d/${day}/1h`,
    FIXED_NOW_SECONDS,
    value,
  );
  expect(tile.statistic_policy).toBe("gauge");
  expect(tile.pairing?.paired_count).toBe(288);
  expect(tile.pairing?.expected_count).toBe(288);
  expect(tile.pairing?.unpaired_count).toBe(0);
  expect(tile.buckets).toHaveLength(24);
  for (const bucket of tile.buckets) {
    const raw = Array.from({ length: 12 }, (_, offset) => {
      const timestamp = bucket.start + offset * 300,
        index = nativeFixtureIndex(timestamp, FIXED_NOW_SECONDS);
      return (
        value("ercot.supply_demand.available_capacity_mw", index) -
        value("ercot.supply_demand.demand_mw", index)
      );
    });
    expect(bucket.state.count).toBe(12);
    expect(bucket.state.value_sum).toBe(raw.reduce((sum, number) => sum + number, 0));
    expect(bucket.state.minimum).toBe(Math.min(...raw));
    expect(bucket.state.maximum).toBe(Math.max(...raw));
    expect(bucket.state.integral_value_seconds).toBe(0);
  }
});

test("populated mobile fixture serves legacy and opted-in catalogs with complete headroom", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/");
  const card = page.locator('[data-chart-id="overview-headroom"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.getByRole("button", { name: "Derived headroom", exact: true })).toBeVisible();
  await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  const evidence = await page.evaluate(async () => {
    const legacy = await fetch("/api/v2/tile-catalog");
    const optin = await fetch("/api/v2/tile-catalog?include=paired-headroom");
    return {
      legacy: await legacy.json(),
      optin: await optin.json(),
      oldEtag: legacy.headers.get("etag"),
      newEtag: optin.headers.get("etag"),
    };
  });
  expect(evidence.legacy.series.every((entry: { match: string }) => entry.match !== "paired")).toBe(
    true,
  );
  expect(
    evidence.optin.series.filter((entry: { match: string }) => entry.match === "paired"),
  ).toHaveLength(1);
  expect(evidence.oldEtag).not.toBe(evidence.newEtag);
  await card.getByRole("button", { name: /Open Capacity headroom/ }).click();
  await expect(card).not.toContainText("paired_headroom_unavailable");
});
