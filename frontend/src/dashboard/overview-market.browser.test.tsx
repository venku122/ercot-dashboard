// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { expect, it, vi } from "vitest";
import { OverviewCharts } from "./OverviewCharts";
import type { PriceRow } from "./market-geography";
const pending = vi.hoisted(() => new Map<string, (rows: PriceRow[]) => void>());
vi.mock("./market-geography", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./market-geography")>()),
  loadMarketGeographyManifest: async () => ({ settlement_interval: { target_ts: 7200, rows: [] } }),
  loadIntervalPriceHistory: (identity: string) =>
    new Promise<PriceRow[]>((resolve) => pending.set(identity, resolve)),
}));
it("price selection and history switch atomically and ignore obsolete point responses", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/?overviewPoint=HB_HOUSTON");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <OverviewCharts
            time={{ start: 3600, end: 8000, rangeSeconds: 4400, mode: "fixed", paused: false }}
            seriesData={new Map()}
            renderChart={(chart, _presentation, data) => (
              <article data-testid={chart.id}>
                {chart.title}{" "}
                {(data?.get("pricing:interval")?.points ?? []).map((point) => point[1]).join(",")}
              </article>
            )}
          />
        </SWRConfig>,
      ),
    );
    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = "HB_NORTH";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const row = (value: number) => ({ target_ts: 7200, value }) as PriceRow;
    await act(async () => pending.get("HB_NORTH--HU")!([row(-50)]));
    expect(host.querySelector('[data-testid="pricing"]')!.textContent).toContain("North Hub");
    expect(host.querySelector('[data-testid="pricing"]')!.textContent).toContain("-50");
    await act(async () => pending.get("HB_HOUSTON--HU")!([row(999)]));
    expect(host.querySelector('[data-testid="pricing"]')!.textContent).not.toContain("999");
    expect(new URLSearchParams(window.location.search).get("overviewPoint")).toBe("HB_NORTH");
    await act(async () => {
      window.history.replaceState({}, "", "/?overviewPoint=HB_HOUSTON");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(host.querySelector('[data-testid="pricing"]')!.textContent).toContain("Houston Hub");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    pending.clear();
  }
});
