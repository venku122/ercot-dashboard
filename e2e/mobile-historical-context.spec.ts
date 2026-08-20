import { expect, test } from "@playwright/test";

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
    `/?view=overview&live=0&from=${String(AS_OF - 21_600)}&to=${String(AS_OF)}&range=21600`,
  );
  const panel = page.getByRole("region", { name: "Historical context and records" });
  const toggle = panel.getByRole("button", { name: "Open historical context and records" });
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
  await expect(panel).toHaveScreenshot("historical-context-mobile.png");
  await expect(
    panel.getByRole("region", { name: "Exact historical demand evidence" }),
  ).toHaveScreenshot("historical-context-exact-mobile.png");
});
