import { expect, test } from "@playwright/test";

import { installMarketGeographyApi } from "./market-geography-fixtures";
import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";

test("market geography meets mobile target and overflow contracts @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByRole("region", { name: "Settlement price exact values" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect.poll(() => requests.length).toBe(2);

  const viewportWidth = page.viewportSize()!.width;
  const violations: string[] = [];
  for (const control of await panel.locator("button").all()) {
    const box = await control.boundingBox();
    const name = (await control.innerText()).replaceAll(/\s+/g, " ").trim();
    if (!box || box.height < 44 || box.x < 0 || box.x + box.width > viewportWidth) {
      violations.push(
        `${name}: ${box ? `x=${box.x}, width=${box.width}, height=${box.height}` : "no box"}`,
      );
    }
  }
  expect(
    violations,
    "every market-geography control stays in-view and is at least 44px high",
  ).toEqual([]);
  expect(
    await panel
      .getByRole("region", { name: "Settlement price exact values" })
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await expect(
    panel.getByRole("region", { name: "Settlement price exact values" }),
  ).toHaveAttribute("tabindex", "0");
});

test("market geography has stable mobile evidence states @mobile-vri", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByRole("region", { name: "Settlement price exact values" })).toBeVisible();
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });

  await expect(
    panel.locator("section").filter({ hasText: "15-minute settlement-price matrix" }),
  ).toHaveScreenshot("market-geography-prices-mobile.png");
  await expect(
    panel.getByRole("img", { name: "Selected settlement point completed-day profile" }),
  ).toHaveScreenshot("market-geography-gap-profile-mobile.png");
  await expect(
    panel.getByRole("region", { name: "Selected market geography exact history" }),
  ).toHaveScreenshot("market-geography-history-mobile.png");

  await panel.getByRole("button", { name: "Coincident constraints" }).click();
  await expect(
    panel.getByRole("region", { name: "Coincident binding constraint exact values" }),
  ).toBeVisible();
  await expect(
    panel.locator("section").filter({ hasText: "Constraints binding in the same SCED as LMP" }),
  ).toHaveScreenshot("market-geography-constraints-mobile.png");
});
