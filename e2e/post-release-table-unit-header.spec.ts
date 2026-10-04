import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

test("displayed table header agrees with mixed MW/GW cells and preserves raw CSV", async ({
  page,
}) => {
  await installMobileApi(page, "normal");
  await page.route("**/api/v2/tile-catalog**", (route) =>
    route.fulfill({ status: 404, json: { error: "explicit_v1_source_fixture" } }),
  );
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as {
      queries: Array<{ id: string; since: number; until: number }>;
    };
    if (!body.queries.some((query) => query.id === "supply-demand:demand:current"))
      return route.fallback();
    await route.fulfill({
      json: {
        series: body.queries.map((query) => ({
          id: query.id,
          points: query.id.startsWith("supply-demand:")
            ? [
                [query.since + 300, 900],
                [query.since + 600, 68300],
              ]
            : [],
          meta: { since: query.since, until: query.until, bucket_seconds: 300 },
        })),
      },
    });
  });
  await page.goto("/?range=21600&live=1&legend=expanded");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.locator(".legend-table caption")).toContainText("Source unit: MW.");
  await expect(card.locator(".legend-table caption")).toContainText(
    "Displayed values include their units.",
  );
  await expect(card.locator(".legend-table caption")).not.toContainText("Values in MW.");
  await card.getByText("Accessible data table", { exact: true }).click();
  const table = card.getByRole("region", { name: "Supply and demand displayed source data" });
  await expect(table.getByRole("cell", { name: "900.0 MW", exact: true }).first()).toBeVisible();
  await expect(table.getByRole("cell", { name: "68.3 GW", exact: true }).first()).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Displayed value", exact: true }),
  ).toBeVisible();
  await expect(
    card.locator("details").getByText("Source unit: MW.", { exact: false }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await card.getByLabel(/chart menu/).click();
  await card.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
  const { readFile } = await import("node:fs/promises");
  const csv = await readFile((await (await downloadPromise).path())!, "utf8");
  expect(csv).toMatch(/,900\n/);
  expect(csv).toMatch(/,68300\n/);
  expect(csv).not.toContain("68.3 GW");
});

test("native price table displayed units and raw interval CSV agree", async ({ page }) => {
  await installMobileApi(page, "normal", [], { marketGeography: "enabled" });
  await page.goto("/?overviewPoint=HB_NORTH");
  const card = page.locator('[data-chart-id="pricing"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await card.getByText("Accessible data table", { exact: true }).click();
  const table = card.getByRole("region", {
    name: "North Hub · NP6-905 settlement price displayed source data",
  });
  await expect(table.getByRole("cell", { name: "$18.00/MWh", exact: true })).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Displayed value", exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Source unit: $/MWh.", { exact: false })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await card.getByLabel(/chart menu/).click();
  await card.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
  const { readFile } = await import("node:fs/promises");
  const csv = await readFile((await (await downloadPromise).path())!, "utf8");
  expect(csv).toContain(',18,"$/MWh",');
});
