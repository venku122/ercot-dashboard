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

it("selected NP6-905 cursor uses proven halfopen intervals and labels the ending time", async () => {
  const { chartCoordinator } = await import("./chart-coordinator");
  const { observationAt, temporalPolicy } = await import("./series-temporal-policy");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({}, "", "/?overviewPoint=HB_HOUSTON");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let selected: import("./types").ChartDefinition | undefined;
  let loaded: import("./types").LoadedSeries | undefined;
  try {
    await act(async () =>
      root.render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <OverviewCharts
            time={{ start: 5400, end: 8100, rangeSeconds: 2700, mode: "fixed", paused: false }}
            seriesData={new Map()}
            renderChart={(chart, _presentation, data) => {
              if (chart.id === "pricing") {
                selected = chart;
                loaded = data?.get("pricing:interval");
              }
              return <article>{chart.title}</article>;
            }}
          />
        </SWRConfig>,
      ),
    );
    await act(async () =>
      pending.get("HB_HOUSTON--HU")!([
        { target_ts: 7200, interval_start: 6300, interval_end: 7200, value: -50 },
        { target_ts: 8100, interval_start: 7200, interval_end: 8100, value: 99 },
      ] as PriceRow[]),
    );
    const policy = temporalPolicy("pricing", selected!.series[0]!);
    expect(observationAt(loaded, 7199, policy)?.value).toBe(-50);
    expect(observationAt(loaded, 7200, policy)?.value).toBe(99);
    expect(observationAt(loaded, 8100, policy)).toBeNull();
    await act(async () => chartCoordinator.togglePin(7199));
    const readout = host.querySelector(".homepage-readings > div:nth-child(4)")!;
    expect(readout.textContent).toContain("-$50.00/MWh");
    expect(readout.getAttribute("title")).toContain("Interval ending");
    expect(readout.getAttribute("title")).not.toContain("age -");
  } finally {
    await act(async () => chartCoordinator.clearPin());
    await act(async () => root.unmount());
    host.remove();
    pending.clear();
  }
});
