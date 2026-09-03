import { expect, test, type Page } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";

const FIXED_NOW = new Date("2026-09-01T18:00:00-05:00");
const editor = (page: Page) => page.getByRole("combobox", { name: "Time range picker" });

async function openPicker(page: Page) {
  await editor(page).click();
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

test("preset, playback, navigation, URL and reload preserve semantic time", async ({ page }) => {
  let picker = await openPicker(page);
  await picker.getByRole("option", { name: /Past 1 hour/ }).click();
  await expect(editor(page)).toHaveValue("Past 1 Hour");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("3600000");

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("time_play")).toBe("paused");
  const pausedFrom = new URL(page.url()).searchParams.get("time_from_ms");
  const pausedTo = new URL(page.url()).searchParams.get("time_to_ms");
  await page.reload();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("time_from_ms")).toBe(pausedFrom);
  expect(new URL(page.url()).searchParams.get("time_to_ms")).toBe(pausedTo);
  await page.getByRole("button", { name: "Play" }).click();
  await page.getByRole("button", { name: "Step back" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("fixed");
  await page.getByRole("button", { name: "Step forward" }).click();

  await openPicker(page);
  await editor(page).fill("Today");
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("Today");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("today");
  await page.reload();
  await expect(editor(page)).toHaveValue("Today");
});

test("invalid and valid drafts are request-silent until Enter", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isTimeSeriesRequest(request.url())) requests.push(request.url());
  });
  await page.waitForTimeout(250);
  requests.length = 0;

  await openPicker(page);
  const beforeInvalidUrl = page.url();
  await editor(page).fill("Sep 1, 2026, 8:00 am - nope");
  await page.waitForTimeout(150);
  expect(requests).toEqual([]);
  await editor(page).press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(requests).toEqual([]);
  expect(page.url()).toBe(beforeInvalidUrl);

  await editor(page).fill("Sep 1, 2026, 8:00 am - Sep 1, 2026, 10:13 am");
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("Sep 1, 2026, 8:00 AM – Sep 1, 2026, 10:13 AM");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_origin")).toBe("custom");
  expect(requests.length).toBeGreaterThan(0);
});

test("keyboard, Escape focus restoration, and DST recovery are accessible", async ({ page }) => {
  await editor(page).focus();
  await editor(page).press("Enter");
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeHidden();

  await openPicker(page);
  await editor(page).fill("Mar 8, 2026, 2:30 am - Mar 8, 2026, 4:30 am");
  await editor(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "does not exist because of a daylight-saving transition",
  );

  await editor(page).fill("Nov 1, 2026, 1:30 am - Nov 1, 2026, 3:30 am");
  await editor(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("earlier or later");
  await page.getByRole("button", { name: "Later" }).click();
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeHidden();
  expect(new URL(page.url()).searchParams.get("time_from_ms")).toBe(
    String(Date.parse("2026-11-01T01:30:00-06:00")),
  );
  expect(new URL(page.url()).searchParams.get("time_to_ms")).toBe(
    String(Date.parse("2026-11-01T03:30:00-06:00")),
  );
});

test("keyboard-only combobox traverses and commits a preset @keyboard", async ({ page }) => {
  await editor(page).focus();
  await editor(page).press("Enter");
  await editor(page).press("ArrowDown");
  const activeId = await editor(page).getAttribute("aria-activedescendant");
  expect(activeId).not.toBeNull();
  await expect(page.locator(`#${activeId}`)).toHaveAttribute("aria-selected", "true");
  await editor(page).press("Enter");
  await expect(editor(page)).toHaveValue("Past 12 Hours");
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeHidden();
});

test("More sidecar and two-date calendar match documented state transitions", async ({ page }) => {
  const picker = await openPicker(page);
  await picker.getByRole("option", { name: "More" }).click();
  await expect(picker.getByRole("complementary", { name: "Custom time examples" })).toContainText(
    "Type custom times like:",
  );
  await expect(picker.getByRole("button", { name: "45m" })).toBeVisible();
  await picker.getByRole("option", { name: "More" }).click();
  await picker.getByRole("option", { name: /Select from calendar/ }).click();
  await picker.getByRole("button", { name: "July 1, 2026" }).click();
  await picker.getByRole("button", { name: "July 3, 2026" }).click();
  await expect(editor(page)).toHaveValue(/Jul 1, 2026.*Jul 4, 2026/);
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("fixed");
});

test("outside dismissal allows a competing dashboard dialog", async ({ page }) => {
  await openPicker(page);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("dialog", { name: "Time range" })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Analyze" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("legacy links and history round-trip through the expression editor", async ({ page }) => {
  const from = Math.floor(FIXED_NOW.getTime() / 1000) - 7_980;
  const to = Math.floor(FIXED_NOW.getTime() / 1000);
  await page.goto(`/?range=7980&live=0&from=${from}&to=${to}&view=market&foreign=kept`);
  await expect(editor(page)).toHaveValue(/Sep 1, 2026/);
  await expect.poll(() => new URL(page.url()).searchParams.get("time_kind")).toBe("fixed");
  expect(new URL(page.url()).searchParams.get("foreign")).toBe("kept");

  await page.goto(
    "/?time_kind=relative&time_value=3600000&time_preset=past-1-hour&time_tz=America%2FChicago&time_play=running&foreign=new",
  );
  await expect(editor(page)).toHaveValue("Past 1 Hour");
  await page.goBack();
  await expect(editor(page)).toHaveValue(/Sep 1, 2026/);
  expect(new URL(page.url()).searchParams.get("foreign")).toBe("kept");
});

test("twenty rapid commits settle on the final URL without runaway requests", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (isTimeSeriesRequest(request.url())) requests.push(request.url());
  });
  await page.waitForTimeout(250);
  requests.length = 0;
  for (let index = 0; index < 20; index += 1) {
    const picker = await openPicker(page);
    await picker
      .getByRole("option", { name: index % 2 === 0 ? /Past 1 hour/ : /Past 6 hours/ })
      .click();
  }
  await expect(editor(page)).toHaveValue("Past 6 Hours");
  await expect.poll(() => new URL(page.url()).searchParams.get("time_value")).toBe("21600000");
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
  await picker.getByRole("option", { name: /Past 1 hour/ }).click();
  await expect.poll(() => controlledRequests).toBeGreaterThanOrEqual(1);
  const beforeSecondCommit = controlledRequests;
  picker = await openPicker(page);
  await picker.getByRole("option", { name: /Past 12 hours/ }).click();
  await expect.poll(() => controlledRequests).toBeGreaterThan(beforeSecondCommit);
  const latest = page.locator('[data-chart-id="supply-demand"] .legend-latest').first();
  await expect(latest).toContainText("22.2 GW");
  releaseFirst();
  await page.waitForTimeout(200);
  await expect(latest).toContainText("22.2 GW");
  await expect(editor(page)).toHaveValue("Past 12 Hours");
});
