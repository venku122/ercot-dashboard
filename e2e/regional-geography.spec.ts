import { expect, test } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";
import { installRegionalGeographyApi } from "./regional-geography-fixtures";

test("regional geography is lazy, source-truthful, keyboard operable, and selected-history only", async ({
  page,
}) => {
  const regionalRequests: string[] = [];
  await installMobileApi(page);
  await installRegionalGeographyApi(page, regionalRequests);
  await page.goto("/?view=generation&regionalLayer=wind&regionalRegion=coastal");
  const panel = page.getByRole("region", { name: "Regional load and renewable outlook" });
  await expect(panel).toBeVisible();
  expect(regionalRequests).toEqual([]);

  await panel.getByRole("button", { name: "Load regional details" }).click();
  await expect(
    panel.getByRole("heading", { name: "ERCOT region schematic — not geographic boundaries" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /coastal, Wind regions/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => regionalRequests.length).toBe(2);
  expect(regionalRequests[0]).toBe("/api/v1/regional-geography");
  expect(regionalRequests[1]).toContain("regional.wind.coastal.hourly");
  await expect(panel.getByRole("status")).toContainText("stale");
  await expect(panel.getByText(/Forecast error unavailable/)).toBeVisible();
  await expect(panel.getByRole("table", { name: /coastal hourly history/i })).toBeVisible();
  await expect(panel).toHaveScreenshot("regional-geography-populated.png");

  const coastal = panel.getByRole("button", { name: /coastal, Wind regions/ });
  await coastal.focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("button", { name: /south, Wind regions/ })).toBeFocused();
  await expect.poll(() => regionalRequests.length).toBe(3);
  expect(regionalRequests[2]).toContain("regional.wind.south.hourly");
});
