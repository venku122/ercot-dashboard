import { expect, test } from "@playwright/test";

import {
  parseMarketGeographyManifest,
  parseMarketGeographyResource,
} from "../frontend/src/dashboard/market-geography";

import {
  installMarketGeographyApi,
  MARKET_GEOGRAPHY_CONSTRAINT,
} from "./market-geography-fixtures";
import { installMobileApi } from "./mobile-fixtures";

test("market geography is contextual, lazy, selected-only, exact, and noncausal", async ({
  page,
}) => {
  const requests: string[] = [];
  const responses = new Map<string, unknown>();
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (path.includes("/api/v1/market-geography") || path.includes("/api/v2/market-geography/")) {
      responses.set(path, await response.json());
    }
  });
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests);

  await page.goto("/");
  expect(requests).toEqual([]);
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await expect(panel).toBeVisible();
  expect(requests).toEqual([]);

  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByRole("region", { name: "Settlement price exact values" })).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual([
    "/api/v1/market-geography",
    expect.stringContaining("/prices/HB_HOUSTON--HU/"),
  ]);
  await expect.poll(() => responses.size).toBe(2);
  const parsedManifest = parseMarketGeographyManifest(responses.get("/api/v1/market-geography"));
  const houstonLink = parsedManifest.resources.find(
    (link) => link.kind === "prices" && link.identity === "HB_HOUSTON--HU",
  )!;
  expect(() =>
    parseMarketGeographyResource(responses.get(houstonLink.url), houstonLink),
  ).not.toThrow();
  await expect(panel.getByText(/not Texas coordinates or boundaries/)).toBeVisible();
  await expect(
    panel.getByText(/not a geographic boundary map or a causal price decomposition/),
  ).toBeVisible();
  await expect(panel.locator(".market-price-matrix button")).toHaveCount(15);
  await expect(
    panel.getByRole("region", { name: "Settlement price exact values" }).locator("tbody tr"),
  ).toHaveCount(15);
  await expect(panel.getByRole("button", { name: /Houston HU, -\$42\.16\/MWh/ })).toBeVisible();
  const profile = panel.getByRole("img", {
    name: "Selected settlement point completed-day profile",
  });
  await expect(profile.locator("polyline")).toHaveCount(2);
  await expect(
    panel.locator("section").filter({ hasText: "15-minute settlement-price matrix" }),
  ).toHaveScreenshot("market-geography-prices.png");
  await expect(
    panel.getByRole("region", { name: "Selected market geography exact history" }),
  ).toHaveScreenshot("market-geography-history.png");

  await panel.getByRole("button", { name: /^West LZ,/ }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toContain("/prices/LZ_WEST--LZ/");
  await expect(page).toHaveURL(/marketPoint=LZ_WEST--LZ/);

  await panel.getByRole("button", { name: "Coincident constraints" }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3]).toContain(`/constraints/${MARKET_GEOGRAPHY_CONSTRAINT}/`);
  await expect(
    panel.getByText(/do not establish contribution to any displayed point price/),
  ).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Coincident binding constraint exact values" }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole("region", { name: "Coincident binding constraint exact values" })
      .locator("tbody tr"),
  ).toHaveCount(1);

  await expect(
    panel.locator("section").filter({ hasText: "Constraints binding in the same SCED as LMP" }),
  ).toHaveScreenshot("market-geography-constraints.png");
});

test("market geography restores layer and selection through browser history", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests);
  await page.goto("/?view=market&marketLayer=prices&marketPoint=HB_HOUSTON--HU");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByRole("button", { name: /^Houston HU,/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await panel.getByRole("button", { name: /^West LZ,/ }).click();
  await panel.getByRole("button", { name: "Coincident constraints" }).click();
  await expect(page).toHaveURL(/marketLayer=constraints/);
  await expect(page).toHaveURL(new RegExp(`marketConstraint=${MARKET_GEOGRAPHY_CONSTRAINT}`));

  await page.goBack();
  await expect(panel.getByRole("button", { name: "Settlement prices" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(panel.getByRole("button", { name: /^West LZ,/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goForward();
  await expect(panel.getByRole("button", { name: "Coincident constraints" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("market geography exposes partial and stale evidence without borrowing values", async ({
  page,
}) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests, { partial: true, stale: true });
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByText(/source or history pipelines are stale/)).toBeVisible();
  await expect(panel.getByText(/Partial publication: missing LZ_WEST--LZ/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /West LZ, not reported/ })).toContainText(
    "Not reported",
  );
  await expect(
    panel.getByRole("region", { name: "Settlement price exact values" }).locator("tbody tr"),
  ).toHaveCount(14);
});

test("market geography names durable official document gaps", async ({ page }) => {
  const requests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, requests, { gapCount: 2 });
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByText(/source or history pipelines are stale/)).toBeVisible();
  await panel.getByText("Source provenance and freshness").click();
  await expect(panel.getByText(/2 official document gaps recorded/)).toBeVisible();
});

test("market geography exposes manifest and selected-history failures", async ({ page }) => {
  const manifestRequests: string[] = [];
  await installMobileApi(page);
  await installMarketGeographyApi(page, manifestRequests, { manifestError: true });
  await page.goto("/?view=market");
  const panel = page.getByRole("region", { name: "Where are prices diverging?" });
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByText("Temporarily unavailable…")).toBeVisible();

  const historyRequests: string[] = [];
  await page.unrouteAll({ behavior: "wait" });
  await installMobileApi(page);
  await installMarketGeographyApi(page, historyRequests, { historyError: true });
  await page.reload();
  await panel.getByRole("button", { name: "Load price-geography details" }).click();
  await expect(panel.getByText("Selected history is unavailable.")).toBeVisible();
  await expect(panel.getByRole("region", { name: "Settlement price exact values" })).toBeVisible();
});
