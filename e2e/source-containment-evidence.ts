import { type Page, type TestInfo } from "@playwright/test";

// Record actual source-panel geometry before its unchanged containment assertion.
export async function recordSourceContainment(page: Page, info: TestInfo, name: string) {
  const evidence = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panels: [
      ...document.querySelectorAll(
        '.predictive-weather-panel, .predictive-weather-panel details, .predictive-weather-panel .table-scroll, [aria-labelledby="forecast-quality-title"], #forecast-quality-detail, #forecast-quality-detail fieldset, .forecast-quality-table',
      ),
    ].map((node) => {
      const rect = node.getBoundingClientRect();
      const css = getComputedStyle(node);
      return {
        tag: node.tagName,
        className: node.className,
        rect: { x: rect.x, right: rect.right, width: rect.width },
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        minWidth: css.minWidth,
        overflowX: css.overflowX,
      };
    }),
  }));
  await info.attach(name, {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
}
