import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const scenario of ["normal", "empty", "error"] as const) {
  for (const latency of [0, 300, 1000]) {
    test(`mobile ${scenario} ${latency}ms hydration keeps unvisited fuel lazy @mobile-core`, async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const events: unknown[] = [];
        Object.defineProperty(window, "__lazyGeometry", { value: events });
        const Native = window.IntersectionObserver;
        window.IntersectionObserver = class extends Native {
          constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
            super((entries, observer) => {
              if (events.length < 300)
                events.push({
                  now: performance.now(),
                  scroll: scrollY,
                  entries: entries.map((entry) => ({
                    id: (entry.target as HTMLElement).dataset.chartId,
                    intersects: entry.isIntersecting,
                    top: entry.boundingClientRect.top,
                    bottom: entry.boundingClientRect.bottom,
                  })),
                  cards: [...document.querySelectorAll<HTMLElement>("[data-chart-id]")]
                    .slice(0, 4)
                    .map((el) => ({
                      id: el.dataset.chartId,
                      top: el.getBoundingClientRect().top,
                      bottom: el.getBoundingClientRect().bottom,
                      mounted: el.dataset.mounted,
                      legendHeight:
                        el.querySelector(".series-legend")?.getBoundingClientRect().height ?? 0,
                    })),
                });
              callback(entries, observer);
            }, options);
          }
        };
      });
      const requests: string[][] = [];
      await installMobileApi(page, scenario, requests);
      const requestedIds: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/api/series/batch")) {
          const body = request.postDataJSON() as { queries: Array<{ id: string }> };
          requestedIds.push(...body.queries.map((query) => query.id));
        }
      });
      for (const pattern of ["**/api/series/batch", "**/api/v2/tiles/**"]) {
        await page.route(pattern, async (route) => {
          // Ordinary bounded source latency lets the initial placeholder layout paint.
          await new Promise((resolve) => setTimeout(resolve, latency));
          await route.fallback();
        });
      }
      await page.goto("/");
      await page.locator('[data-chart-id="supply-demand"]').scrollIntoViewIfNeeded();
      const supply = page.locator('[data-chart-id="supply-demand"]');
      if (scenario === "normal")
        await expect(supply.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
      else
        await expect(supply).toHaveAttribute(
          "data-lifecycle-state",
          scenario === "empty" ? /^(waiting|unavailable)$/ : "unavailable",
        );
      const geometry = await page.evaluate(
        () => (window as Window & { __lazyGeometry?: unknown[] }).__lazyGeometry,
      );
      await test.info().attach("intersection-geometry", {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      });
      await mkdir("artifacts/post-release/mobile-lazy", { recursive: true });
      await writeFile(
        `artifacts/post-release/mobile-lazy/${test.info().project.name}-${scenario}-${latency}-repeat${test.info().repeatEachIndex}.json`,
        JSON.stringify(
          {
            viewport: page.viewportSize(),
            scenario,
            latency,
            geometry,
            initialRequestedIds: [...requestedIds],
          },
          null,
          2,
        ),
      );
      expect(requestedIds.filter((id) => id.startsWith("fuel-mix:"))).toEqual([]);
      expect(
        requestedIds.filter((id) =>
          /^(reserves|dc-ties|time-error|time-error-recovery|inertia):/.test(id),
        ),
      ).toEqual([]);
      await expect(
        page.locator(".homepage-engineering").filter({
          has: page.getByText("Engineering details · reserves, DC ties, time error & inertia", {
            exact: true,
          }),
        }),
      ).not.toHaveAttribute("open", "");
      expect(
        await page.locator('[data-chart-id][data-mounted="true"]').count(),
      ).toBeLessThanOrEqual(2);
      expect(
        await page.evaluate(() => window.__ercotChartLifecycle?.constructed ?? 0),
      ).toBeLessThanOrEqual(2);
      const legends = await supply.locator(".series-legend button").evaluateAll((elements) =>
        elements.map((el) => ({
          label: el.getAttribute("aria-label"),
          height: el.getBoundingClientRect().height,
        })),
      );
      expect(legends).toHaveLength(3);
      for (const control of legends) {
        expect(control.label).toBeTruthy();
        expect(control.height).toBeGreaterThanOrEqual(44);
      }
      if (scenario === "normal") {
        const fuel = page.locator('[data-chart-id="fuel-mix"]');
        await fuel.scrollIntoViewIfNeeded();
        await expect(fuel.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
        expect(new Set(requestedIds.filter((id) => id.startsWith("fuel-mix:"))).size).toBe(6);
      } else {
        await expect(supply.locator("canvas")).toHaveCount(0);
        await expect(supply.locator(".series-legend")).toContainText("—");
      }
    });
  }
}
