import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390, 768, 1440]) {
  for (const zoom of [1, 2]) {
    test(`ERP-09 reflow keeps controls and readings at ${width}px zoom ${zoom}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await installMobileApi(page, "normal", [], { nativeCadence: true });
      await page.goto("/?view=overview&range=604800&live=1&legend=expanded");
      await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
        "data-chart-ready",
        "true",
      );
      await page.evaluate((scale) => {
        document.documentElement.style.zoom = String(scale);
      }, zoom);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page.getByRole("combobox", { name: "Time range picker" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Time & compare", exact: true })).toBeVisible();
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        readings: [
          ...document.querySelectorAll(
            ".homepage-readings > div > span, .homepage-readings > div > strong",
          ),
        ].map((element) => ({
          text: element.textContent,
          right: element.getBoundingClientRect().right,
          left: element.getBoundingClientRect().left,
          clipped: element.scrollWidth > element.clientWidth + 1,
        })),
        overflow: [...document.querySelectorAll("body *")]
          .filter((element) => {
            if (element.getBoundingClientRect().right <= innerWidth + 1) return false;
            let parent = element.parentElement;
            while (parent && parent !== document.body) {
              if (["auto", "scroll"].includes(getComputedStyle(parent).overflowX)) return false;
              parent = parent.parentElement;
            }
            return true;
          })
          .map((element) => ({
            className: element.className,
            text: element.textContent?.slice(0, 35),
            right: element.getBoundingClientRect().right,
          })),
        controls: [
          ...document.querySelectorAll(".dashboard-header button, .dashboard-header input"),
        ]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .map((element) => ({
            name: element.getAttribute("aria-label") ?? element.textContent,
            right: element.getBoundingClientRect().right,
            left: element.getBoundingClientRect().left,
          })),
      }));
      expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(width);
      for (const value of [...geometry.readings, ...geometry.controls]) {
        expect(value.left, JSON.stringify(value)).toBeGreaterThanOrEqual(0);
        expect(value.right, JSON.stringify(value)).toBeLessThanOrEqual(width + 1);
      }
      for (const value of geometry.readings)
        expect(value.clipped, JSON.stringify(value)).toBe(false);
      await page.screenshot({
        path: `artifacts/post-release/ERP-09-reflow-${width}-zoom${zoom}.png`,
        fullPage: false,
      });
    });
  }
}

test("ERP-09 WebKit zoom retains complete readings and viewport containment", async ({
  baseURL,
}) => {
  const { webkit } = await import("@playwright/test");
  const browser = await webkit.launch();
  try {
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, permissions: [] });
      await installMobileApi(page, "normal", [], { nativeCadence: true });
      await page.goto(`${baseURL}/?view=overview&range=604800&live=1&legend=expanded`);
      await expect(page.locator('[data-chart-id="supply-demand"] canvas')).toHaveAttribute(
        "data-chart-ready",
        "true",
      );
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      const geometry = await page.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        readings: [...document.querySelectorAll(".homepage-readings > div > strong")].map(
          (element) => ({
            text: element.textContent,
            clipped: element.scrollWidth > element.clientWidth + 1,
          }),
        ),
      }));
      expect(geometry.pageWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(width);
      for (const value of geometry.readings)
        expect(value.clipped, JSON.stringify(value)).toBe(false);
      await page.screenshot({
        path: `artifacts/post-release/ERP-09-reflow-webkit-${width}-zoom2.png`,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
