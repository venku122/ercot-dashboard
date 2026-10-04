import { expect, test } from "@playwright/test";
import { observeVisualSources } from "./vri-source-evidence";
import { withCssPixelAlignment } from "./screenshot-alignment";

import { installHistoricalContextApi } from "./historical-context-fixtures";
import { expectNoHorizontalOverflow, FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const AS_OF = Math.floor(FIXED_NOW_SECONDS / 3_600) * 3_600;

test("historical context is contained and keyboard reachable on mobile @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installHistoricalContextApi(page, requests);
  await page.goto(
    `/?view=overview&history=0&live=0&from=${String(AS_OF - 21_600)}&to=${String(AS_OF)}&range=21600`,
  );
  const panel = page.getByRole("region", { name: "Historical context and records" });
  const toggle = panel.getByRole("button", { name: "Historical context and records" });
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(panel).toContainText("Completed-day peak rank");
  await expectNoHorizontalOverflow(page);

  const exact = panel.getByRole("region", { name: "Exact historical demand evidence" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  await expectNoHorizontalOverflow(page);
});

test("historical context has stable mobile evidence @mobile-vri", async ({ page }) => {
  const evidence = observeVisualSources(page);
  const requests: string[] = [];
  await installMobileApi(page);
  await installHistoricalContextApi(page, requests);
  await page.goto(
    `/?view=overview&history=1&live=0&from=${String(AS_OF - 21_600)}&to=${String(AS_OF)}&range=21600`,
  );
  const panel = page.getByRole("region", { name: "Historical context and records" });
  await expect(panel).toContainText("75.3 GW");
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toContainText("12 / 12 observations (100%)");
  await expect(panel).toContainText("61.5 GW – 79.1 GW");
  await expect(panel).toContainText("3 of 120");
  await evidence.capture("historical-context-mobile-raw", panel);
  await withCssPixelAlignment(
    panel,
    async () => {
      await evidence.capture("historical-context-mobile-aligned", panel);
      await expect(panel).toHaveScreenshot("historical-context-mobile.png");
    },
    "floor",
    "layout",
  );
  const exact = panel.getByRole("region", { name: "Exact historical demand evidence" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  await expect(exact.locator("tbody tr")).toHaveCount(10);
  await expect(exact).toContainText("qualified");
  await expect(exact).toContainText("partial");
  await expect(exact).toContainText("unavailable");
  await evidence.capture("historical-context-exact-mobile-raw", exact);
  await withCssPixelAlignment(
    exact,
    async () => {
      await evidence.capture("historical-context-exact-mobile-aligned", exact);
      await expect(exact).toHaveScreenshot("historical-context-exact-mobile.png");
    },
    "floor",
    "layout",
  );
});
