import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

test("critical Overview plots commit while selected-window frequency history is pending", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  let releaseFrequency!: () => void;
  let frequencyStarted!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFrequency = resolve;
  });
  const started = new Promise<void>((resolve) => {
    frequencyStarted = resolve;
  });
  await page.route("**/api/series/batch", async (route) => {
    const body = route.request().postDataJSON() as { queries: Array<{ metric: string }> };
    if (body.queries.some((query) => query.metric === "ercot.Frequency.Current_Frequency")) {
      frequencyStarted();
      await held;
    }
    await route.fallback();
  });
  await page.goto("/?range=86400&live=1");
  await started;
  try {
    for (const id of ["supply-demand", "overview-headroom"]) {
      const card = page.locator(`[data-chart-id="${id}"]`);
      await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true", {
        timeout: 1500,
      });
      await expect(card.locator(".legend-latest").first()).toContainText("GW");
    }
    await expect(
      page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "Frequency" }),
    ).toContainText("—");
  } finally {
    releaseFrequency();
  }
  const frequency = page.locator('[data-chart-id="frequency"]');
  await frequency.scrollIntoViewIfNeeded();
  await expect(frequency.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(frequency.locator(".legend-latest")).toContainText("Hz");
  await expect(
    page.getByLabel("Time-aligned grid readings").locator("div").filter({ hasText: "Frequency" }),
  ).toContainText("Hz");
  await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
    "data-chart-ready",
    "true",
  );
});
