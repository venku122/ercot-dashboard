import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./mobile-fixtures";
import { installStorageContextReplayApi } from "./storage-context-replay-fixtures";

test("storage context replay is contained and operable on mobile @mobile-core", async ({
  page,
}) => {
  const batches: string[][] = [];
  const market: string[] = [];
  await installStorageContextReplayApi(page, "normal", batches, market);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  const toggle = summary.getByRole("button", {
    name: "Open multi-cadence storage context replay",
  });
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();

  const replay = summary.getByRole("region", { name: "Multi-cadence storage context replay" });
  await expect(replay).toBeVisible();
  await expect(replay.locator(".storage-context-lane")).toHaveCount(4);
  await expectNoHorizontalOverflow(page);

  const exactToggle = replay.getByText("Exact observations and provenance");
  const exactToggleBox = await exactToggle.boundingBox();
  expect(exactToggleBox).not.toBeNull();
  expect(exactToggleBox!.height).toBeGreaterThanOrEqual(44);
  await exactToggle.click();
  const exact = replay.getByRole("region", { name: "Storage context replay exact observations" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("storage context replay has stable mobile evidence @mobile-vri", async ({ page }) => {
  const batches: string[][] = [];
  const market: string[] = [];
  await installStorageContextReplayApi(page, "normal", batches, market);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await summary.getByRole("button", { name: "Open multi-cadence storage context replay" }).click();
  const replay = summary.getByRole("region", { name: "Multi-cadence storage context replay" });
  await expect(replay).toBeVisible();
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await expect(replay).toHaveScreenshot("storage-context-replay-mobile.png");
  await replay.getByText("Exact observations and provenance").click();
  await expect(
    replay.getByRole("region", { name: "Storage context replay exact observations" }),
  ).toHaveScreenshot("storage-context-replay-exact-mobile.png");
});
