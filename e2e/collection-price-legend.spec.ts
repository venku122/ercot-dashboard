import { test, expect } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
test("collection legend focus and restore works for independent display identity", async ({
  page,
}) => {
  await installMobileApi(page);
  await page.goto("/");
  const card = page.locator('[data-chart-id="pricing-collection"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  const houston = card.getByRole("button", { name: "Houston hub", exact: true });
  await houston.click();
  await expect(houston).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("button", { name: "North hub", exact: true })).toHaveClass(
    /legend-row-hidden/,
  );
  await houston.click();
  await expect(card.getByRole("button", { name: "North hub", exact: true })).not.toHaveClass(
    /legend-row-hidden/,
  );
});

test("collection focus reselect and restore affect only display series and make no history requests", async ({
  page,
}) => {
  const requests: string[][] = [];
  await installMobileApi(page, "normal", requests, { marketGeography: "enabled" });
  await page.goto("/?overviewPoint=HB_NORTH");
  const card = page.locator('[data-chart-id="pricing-collection"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  const native = page.locator('[data-chart-id="pricing"]');
  await expect(native.locator(".legend-latest")).toContainText("$18.00/MWh");
  const count = requests.length;
  const houston = card.getByRole("button", { name: "Houston hub", exact: true });
  const north = card.getByRole("button", { name: "North hub", exact: true });
  const west = card.getByRole("button", { name: "West hub", exact: true });
  await houston.click();
  await expect(houston).toHaveAttribute("aria-pressed", "true");
  await expect(north).toHaveClass(/legend-row-hidden/);
  await expect(west).toHaveClass(/legend-row-hidden/);
  await north.focus();
  await page.keyboard.press("Enter");
  await expect(north).toHaveAttribute("aria-pressed", "true");
  await expect(north).not.toHaveClass(/legend-row-hidden/);
  await expect(houston).toHaveClass(/legend-row-hidden/);
  await expect(west).toHaveClass(/legend-row-hidden/);
  await north.click();
  for (const button of [houston, north, west]) {
    await expect(button).not.toHaveClass(/legend-row-hidden/);
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByLabel("History point")).toHaveValue("HB_NORTH");
  await expect(native.locator(".legend-latest")).toContainText("$18.00/MWh");
  expect(requests).toHaveLength(count);
});
