import { expect, test } from "@playwright/test";

import { installPredictiveWeatherApi } from "./predictive-weather-fixtures";

test("predictive weather is collapsed-lazy and preserves exact noncausal evidence", async ({
  page,
}) => {
  const requests: string[] = [];
  await installPredictiveWeatherApi(page, requests);
  await page.goto("/?view=overview");
  expect(requests).toEqual([]);

  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Predictive weather at representative points" });
  await expect(panel).toBeVisible();
  expect(requests).toEqual([]);
  await panel.getByRole("button", { name: "Show predictive weather" }).click();
  await expect.poll(() => requests).toEqual(["/api/v1/predictive-weather"]);
  await expect(panel).toContainText("NWS forecast at representative airport points");
  await expect(panel).toContainText("Texas statewide, not ERCOT footprint");
  await expect(panel).toContainText("not an ERCOT grid alert, EEA, or conservation status");
  await expect(panel).toContainText("does not establish attribution");
  await expect(panel).not.toContainText(
    /weather caused|weather drove|weather driver|weather triggered/i,
  );
  await expect(panel).toContainText("Dashboard derived: forecast at or below freezing");
  await expect(panel).toContainText("Official NWS · Severe");
  await expect(panel).toHaveScreenshot("predictive-weather-context.png");

  await panel.getByText("Exact NWS forecast intervals").click();
  const exact = panel.getByRole("region", {
    name: "Dallas/Fort Worth exact NWS forecast intervals",
  });
  await expect(exact).toHaveAttribute("tabindex", "0");
  await expect(exact.locator("tbody tr")).toHaveCount(6);
  await expect(exact).toContainText("Official NWS");
  await expect(exact).toContainText("-2.0 °C");
  await expect(exact).toHaveScreenshot("predictive-weather-exact.png");
  await panel.getByText("Exact NWS alert evidence").click();
  const alertEvidence = panel.getByRole("region", { name: "Exact Texas NWS alert evidence" });
  await expect(alertEvidence).toHaveAttribute("tabindex", "0");
  await expect(alertEvidence).toContainText("urn:oid:wind-acceptance");
  await expect(alertEvidence).toContainText("Severe / Likely / Expected");
});

test("predictive weather distinguishes a valid empty Texas alert collection", async ({ page }) => {
  const requests: string[] = [];
  await installPredictiveWeatherApi(page, requests, true);
  await page.goto("/?view=outlook");
  const panel = page.getByRole("region", { name: "Predictive weather at representative points" });
  await panel.getByRole("button", { name: "Show predictive weather" }).click();
  await expect(panel).toContainText("No active Texas NWS alerts in the latest valid collection");
  await expect(panel).not.toContainText("Texas NWS alert evidence is unavailable");
});
