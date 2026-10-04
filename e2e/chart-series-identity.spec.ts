import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

test("unrelated frequency history leaves populated core plots unchanged while real demand changes update them", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  let release!: () => void;
  let frequencyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    frequencyStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as { queries: Array<{ id: string }> };
    if (body.queries.some((query) => query.id === "frequency:frequency:current")) {
      frequencyStarted();
      await held;
    }
    await route.fallback();
  });
  try {
    await page.goto("/?range=86400&live=1");
    for (const id of ["supply-demand", "overview-headroom"]) {
      await expect(page.locator(`[data-chart-id="${id}"] canvas`)).toHaveAttribute(
        "data-chart-ready",
        "true",
      );
    }
    await started;
    await expect(
      page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "Frequency" }),
    ).toContainText("—");
    await page.evaluate(() => {
      for (const id of ["supply-demand", "overview-headroom"]) {
        const canvas = document.querySelector<HTMLCanvasElement>(`[data-chart-id="${id}"] canvas`)!;
        canvas.dataset["testPublishedUpdates"] = "0";
        new MutationObserver((records) => {
          canvas.dataset["testPublishedUpdates"] = String(
            Number(canvas.dataset["testPublishedUpdates"]) + records.length,
          );
        }).observe(canvas, { attributes: true, attributeFilter: ["data-chart-ready"] });
      }
    });
    release();
    await expect(
      page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "Frequency" }),
    ).toContainText("Hz");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    for (const id of ["supply-demand", "overview-headroom"]) {
      await expect(page.locator(`[data-chart-id="${id}"] canvas`)).toHaveAttribute(
        "data-test-published-updates",
        "0",
      );
    }
    const demand = page.locator('[data-chart-id="supply-demand"] .legend-latest').first();
    const beforeValue = await demand.textContent();
    const before = await page.evaluate(() => ({ ...window.__ercotChartLifecycle }));
    const picker = page.getByRole("combobox", { name: "Time range picker" });
    await picker.click();
    await picker.fill("Jul 21, 2026, 12:00 pm - Jul 21, 2026, 3:00 pm");
    await picker.press("Enter");
    await expect(demand).not.toHaveText(beforeValue!);
    await expect
      .poll(() =>
        page
          .locator('[data-chart-id="supply-demand"] canvas')
          .getAttribute("data-test-published-updates")
          .then(Number),
      )
      .toBeGreaterThan(0);
    expect((await page.evaluate(() => window.__ercotChartLifecycle))!.constructed).toBe(
      before!.constructed,
    );
  } finally {
    release();
  }
});
