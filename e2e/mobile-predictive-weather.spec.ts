import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./mobile-fixtures";
import { installPredictiveWeatherApi } from "./predictive-weather-fixtures";

test("predictive weather is contained and keyboard-reachable on mobile @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installPredictiveWeatherApi(page, requests);
  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Predictive weather at representative points" });
  const toggle = panel.getByRole("button", { name: "Show predictive weather" });
  const box = await toggle.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect.poll(() => requests).toEqual(["/api/v1/predictive-weather"]);
  await expectNoHorizontalOverflow(page);

  await panel.getByText("Exact NWS forecast intervals").click();
  const exact = panel.getByRole("region", {
    name: "Dallas/Fort Worth exact NWS forecast intervals",
  });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  await panel.getByText("Exact NWS alert evidence").click();
  const alertEvidence = panel.getByRole("region", { name: "Exact Texas NWS alert evidence" });
  await expect(alertEvidence).toHaveAttribute("tabindex", "0");
  expect(await alertEvidence.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  await expectNoHorizontalOverflow(page);
});

test("predictive weather has stable mobile evidence @mobile-vri", async ({ page }) => {
  const requests: string[] = [];
  await installPredictiveWeatherApi(page, requests);
  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Predictive weather at representative points" });
  await panel.getByRole("button", { name: "Show predictive weather" }).click();
  await expect(panel).toContainText("High Wind Warning for North Texas");
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await expect(panel).toHaveScreenshot("predictive-weather-mobile.png");
  await panel.getByText("Exact NWS forecast intervals").click();
  await expect(
    panel.getByRole("region", { name: "Dallas/Fort Worth exact NWS forecast intervals" }),
  ).toHaveScreenshot("predictive-weather-exact-mobile.png");
});
