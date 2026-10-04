import { expect, test } from "@playwright/test";
import { installStorageContextReplayApi } from "./storage-context-replay-fixtures";

for (const basis of ["legacy", "split"] as const) {
  test(`storage replay preserves exact ${basis} market basis without mixing Lambda`, async ({
    page,
  }) => {
    await installStorageContextReplayApi(page, "normal", [], [], basis);
    await page.goto("/?view=generation");
    const storage = page.locator('[data-chart-id="storage"]');
    await storage.scrollIntoViewIfNeeded();
    const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
    await summary
      .getByRole("button", { name: "Open multi-cadence storage context replay" })
      .click();
    const replay = summary.getByRole("region", { name: "Multi-cadence storage context replay" });
    await expect(replay).toContainText("-18.75");
    const title = basis === "legacy" ? "System Lambda" : "Capped System Lambda";
    await expect(
      replay.getByRole("heading", { name: `${title} ($/MWh)`, exact: true }),
    ).toBeVisible();
    await replay.getByText("Exact observations and provenance").click();
    const exact = replay.getByRole("region", { name: "Storage context replay exact observations" });
    await expect(exact.locator("tbody tr")).toHaveCount(208);
    const lambdaRows = exact
      .locator("tbody tr")
      .filter({ has: page.locator("td", { hasText: title }) });
    await expect(lambdaRows).toHaveCount(4);
    await expect(lambdaRows.nth(1)).toContainText("-18.75");
    await expect(lambdaRows.first()).toContainText("NP6-322-CD; document 322123");
    await expect(lambdaRows.first()).toContainText("raw SCED");
    await expect(exact).not.toContainText("Uncapped");
    await expect(replay).not.toContainText("Lambda parity: match");
    await page.screenshot({
      path: `/tmp/ercot-post-release-2026-10/storage-basis-${basis}.png`,
      fullPage: true,
    });
  });
}
