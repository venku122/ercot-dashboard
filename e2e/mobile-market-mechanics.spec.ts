import { expect, test } from "@playwright/test";

import { installMarketMechanicsApi } from "./market-mechanics-fixtures";
import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";

test("market mechanics meets mobile target and overflow contracts @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketMechanicsApi(page, requests);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "What changed with the price move?" });
  await panel.getByRole("button", { name: "Load market-mechanics details" }).click();
  await expect(panel.getByText(/Exact SCED alignment/)).toBeVisible();
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
    "every market-mechanics control stays in-view and is at least 44px high",
  ).toEqual([]);
  expect(
    await panel
      .getByRole("region", { name: "System Lambda exact values" })
      .evaluate((element) => element.scrollWidth >= element.clientWidth),
  ).toBe(true);
});

test("market mechanics has a stable mobile evidence state @mobile-vri", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketMechanicsApi(page, requests);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "What changed with the price move?" });
  await panel.getByRole("button", { name: "Load market-mechanics details" }).click();
  await expect(panel.getByText(/Exact SCED alignment/)).toBeVisible();
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await expect(panel.getByRole("region", { name: "Energy signal" })).toHaveScreenshot(
    "market-mechanics-energy-mobile.png",
  );
  await expect(
    panel.getByRole("img", { name: "System Lambda completed-day profile" }),
  ).toHaveScreenshot("market-mechanics-gap-profile-mobile.png");
  await expect(panel.getByRole("region", { name: "System Lambda exact values" })).toHaveScreenshot(
    "market-mechanics-history-mobile.png",
  );
});
