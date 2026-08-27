import { expect, test } from "@playwright/test";

import { installMarketMechanicsApi } from "./market-mechanics-fixtures";
import { installMobileApi } from "./mobile-fixtures";

test("market mechanics is lazy, contextual, and selected-history only", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketMechanicsApi(page, requests);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "What changed with the price move?" });
  await expect(panel).toBeVisible();
  expect(requests).toEqual([]);

  await panel.getByRole("button", { name: "Load market-mechanics details" }).click();
  await expect(panel.getByText(/Exact SCED alignment/)).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toBe("/api/v1/market-mechanics");
  expect(requests[1]).toContain("market.sced.system-lambda");
  await expect(panel.getByRole("status")).toContainText("stale");
  await expect(
    panel.getByText(/Context, not a price decomposition or proof of cause/),
  ).toBeVisible();
  await expect(panel.getByText(/since prior coherent SCED \(300s\)/).first()).toBeVisible();
  await expect(panel.getByRole("region", { name: "System Lambda exact values" })).toBeVisible();
  const profile = panel.getByRole("img", { name: "System Lambda completed-day profile" });
  await expect(profile.locator("polyline")).toHaveCount(2);
  expect(
    await profile.locator("polyline").evaluateAll((lines) =>
      lines.map((line) =>
        line
          .getAttribute("points")!
          .split(" ")
          .map((point) => point.split(",")[0]),
      ),
    ),
  ).toEqual([
    ["0", "20"],
    ["80", "100"],
  ]);
  await expect(panel.getByRole("region", { name: "Energy signal" })).toHaveScreenshot(
    "market-mechanics-energy.png",
  );
  await expect(profile).toHaveScreenshot("market-mechanics-gap-profile.png");
  await expect(panel.getByRole("region", { name: "System Lambda exact values" })).toHaveScreenshot(
    "market-mechanics-history.png",
  );

  await panel.getByRole("button", { name: /Reg-Up adder/ }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toContain("market.sced.price-adder.regup");
  await expect(panel.getByRole("region", { name: "Reg-Up adder exact values" })).toBeVisible();
});
