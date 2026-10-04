import { expect, test } from "@playwright/test";
import { FIXED_NOW, installMobileApi } from "./mobile-fixtures";

test("mouse hover works in a narrow overview without fetching or pinning", async ({ page }) => {
  await page.setViewportSize({ width: 512, height: 844 });
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests);
  await page.goto("/?view=overview&range=259200&live=1&legend=compact");
  const card = page.locator('[data-chart-id="supply-demand"]');
  const canvas = card.locator("canvas");
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  const before = requests.length;
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card.locator('[data-value-scope="cursor"]').first()).toBeVisible();
  await expect(card.locator(".homepage-shared-cursor")).toBeVisible();
  expect(requests.length).toBe(before);
  await expect(page).toHaveURL(/time_play=running/);
  await page.mouse.move(0, 0);
  await expect(card.locator('[data-value-scope="window-latest"]').first()).toBeVisible();
  await expect(page.locator(".homepage-cursor-strip")).toHaveCount(0);
});

test("live headroom refresh preserves plot position and canvas", async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await installMobileApi(page);
  await page.goto("/?view=overview&range=259200&live=1&legend=compact");
  const card = page.locator('[data-chart-id="overview-headroom"]');
  await card.scrollIntoViewIfNeeded();
  const canvas = card.locator("canvas");
  await expect(canvas).toHaveAttribute("data-chart-ready", "true");
  const before = await canvas.boundingBox();
  const originalCanvas = await canvas.elementHandle();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    await blocked;
    await route.fallback();
  });
  try {
    await page.clock.setFixedTime(new Date(FIXED_NOW.getTime() + 300_000));
    await page.clock.fastForward(30_000);
    await expect(card).toHaveAttribute("aria-busy", "true");
    const refreshing = await canvas.boundingBox();
    expect(refreshing!.y).toBeCloseTo(before!.y, 0);
    expect(refreshing!.height).toBe(before!.height);
    expect(await canvas.evaluate((node, original) => node === original, originalCanvas)).toBe(true);
  } finally {
    release();
  }
  await expect(card).toHaveAttribute("aria-busy", "false");
  expect((await canvas.boundingBox())!.y).toBeCloseTo(before!.y, 0);
});
