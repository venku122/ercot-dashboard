import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Passive evidence for individually reviewed images. Source samples are never modified.
export function observeVisualSources(page: Page) {
  const responses: unknown[] = [];
  const failures: string[] = [];
  const pending = new Set<Promise<void>>();
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/")) failures.push(request.url());
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      !/^\/api\/(series\/batch|latest\/batch|v[12]\/(source-health|tile-catalog|tiles\/|series\/chunk))/.test(
        path,
      )
    )
      return;
    if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`);
    const task = (async () => {
      if (responses.length >= 200)
        throw new Error("Visual source evidence request budget exceeded");
      const body = response.ok() ? await response.json() : null;
      const summarize = (series: any) => ({
        id: series.id,
        source_id: series.source_id,
        point: series.point,
        state: series.state,
        freshness_state: series.freshness_state,
        data_age_seconds: series.data_age_seconds,
        consecutive_failures: series.consecutive_failures,
        metric: series.metric,
        tags: series.tags,
        native_interval_seconds: series.native_interval_seconds,
        unit: series.unit,
        statistic_policy: series.statistic_policy,
        resolution: series.resolution,
        aggregation: series.aggregation,
        meta: series.meta,
        paired_count: series.paired_count,
        expected_count: series.expected_count,
        point_count: series.points?.length,
        first: series.points?.[0],
        last: series.points?.at(-1),
        bucket_count: series.buckets?.length,
        first_bucket: series.buckets?.[0],
        last_bucket: series.buckets?.at(-1),
      });
      responses.push({
        path: response.url(),
        status: response.status(),
        query: response.request().postDataJSON(),
        sha256: body ? createHash("sha256").update(JSON.stringify(body)).digest("hex") : null,
        sources:
          (body?.series ?? body?.latest ?? body?.sources)?.map(summarize) ??
          (body ? [summarize(body)] : []),
      });
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return {
    async capture(name: string, target: Locator) {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await Promise.all(pending);
      expect(failures, `${name} must not escape deterministic API fixtures`).toEqual([]);
      const geometry = await target.evaluate((element) => {
        const measure = (node: Element) => {
          const rect = node.getBoundingClientRect(),
            css = getComputedStyle(node);
          return {
            tag: node.tagName,
            text: node.textContent?.trim().slice(0, 180),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            font: css.font,
            fontWeight: css.fontWeight,
            color: css.color,
            transform: css.transform,
            position: css.position,
            border: css.border,
            backdropFilter: css.backdropFilter,
          };
        };
        return {
          fonts: document.fonts.status,
          dpr: devicePixelRatio,
          scroll: { x: scrollX, y: scrollY },
          root: measure(element),
          text: [
            ...element.querySelectorAll("summary,strong,.legend-latest,.homepage-readings > div"),
          ]
            .slice(0, 100)
            .map(measure),
          charts: [...document.querySelectorAll("[data-chart-id]")].map((node) => ({
            id: node.getAttribute("data-chart-id"),
            mounted: node.getAttribute("data-mounted"),
            canvas: node.querySelector("canvas")?.getAttribute("aria-label"),
            values: [...node.querySelectorAll(".legend-latest")].map((n) => ({
              value: n.textContent,
              title: n.getAttribute("title"),
            })),
          })),
        };
      });
      const body = JSON.stringify(
        { sourceHead: process.env["VRI_SOURCE_SHA"], geometry, responses },
        null,
        2,
      );
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2 * 1024 * 1024);
      const directory = join(
        "artifacts/post-release/vri-review",
        process.platform,
        test.info().project.name,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${name}.json`), body);
      await test
        .info()
        .attach(`${name}-source-geometry`, { body, contentType: "application/json" });
    },
  };
}
