import { expect, test } from "@playwright/test";
import { observeVisualSources } from "./vri-source-evidence";
import { withCssPixelAlignment } from "./screenshot-alignment";

import { installHistoricalContextApi } from "./historical-context-fixtures";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const AS_OF = Math.floor(FIXED_NOW_SECONDS / 3_600) * 3_600;
const FIXED_URL = `/?view=overview&live=0&from=${String(AS_OF - 21_600)}&to=${String(AS_OF)}&range=21600`;

test("historical context is Overview-only, explicitly collapsible, exact, and URL-restorable", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installHistoricalContextApi(page, requests);
  await page.goto(`${FIXED_URL}&history=0`);
  const panel = page.getByRole("region", { name: "Historical context and records" });
  await expect(panel).toBeVisible();
  expect(requests).toEqual([]);

  await panel.getByRole("button", { name: "Historical context and records" }).click();
  await expect(page).toHaveURL(/history=1/);
  await expect.poll(() => requests).toHaveLength(1);
  expect(requests[0]).toBe(
    `/api/v1/historical-context?series_key=supply-demand.demand&as_of=${String(AS_OF)}`,
  );
  await expect(panel).toContainText("75.3 GW");
  await expect(panel).toContainText("Previous local day, same hour");
  await expect(panel).toContainText("Type 7");
  await expect(panel).toContainText("not a forecast or an all-time ERCOT record");
  await expect(
    panel.getByRole("region", { name: "Exact historical demand evidence" }).locator("tbody tr"),
  ).toHaveCount(10);
  await expect(page.getByLabel("Derived grid metrics")).not.toContainText("Price Percentile");
  await expect(page.getByLabel("Derived grid metrics")).not.toContainText("Historical Comparison");
  expect(requests.filter((request) => request.startsWith("/api/v2/"))).toEqual([]);

  await panel.getByRole("button", { name: "Historical context and records" }).click();
  await expect(page).not.toHaveURL(/history=1/);
  await page.goto(`${FIXED_URL}&history=1`);
  await expect(panel.getByRole("button", { name: "Historical context and records" })).toBeVisible();
  await page.goBack();
  await expect(panel.getByRole("button", { name: "Historical context and records" })).toBeVisible();
  await page.goForward();
  await expect(panel.getByRole("button", { name: "Historical context and records" })).toBeVisible();
  await expect(panel).toContainText("75.3 GW");
  const evidence = observeVisualSources(page, { contextOnly: true });
  await page.reload();
  await expect(panel).toContainText("75.3 GW");
  // Keep a retained pointer from hovering a disclosure after navigation/scroll.
  await page.mouse.move(0, 0);
  await evidence.capture("historical-context-desktop-raw", panel);
  await withCssPixelAlignment(
    panel,
    async () => {
      await evidence.capture("historical-context-desktop-aligned", panel);
      await expect(panel).toHaveScreenshot("historical-context-desktop.png");
    },
    "floor",
    "layout",
  );
  await evidence.stop();

  await page.goto("/?view=generation&history=1");
  await expect(panel).toHaveCount(0);
  await page.goto(FIXED_URL);
  await expect(
    panel.getByRole("button", { name: "Historical context and records" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(panel).not.toContainText("75.3 GW");
});
