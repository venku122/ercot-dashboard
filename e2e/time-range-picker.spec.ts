import { expect, test } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";

const FIXED_NOW = new Date("2026-09-01T18:00:00-05:00");

async function openPicker(page: Parameters<typeof installMobileApi>[0]) {
  const trigger = page.getByRole("button", { name: "Choose time range" });
  await trigger.click();
  return page.getByRole("dialog", { name: "Time range" });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_NOW);
  await installMobileApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ERCOT Grid Status" })).toBeVisible();
});

test("semantic preset, pause, resume, calendar URL and reload round trip", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Choose time range" });
  let picker = await openPicker(page);
  await picker.getByRole("button", { name: "Past 1 hour" }).click();
  await expect(trigger).toContainText("Past 1 hour");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("relative");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("3600000");
  await expect.poll(() => new URL(page.url()).searchParams.get("live")).toBe("1");

  picker = await openPicker(page);
  await picker.getByRole("button", { name: "Pause" }).click();
  await expect(trigger).toContainText("Past 1 hour · Paused");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_play")).toBe("paused");
  const frozenTo = new URL(page.url()).searchParams.get("time_to_ms");

  picker = await openPicker(page);
  await picker.getByRole("button", { name: "Resume" }).click();
  await expect(trigger).toContainText("Past 1 hour");
  await expect(trigger).not.toContainText("Paused");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_play")).toBe("running");
  expect(frozenTo).not.toBeNull();

  picker = await openPicker(page);
  await picker.getByRole("button", { name: "Today" }).click();
  await expect(trigger).toContainText("Today");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("calendar");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("today");
  await page.reload();
  await expect(trigger).toContainText("Today");
});

test("custom draft is request-silent until Apply and Cancel restores focus", async ({ page }) => {
  const seriesRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/series") || path.includes("/api/v2/series")) {
      seriesRequests.push(request.url());
    }
  });
  await page.waitForTimeout(250);
  seriesRequests.length = 0;
  const trigger = page.getByRole("button", { name: "Choose time range" });
  let picker = await openPicker(page);
  await picker.getByLabel("From", { exact: true }).fill("2026-09-01T08:00");
  await picker.getByLabel("To", { exact: true }).fill("2026-09-01T10:13");
  await page.waitForTimeout(250);
  expect(seriesRequests).toEqual([]);
  await picker.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
  expect(seriesRequests).toEqual([]);

  picker = await openPicker(page);
  await picker.getByLabel("From", { exact: true }).fill("2026-09-01T08:00");
  await picker.getByLabel("To", { exact: true }).fill("2026-09-01T10:13");
  await picker.getByRole("button", { name: "Apply" }).click();
  await expect(trigger).toContainText("Custom · 2h 13m");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_origin")).toBe("custom");
});

test("keyboard and DST validation expose specific accessible recovery", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Choose time range" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  let picker = page.getByRole("dialog", { name: "Time range" });
  await expect(picker.getByRole("button", { name: "Close time range picker" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  picker = await openPicker(page);
  await picker.getByLabel("From", { exact: true }).fill("2026-03-08T02:30");
  await picker.getByLabel("To", { exact: true }).fill("2026-03-08T04:30");
  await picker.getByRole("button", { name: "Apply" }).click();
  await expect(picker.getByRole("alert")).toContainText("not a real local time because of DST");
  await expect(picker.getByLabel("From", { exact: true })).toHaveAttribute("aria-invalid", "true");

  await picker.getByLabel("From", { exact: true }).fill("2026-11-01T01:30");
  await picker.getByLabel("To", { exact: true }).fill("2026-11-01T03:30");
  await picker.getByRole("button", { name: "Apply" }).click();
  await expect(picker.getByRole("alert")).toContainText("earlier or later occurrence for From");
  await picker.getByLabel("From occurrence").selectOption("later");
  await picker.getByRole("button", { name: "Apply" }).click();
  await expect(trigger).toContainText("Custom · 2h");
});

test("twenty rapid commits settle on the final semantic URL without runaway requests", async ({
  page,
}) => {
  const errors: Error[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/api/series") || path.includes("/api/v2/series")) {
      requests.push(request.url());
    }
  });
  await page.waitForTimeout(250);
  requests.length = 0;
  for (let index = 0; index < 20; index += 1) {
    const picker = await openPicker(page);
    await picker
      .getByRole("button", { name: index % 2 === 0 ? "Past 1 hour" : "Past 6 hours" })
      .click();
  }
  await expect(page.getByRole("button", { name: "Choose time range" })).toContainText(
    "Past 6 hours",
  );
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("21600000");
  expect(errors).toEqual([]);
  expect(requests.length).toBeLessThanOrEqual(30);
});
