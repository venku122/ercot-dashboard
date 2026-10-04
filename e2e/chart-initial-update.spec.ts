import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

test("initial core charts use their constructor render while later selections still update", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (body.queries.some((query) => query.id === "frequency:frequency:current")) await held;
    await route.fallback();
  });
  try {
    await page.goto("/?range=86400&live=1");
    await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
      "data-chart-ready",
      "true",
    );
    await expect(page.locator('[data-chart-id="overview-headroom"] canvas')).toHaveAttribute(
      "data-chart-ready",
      "true",
    );
    const lifecycle = await page.evaluate(() => window.__ercotChartLifecycle);
    expect(lifecycle!.constructed).toBeGreaterThanOrEqual(2);
    expect(lifecycle!.updated).toBe(0);
  } finally {
    release();
  }
  const frequency = page.locator('[data-chart-id="frequency"]');
  await frequency.scrollIntoViewIfNeeded();
  await expect(frequency.locator('canvas[data-chart-ready="true"]')).toBeVisible();
  await expect(frequency).toHaveAttribute("aria-busy", "false");
  const before = await page.evaluate(() => ({ ...window.__ercotChartLifecycle }));
  const picker = page.getByRole("combobox", { name: "Time range picker" });
  await picker.click();
  await picker.fill("6h");
  await picker.press("Enter");
  await expect(frequency).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() => page.evaluate(() => window.__ercotChartLifecycle?.updated ?? 0))
    .toBeGreaterThan(before!.updated!);
  expect((await page.evaluate(() => window.__ercotChartLifecycle))!.constructed).toBe(
    before!.constructed,
  );
});
