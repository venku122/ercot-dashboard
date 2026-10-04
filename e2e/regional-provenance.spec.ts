import { expect, test } from "@playwright/test";

import { installMobileApi } from "./mobile-fixtures";
import { installRegionalGeographyApi } from "./regional-geography-fixtures";

for (const width of [1280, 390, 320]) {
  test(`regional source provenance is visibly contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await installMobileApi(page);
    await installRegionalGeographyApi(page, []);
    await page.goto("/?view=generation&regionalLayer=wind&regionalRegion=coastal");
    const panel = page.getByRole("region", { name: "Regional load and renewable outlook" });
    await panel.getByRole("button", { name: "Load regional details" }).click();
    const provenance = panel.getByText(/^Source provenance:/);
    await expect(provenance).toContainText("source_id ercot_mis_np4_742");
    await expect(provenance).toContainText(`vintage_key rgv1-${"b".repeat(64)}`);
    await expect(provenance).toContainText("issued_at 8/17/2026, 7:00:00 PM");
    await expect(provenance).toContainText("retrieved_at 8/17/2026, 7:01:00 PM");
    const geometry = await provenance.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const ancestors = [];
      let parent: HTMLElement | null = element as HTMLElement;
      while (parent) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        ancestors.push({
          tag: parent.tagName,
          id: parent.id,
          className: parent.className,
          left: bounds.left,
          right: bounds.right,
          clientWidth: parent.clientWidth,
          scrollWidth: parent.scrollWidth,
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          overflowX: style.overflowX,
          display: style.display,
        });
        parent = parent.parentElement;
      }
      return {
        viewportWidth: window.innerWidth,
        paragraph: { left: box.left, right: box.right },
        textRects: Array.from(range.getClientRects(), (rect) => ({
          left: rect.left,
          right: rect.right,
          width: rect.width,
        })),
        ancestors,
      };
    });
    await test.info().attach("regional-provenance-visible-geometry", {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
    expect(geometry.textRects.length).toBeGreaterThan(0);
    for (const rect of geometry.textRects) {
      expect(rect.left).toBeGreaterThanOrEqual(Math.max(0, geometry.paragraph.left) - 0.5);
      expect(rect.right).toBeLessThanOrEqual(
        Math.min(geometry.viewportWidth, geometry.paragraph.right) + 0.5,
      );
      for (const ancestor of geometry.ancestors) {
        if (ancestor.overflowX === "hidden" || ancestor.overflowX === "clip") {
          expect(rect.left).toBeGreaterThanOrEqual(ancestor.left - 0.5);
          expect(rect.right).toBeLessThanOrEqual(ancestor.right + 0.5);
        }
      }
    }
  });
}
