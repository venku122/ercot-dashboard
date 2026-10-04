import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

async function overview(page: import("@playwright/test").Page) {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/?view=overview&range=604800&live=1&legend=expanded");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  return card;
}

test("ERP-09 exact table discloses truncation, units and keyboard scrolling", async ({ page }) => {
  const card = await overview(page);
  await card.getByText("Accessible data table", { exact: true }).click();
  await expect(card.getByText(/Latest 250 displayed points per series/)).toBeVisible();
  const region = card.getByRole("region", { name: "Supply and demand displayed source data" });
  await expect(region).toHaveAttribute("tabindex", "0");
  await region.focus();
  await expect(region).toBeFocused();
  await expect(
    region.getByRole("columnheader", { name: "Displayed value", exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Source unit: MW.", { exact: false })).toBeVisible();
  await expect(
    region.getByRole("columnheader", { name: "Resolution and coverage", exact: true }),
  ).toBeVisible();
});

test("ERP-09 Inspect traps visible controls and restores focus with collapsed content", async ({
  page,
}) => {
  const card = await overview(page);
  const trigger = card.getByRole("button", { name: "Open Supply and demand inspect mode" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Inspect Supply and demand" });
  const close = dialog.getByRole("button", { name: "Close Supply and demand inspect mode" });
  const last = dialog.getByText("Accessible data table", { exact: true });
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("ERP-09 hover stays quiet while intentional pin announces clock and scope", async ({
  page,
}) => {
  const card = await overview(page);
  const canvas = card.locator("canvas");
  const live = card.locator("[data-pin-announcement]");
  await expect(live).toHaveText("");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card.locator('[data-value-scope="cursor"]').first()).toBeVisible();
  await expect(live).toHaveText("");
  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(live).toContainText(
    /Cursor pinned at .*Observations|Cursor pinned at .*observations/,
  );
  await page.keyboard.press("Escape");
  await expect(live).toHaveText("Cursor cleared. Readouts return to selected-window values.");
});

for (const width of [320, 768, 1440]) {
  test(`ERP-09 increased zoom contains critical page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await overview(page);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 20)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: element.getBoundingClientRect().right,
        })),
    }));
    expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(width);
  });
}

for (const width of [320, 390, 1440]) {
  test(`ERP-09 critical controls retain named 44px targets and reduced motion at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const card = await overview(page);
    const targets = await page
      .locator(
        ".dashboard-header button, .dashboard-header input, .view-navigation button, .chart-card button, .chart-card summary",
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && element.checkVisibility();
          })
          .map((element) => ({
            name: element.getAttribute("aria-label") ?? element.textContent?.trim(),
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
          })),
      );
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) {
      expect(target.name, JSON.stringify(target)).toBeTruthy();
      expect(target.width, JSON.stringify(target)).toBeGreaterThanOrEqual(44);
      expect(target.height, JSON.stringify(target)).toBeGreaterThanOrEqual(44);
    }
    await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).focus();
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
  });
}
