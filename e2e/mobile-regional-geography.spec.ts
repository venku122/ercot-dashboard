import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";
import { installRegionalGeographyApi } from "./regional-geography-fixtures";

test("regional geography meets mobile target and overflow contracts @mobile-core", async ({
  page,
}, testInfo) => {
  const regionalRequests: string[] = [];
  await installMobileApi(page);
  await installRegionalGeographyApi(page, regionalRequests);
  await page.goto("/?view=generation");
  const panel = page.getByRole("region", { name: "Regional load and renewable outlook" });
  await panel.getByRole("button", { name: "Load regional details" }).click();
  await expect(
    panel.getByRole("heading", { name: "ERCOT region schematic — not geographic boundaries" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect.poll(() => regionalRequests.length).toBe(3);
  expect(regionalRequests[0]).toBe("/api/v1/regional-geography");
  expect(regionalRequests[1]).toContain("regional.load.weather-zone.coast.actual");
  expect(regionalRequests[2]).toContain("regional.load.weather-zone.coast.forecast");
  const viewportWidth = page.viewportSize()!.width;
  for (const control of await panel.locator("button").all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? viewportWidth) + (box?.width ?? 1)).toBeLessThanOrEqual(viewportWidth);
  }
  expect(
    await panel
      .locator(".regional-schematic")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  if (testInfo.project.name === "iphone-pro-max-webkit") {
    await page.locator(".mobile-section-nav").evaluate((element) => {
      (element as HTMLElement).style.visibility = "hidden";
    });
    await expect(panel).toHaveScreenshot("regional-geography-mobile.png");
  }
});
