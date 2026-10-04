import { expect, test } from "@playwright/test";
import { installStorageOperationsApi } from "./storage-operations-fixtures";

test("optional storage interface code loads on Generation and remains usable in Inspect", async ({
  page,
}) => {
  const requests: string[][] = [];
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/StorageOperationsSummary-[^/]+\.js$/.test(new URL(request.url()).pathname))
      chunks.push(request.url());
  });
  await installStorageOperationsApi(page, "normal", requests);
  await page.goto("/");
  await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  expect(chunks).toEqual([]);
  await page.getByRole("button", { name: "Generation view" }).click();
  const storage = page.locator('[data-chart-id="storage"]');
  await storage.scrollIntoViewIfNeeded();
  const summary = storage.getByRole("region", { name: "Storage fleet operating summary" });
  await expect(summary).toContainText("System-wide dashboard aggregate only");
  await expect.poll(() => chunks.length).toBe(1);
  const sourceIds = requests.flat().filter((id) => id.startsWith("storage:"));
  expect(sourceIds).toEqual([
    "storage:charging:current",
    "storage:discharging:current",
    "storage:net-output:current",
  ]);
  await storage
    .getByRole("button", { name: "Open Energy storage resources inspect mode", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(storage).toHaveClass(/chart-card-inspect/);
  await expect(summary).toContainText("does not report state of charge");
  await page.keyboard.press("Escape");
  await expect(storage).not.toHaveClass(/chart-card-inspect/);
  expect(chunks).toHaveLength(1);
  expect(requests.flat().filter((id) => id.startsWith("storage:"))).toEqual(sourceIds);
});

test("operations interface code loads only when its keyboard-opened dialog is requested", async ({
  page,
}) => {
  const requests: string[][] = [];
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/OperationsTimeline-[^/]+\.js$/.test(new URL(request.url()).pathname))
      chunks.push(request.url());
  });
  await installStorageOperationsApi(page, "warning", requests);
  await page.goto("/");
  await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
  expect(chunks).toEqual([]);
  const trigger = page.getByRole("button", { name: /Operations messages ·/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Operations timeline" });
  await expect(dialog.getByLabel("Filter operations timeline by severity")).toBeVisible();
  await expect.poll(() => chunks.length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Filter operations timeline by severity")).toBeVisible();
  expect(chunks).toHaveLength(1);
});
