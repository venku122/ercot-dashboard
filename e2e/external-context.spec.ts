import { expect, test } from "@playwright/test";

import { installExternalContextApi } from "./external-context-fixtures";
import { installMobileApi } from "./mobile-fixtures";

test("External Context is lazy, no-key honest, selected-only, exact, and URL-restorable", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requests.push(path);
  });
  await installMobileApi(page);
  await installExternalContextApi(page);

  await page.goto("/?view=overview");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("region", { name: "External energy and emissions context" }),
  ).toHaveCount(0);
  expect(requests.filter((path) => path.includes("external-context"))).toEqual([]);

  requests.length = 0;
  await page.goto("/?view=external-context");
  const panel = page.getByRole("region", { name: "External energy and emissions context" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("not ERCOT operational authority or live emissions");
  await expect(panel).toContainText("individual EIA API key not configured");
  await expect(panel).toContainText("This is not a zero-emissions series");
  await expect(page.getByLabel("Global dashboard controls")).toHaveCount(0);
  expect(requests).toEqual(["/api/v1/external-context"]);
  await expect(panel.getByRole("button", { name: "Open EIA-930 evidence" })).toBeDisabled();

  await panel.getByRole("button", { name: "Open eGRID evidence" }).click();
  await expect(page).toHaveURL(/context_source=epa_egrid/);
  await expect(panel).toContainText("Data year 2023 · revision 2");
  await expect(panel).toContainText("not current or marginal emissions");
  const exact = panel.getByRole("region", { name: "Exact eGRID ERCT annual rate evidence" });
  await expect(exact.locator("tbody tr")).toHaveCount(7);
  await expect(exact).toContainText("818.7");
  expect(requests).toEqual([
    "/api/v1/external-context",
    expect.stringMatching(/^\/api\/v2\/external-context\/epa_egrid\/v1\/xc1-/),
  ]);
  await expect(panel).toHaveScreenshot("external-context-egrid-desktop.png");

  await page.reload();
  await expect(panel).toContainText("818.7");
  await panel.getByRole("button", { name: "Close eGRID evidence" }).click();
  await expect(page).not.toHaveURL(/context_source=/);
  await page.goBack();
  await expect(page).toHaveURL(/context_source=epa_egrid/);
  await expect(panel).toContainText("Exact eGRID publication identity");

  await page.goto("/?view=generation");
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/context_source=/);
});
