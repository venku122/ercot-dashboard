import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

for (const change of ["range", "comparison"] as const) {
  test(`warm Overview ${change} identifies retained frequency history until its new context arrives`, async ({
    page,
  }) => {
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    await page.goto(
      `/?range=21600&live=1&legend=expanded&compare=${change === "comparison" ? "previous_period" : "none"}`,
    );
    const frequency = page.locator('[data-chart-id="frequency"]');
    await frequency.scrollIntoViewIfNeeded();
    await expect(frequency.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await expect(frequency).toHaveAttribute("aria-busy", "false");
    await page.mouse.move(1, 1);
    const oldStats = await frequency.locator(".legend-stats").allTextContents();
    expect(oldStats).toHaveLength(3);
    let release!: () => void, begin!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const requested: unknown[] = [];
    await page.route("**/api/series/batch", async (route) => {
      const body = route.request().postDataJSON() as {
        queries: Array<{ id: string; since: number; until: number; stats_since: number }>;
      };
      if (body.queries.some((query) => query.id === "frequency:frequency:current")) {
        requested.push(body);
        begin();
        await held;
      }
      await route.fallback();
    });
    if (change === "range") {
      const editor = page.getByRole("combobox", { name: "Time range picker" });
      await editor.click();
      await editor.fill("24h");
      await editor.press("Enter");
    } else {
      await page.getByRole("button", { name: "Time & compare" }).click();
      const dialog = page.getByRole("dialog", { name: "Time & comparison" });
      await dialog.getByLabel("Compare time").selectOption("day");
      await dialog.getByRole("button", { name: "Close Time & comparison" }).click();
    }
    await started;
    try {
      await frequency.scrollIntoViewIfNeeded();
      await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
        "data-chart-ready",
        "true",
      );
      await expect(frequency).toHaveAttribute("aria-busy", "true");
      expect(await frequency.locator(".legend-stats").allTextContents()).toEqual(oldStats);
      await test.info().attach("held-new-frequency-query", {
        body: JSON.stringify({ requested, oldStats }),
        contentType: "application/json",
      });
      // Real prior measurements may remain, but their statistics/comparison identity
      // must not be advertised as the newly selected window or comparison.
      await expect(frequency).toContainText("Previous selection");
      await expect(frequency).toContainText(
        new Date((FIXED_NOW_SECONDS - 21600) * 1000).toISOString(),
      );
      await page.mouse.move(1, 1);
      await expect(frequency.locator(".legend-latest")).toHaveAttribute(
        "title",
        "Latest value from previous selection",
      );
    } finally {
      release();
    }
    await expect(frequency).toHaveAttribute("aria-busy", "false");
    await expect(frequency).not.toContainText("Previous selection");
    await expect(frequency.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
    await page.mouse.move(1, 1);
    await expect(frequency.locator(".legend-latest")).toContainText("Hz");
  });
}

test("ordinary rolling live frequency refresh retains the same selection honestly", async ({
  page,
}) => {
  await page.clock.install();
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/?range=21600&live=1&legend=expanded&compare=none");
  const frequency = page.locator('[data-chart-id="frequency"]');
  await frequency.scrollIntoViewIfNeeded();
  await expect(frequency).toHaveAttribute("aria-busy", "false");
  await expect(frequency.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await page.mouse.move(1, 1);
  const oldStats = await frequency.locator(".legend-stats").allTextContents();
  let release!: () => void, begin!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (body.queries.some((query) => query.id === "frequency:frequency:current")) {
      begin();
      await held;
    }
    await route.fallback();
  });
  await page.clock.setFixedTime(new Date((FIXED_NOW_SECONDS + 30) * 1000));
  await page.clock.fastForward(30_000);
  await started;
  try {
    await expect(frequency).toHaveAttribute("aria-busy", "true");
    expect(await frequency.locator(".legend-stats").allTextContents()).toEqual(oldStats);
    await expect(frequency).not.toContainText("Previous selection");
    await page.mouse.move(1, 1);
    await expect(frequency.locator(".legend-latest")).toHaveAttribute(
      "title",
      "Latest value in selected window",
    );
  } finally {
    release();
  }
  await expect(frequency).toHaveAttribute("aria-busy", "false");
  await expect(frequency).not.toContainText("Previous selection");
});
