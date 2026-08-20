import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";
import { installTexasGridApi } from "./texas-grid-fixtures";

test("Texas Grid navigation and exact evidence are contained on mobile @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installTexasGridApi(page, requests);
  await page.goto("/?view=overview");
  expect(requests).toEqual([]);

  await page.getByRole("button", { name: "More views" }).click();
  const more = page.getByRole("dialog", { name: "More views" });
  await more.getByRole("button").filter({ hasText: "Texas Grid" }).click();
  await expect(page).toHaveURL(/view=texas-grid/);
  const panel = page.getByRole("region", { name: "Texas Grid long-horizon evidence" });
  await expect(panel).toBeVisible();
  expect(requests).toEqual(["/api/v1/texas-grid"]);

  const open = panel.getByRole("button", { name: "Open capacity history" });
  const openBox = await open.boundingBox();
  expect(openBox).not.toBeNull();
  expect(openBox!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  const wind = panel.getByRole("button", { name: "Wind" });
  expect((await wind.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  const exact = panel.getByRole("region", {
    name: "Wind exact resource capacity trend evidence",
  });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  await expectNoHorizontalOverflow(page);
  expect(requests.filter((request) => request.startsWith("/api/v2/"))).toHaveLength(1);
});

test("Texas Grid has stable mobile evidence @mobile-vri", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installTexasGridApi(page, requests);
  await page.goto("/?view=texas-grid&grid_resource=resource_capacity_trend");
  const panel = page.getByRole("region", { name: "Texas Grid long-horizon evidence" });
  await expect(panel).toContainText("Source column absent");
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveScreenshot("texas-grid-mobile.png");
  await expect(
    panel.getByRole("region", { name: "Wind exact resource capacity trend evidence" }),
  ).toHaveScreenshot("texas-grid-exact-mobile.png");
});
