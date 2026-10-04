import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390, 768, 1440]) {
  for (const range of [21600, 86400, 604800]) {
    test(`ERP-01 populated acceptance ${width}px ${range}s`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 1024 });
      await installMobileApi(page, "normal", [], { nativeCadence: true });
      await page.goto(`/?range=${range}&live=1&legend=expanded`);
      const card = page.locator('[data-chart-id="supply-demand"]');
      await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
      await expect(page.locator('meta[name="ercot-build-revision"]')).toHaveAttribute(
        "content",
        /^[0-9a-f]{40}$/,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await card.getByRole("button", { name: "Open Supply and demand inspect mode" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(card.locator("canvas")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.screenshot({ path: `artifacts/post-release/smoke-${width}-${range}.png` });
    });
  }
}
