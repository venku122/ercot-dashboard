import { expect, test } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";

const FIXED_NOW = new Date("2026-09-01T18:00:00-05:00");

async function openPicker(page: Parameters<typeof installMobileApi>[0]) {
  const trigger = page.getByRole("button", { name: "Choose time range" });
  await trigger.click();
  return page.getByRole("dialog", { name: "Time range" });
}

function isTimeSeriesRequest(url: string): boolean {
  const path = new URL(url).pathname;
  return (
    path.includes("/api/series") ||
    path.includes("/api/v1/series/chunk") ||
    path.includes("/api/v2/tiles")
  );
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
    if (isTimeSeriesRequest(request.url())) seriesRequests.push(request.url());
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

test("desktop outside dismissal prevents competing dashboard dialogs", async ({ page }) => {
  await openPicker(page);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Analyze" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("closed calendar ranges offer a working return to live", async ({ page }) => {
  for (const preset of ["Yesterday", "Previous week", "Previous month"]) {
    let picker = await openPicker(page);
    await picker.getByRole("button", { name: preset, exact: true }).click();
    picker = await openPicker(page);
    await expect(picker.getByRole("button", { name: "Resume live" })).toBeVisible();
    await picker.getByRole("button", { name: "Resume live" }).click();
    await expect(page.getByRole("button", { name: "Choose time range" })).toContainText(
      "Past 6 hours",
    );
  }
});

test("legacy fixed links canonicalize safely and browser history restores semantic time", async ({
  page,
}) => {
  const from = Math.floor(FIXED_NOW.getTime() / 1000) - 7_980;
  const to = Math.floor(FIXED_NOW.getTime() / 1000);
  await page.goto(`/?range=7980&live=0&from=${from}&to=${to}&view=market&foreign=kept`);
  const trigger = page.getByRole("button", { name: "Choose time range" });
  await expect(trigger).toContainText("Custom · 2h 13m");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("fixed");
  expect(new URL(page.url()).searchParams.get("foreign")).toBe("kept");

  await page.goto(
    "/?time_kind=relative&time_value=3600000&time_preset=past-1-hour&time_tz=America%2FChicago&time_play=running&foreign=new",
  );
  await expect(trigger).toContainText("Past 1 hour");
  await page.goBack();
  await expect(trigger).toContainText("Custom · 2h 13m");
  expect(new URL(page.url()).searchParams.get("foreign")).toBe("kept");
});

test("twenty rapid commits settle on the final semantic URL without runaway requests", async ({
  page,
}) => {
  const errors: Error[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error));
  page.on("request", (request) => {
    if (isTimeSeriesRequest(request.url())) requests.push(request.url());
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

test("a delayed obsolete chart response cannot replace the latest committed window", async ({
  page,
}) => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let controlledRequests = 0;
  await page.route("**/api/series/batch", async (route) => {
    const payload = route.request().postDataJSON() as {
      queries: Array<{ id: string; metric: string; since: number; until: number }>;
    };
    if (!payload.queries.some((query) => query.id === "supply-demand:demand:current")) {
      await route.fallback();
      return;
    }
    controlledRequests += 1;
    const generation = controlledRequests;
    if (generation === 1) await firstGate;
    const value = generation === 1 ? 11_111 : 22_222;
    try {
      await route.fulfill({
        json: {
          series: payload.queries.map((query) => ({
            id: query.id,
            meta: { latest: value },
            metric: query.metric,
            points: [
              [query.since, value],
              [query.until, value],
            ],
          })),
        },
      });
    } catch {
      // The obsolete request may already be aborted by the browser.
    }
  });

  let picker = await openPicker(page);
  await picker.getByRole("button", { name: "Past 1 hour" }).click();
  await expect.poll(() => controlledRequests).toBeGreaterThanOrEqual(1);
  const beforeSecondCommit = controlledRequests;
  picker = await openPicker(page);
  await picker.getByRole("button", { name: "Past 12 hours" }).click();
  await expect.poll(() => controlledRequests).toBeGreaterThan(beforeSecondCommit);
  await expect(
    page.locator('[data-chart-id="supply-demand"] .legend-latest').first(),
  ).toContainText("22.2 GW");
  releaseFirst();
  await page.waitForTimeout(200);
  await expect(
    page.locator('[data-chart-id="supply-demand"] .legend-latest').first(),
  ).toContainText("22.2 GW");
  await expect(page.getByRole("button", { name: "Choose time range" })).toContainText(
    "Past 12 hours",
  );
});
