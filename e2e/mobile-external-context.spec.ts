import { expect, test } from "@playwright/test";

import { installExternalContextApi } from "./external-context-fixtures";
import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";

test("External Context navigation and exact evidence are contained on mobile @mobile-core", async ({
  page,
}) => {
  await installMobileApi(page);
  await installExternalContextApi(page);
  await page.goto("/?view=overview");

  await page.getByRole("button", { name: "More views" }).click();
  const more = page.getByRole("dialog", { name: "More views" });
  await more.getByRole("button").filter({ hasText: "External Context" }).click();
  await expect(page).toHaveURL(/view=external-context/);
  const panel = page.getByRole("region", { name: "External energy and emissions context" });
  await expect(panel).toBeVisible();

  const open = panel.getByRole("button", { name: "Open eGRID evidence" });
  const openBox = await open.boundingBox();
  expect(openBox).not.toBeNull();
  expect(openBox!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  const exact = panel.getByRole("region", { name: "Exact eGRID ERCT annual rate evidence" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  await expectNoHorizontalOverflow(page);
});

test("External Context has stable mobile no-key and eGRID evidence @mobile-vri", async ({
  page,
}) => {
  await installMobileApi(page);
  await installExternalContextApi(page);
  await page.goto("/?view=external-context&context_source=epa_egrid");
  const panel = page.getByRole("region", { name: "External energy and emissions context" });
  await expect(panel).toContainText("Data year 2023 · revision 2");
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveScreenshot("external-context-mobile.png");
  await expect(
    panel.getByRole("region", { name: "Exact eGRID ERCT annual rate evidence" }),
  ).toHaveScreenshot("external-context-exact-mobile.png");
});
