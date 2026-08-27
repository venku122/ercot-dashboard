import { expect, test } from "@playwright/test";

import { installStorageContextReplayApi } from "./storage-context-replay-fixtures";

const replayFrequency = "storage-context-frequency:frequency:current";

test("storage context replay is collapsed-lazy, reuses storage, and preserves exact context", async ({
  page,
}) => {
  const batches: string[][] = [];
  const market: string[] = [];
  await installStorageContextReplayApi(page, "normal", batches, market);
  await page.goto("/?view=overview");
  expect(batches.flat()).not.toContain(replayFrequency);
  expect(market).toEqual([]);

  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  await expect(storage).toHaveAttribute("data-visible", "true");
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary).toBeVisible();
  await expect
    .poll(() => batches.flat().filter((id) => id.startsWith("storage:")))
    .toEqual([
      "storage:charging:current",
      "storage:discharging:current",
      "storage:net-output:current",
    ]);
  expect(batches.flat()).not.toContain(replayFrequency);
  expect(market).toEqual([]);

  await summary.getByRole("button", { name: "Open multi-cadence storage context replay" }).click();
  const replay = summary.getByRole("region", { name: "Multi-cadence storage context replay" });
  await expect(replay).toBeVisible();
  await expect
    .poll(() => batches.flat().filter((id) => id === replayFrequency))
    .toEqual([replayFrequency]);
  await expect.poll(() => market).toEqual(["/api/v1/market-mechanics"]);
  expect(batches.flat().filter((id) => id.startsWith("storage:"))).toEqual([
    "storage:charging:current",
    "storage:discharging:current",
    "storage:net-output:current",
  ]);

  await expect(replay.locator(".storage-context-lane")).toHaveCount(4);
  await expect(replay).toContainText("different timestamps and cadences are preserved");
  await expect(replay).toContainText(
    "timing alone does not establish attribution or operational intent",
  );
  await expect(replay).toContainText(
    "Source observations and deterministic derived window extrema",
  );
  await expect(replay).toContainText("Official annotations are unavailable");
  await expect(replay).toContainText("-18.75");
  await expect(replay).toHaveScreenshot("storage-context-replay-coherent.png");

  await replay.getByText("Exact observations and provenance").click();
  const exact = replay.getByRole("region", { name: "Storage context replay exact observations" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  await expect(exact.locator("tbody tr")).not.toHaveCount(0);
  await expect(exact).toContainText("collector_capture_time");
  await expect(exact).toContainText("source_epoch");
  await expect(exact).toContainText("322123");
  await expect(exact).toContainText("-18.75");
  await expect(exact).toHaveScreenshot("storage-context-replay-exact.png");
});

test("storage context replay labels retained degraded evidence without causal attribution", async ({
  page,
}) => {
  const batches: string[][] = [];
  const market: string[] = [];
  await installStorageContextReplayApi(page, "failed", batches, market);
  await page.goto("/?view=generation");
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await summary.getByRole("button", { name: "Open multi-cadence storage context replay" }).click();
  const replay = summary.getByRole("region", { name: "Multi-cadence storage context replay" });
  await expect(replay.getByText(/One or more sources are stale or unhealthy/)).toBeVisible();
  await expect(replay).toContainText("retained timestamps remain explicit");
  await expect(replay).not.toContainText(/caused by|responded to|resulted in/i);
  await expect(replay).toHaveScreenshot("storage-context-replay-degraded.png");
});
