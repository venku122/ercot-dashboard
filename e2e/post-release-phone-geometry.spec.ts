import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390]) {
  test(`ordinary ${width}px first plot geometry retains text and controls @mobile-core`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installMobileApi(page, "normal");
    await page.goto("/?range=21600&live=1");
    const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    const evidence = await page.evaluate(() => {
      const selectors = [
        ".dashboard-shell",
        ".dashboard-header",
        ".dashboard-brand",
        ".compact-control-bar",
        ".status-strip",
        ".homepage-workspace",
        ".homepage-readings",
        '[data-chart-id="supply-demand"]',
        '[data-chart-id="supply-demand"] .chart-card-header',
        '[data-chart-id="supply-demand"] canvas',
      ];
      return Object.fromEntries(
        selectors.map((selector) => {
          const element = document.querySelector(selector) as HTMLElement;
          const box = element?.getBoundingClientRect(),
            style = element && getComputedStyle(element);
          return [
            selector,
            {
              y: box?.y,
              height: box?.height,
              marginTop: style?.marginTop,
              marginBottom: style?.marginBottom,
              gap: style?.gap,
              paddingTop: style?.paddingTop,
              paddingBottom: style?.paddingBottom,
            },
          ];
        }),
      );
    });
    await writeFile(
      `/tmp/ercot-post-release-2026-10/final-phone-after-${width}.json`,
      JSON.stringify(evidence, null, 2),
    );
    await page.screenshot({
      path: `/tmp/ercot-post-release-2026-10/final-phone-after-${width}.png`,
    });
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (width === 390) expect(box!.y).toBeLessThanOrEqual(280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("ordinary WebKit 390px plot reaches original target with complete controls", async ({
  baseURL,
}) => {
  const { webkit } = await import("@playwright/test");
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      timezoneId: "America/Chicago",
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      permissions: [],
    });
    await installMobileApi(page, "normal");
    await page.goto(`${baseURL}/?range=21600&live=1`);
    const canvas = page.locator('[data-chart-id="supply-demand"] canvas');
    await expect(canvas).toHaveAttribute("data-chart-ready", "true");
    const box = (await canvas.boundingBox())!;
    expect(box.y).toBeLessThanOrEqual(280);
    expect(box.height).toBe(240);
    const inspect = page.getByRole("button", {
      name: "Open Supply and demand inspect mode",
      exact: true,
    });
    const target = (await inspect.boundingBox())!;
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await inspect.focus();
    await expect(inspect).toBeFocused();
    await page.screenshot({
      path: "/tmp/ercot-post-release-2026-10/final-phone-after-WebKit390.png",
    });
    await writeFile(
      "/tmp/ercot-post-release-2026-10/final-phone-after-WebKit390.json",
      JSON.stringify({ top: box.y, height: box.height, inspect: target }),
    );
  } finally {
    await browser.close();
  }
});
