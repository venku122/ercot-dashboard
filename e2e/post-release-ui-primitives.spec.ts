import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";
import { installHistoricalContextApi } from "./historical-context-fixtures";
import { installTexasGridApi } from "./texas-grid-fixtures";
import { installExternalContextApi } from "./external-context-fixtures";

for (const width of [320, 390, 768, 1440]) {
  test(`ERP-10 disclosures preserve request ownership and contained evidence at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    const historyRequests: string[] = [];
    const texasRequests: string[] = [];
    await installMobileApi(page);
    await installHistoricalContextApi(page, historyRequests);
    await installTexasGridApi(page, texasRequests);
    await installExternalContextApi(page);
    await page.goto("/?view=overview&history=0");
    const trigger = page.getByRole("button", {
      name: "Historical context and records",
      exact: true,
    });
    const contentId = await trigger.getAttribute("aria-controls");
    const content = page.locator(`[id="${contentId}"]`);
    await expect(content).toBeHidden();
    expect(historyRequests).toEqual([]);
    const target = (await trigger.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => historyRequests.length).toBe(1);
    await expect(content).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-controls", contentId!);
    const method = page.getByRole("button", { name: "Method and provenance", exact: true });
    await method.focus();
    await page.keyboard.press("Space");
    await expect(method).toHaveAttribute("aria-expanded", "true");
    expect(historyRequests).toHaveLength(1);
    await trigger.click();
    await expect(content).toBeHidden();
    expect(historyRequests).toHaveLength(1);
    await trigger.click();
    await expect(content).toBeVisible();
    expect(historyRequests).toHaveLength(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const view of ["texas-grid", "external-context"]) {
      await page.goto(`/?view=${view}`);
      const health = page.getByRole("button", {
        name: "Source collection and materialization health",
        exact: true,
      });
      await health.click();
      await expect(health).toHaveAttribute("aria-expanded", "true");
      const controls = await page
        .locator(".ui-disclosure-trigger")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-controls")),
        );
      expect(new Set(controls).size).toBe(controls.length);
      for (const id of controls) await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    expect(texasRequests.filter((path) => path.startsWith("/api/v2/"))).toEqual([]);
  });
}
