import { createTimeState, setCustomRange } from "./time-state";
import type { CompareMode, DashboardState, LegendMode } from "./types";

const compareModes = new Set<CompareMode>(["none", "previous_period", "day", "week", "custom"]);
const legendModes = new Set<LegendMode>(["compact", "expanded"]);

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dashboardStateFromUrl(url: URL, now: number): DashboardState {
  const params = url.searchParams;
  const range = finiteNumber(params.get("range")) ?? 6 * 60 * 60;
  let time = createTimeState(now, range);
  const from = finiteNumber(params.get("from"));
  const to = finiteNumber(params.get("to"));
  if (params.get("live") === "0" && from !== null && to !== null && from < to) {
    time = setCustomRange(from, to);
  }
  if (time.mode === "live" && params.get("paused") === "1") {
    time = { ...time, paused: true };
  }
  const compareParam = params.get("compare") as CompareMode | null;
  const legendParam = params.get("legend") as LegendMode | null;
  const customCompareSeconds = Math.max(
    300,
    Math.min(finiteNumber(params.get("compare_offset")) ?? 86400, 365 * 86400),
  );
  return {
    time,
    compare: compareParam && compareModes.has(compareParam) ? compareParam : "none",
    customCompareSeconds,
    events: params.get("events") !== "0",
    expandedChart: params.get("inspect"),
    hiddenSeries: new Set(
      (params.get("hidden") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    legendMode: legendParam && legendModes.has(legendParam) ? legendParam : "expanded",
  };
}

export function dashboardStateToUrl(state: DashboardState, base: URL): URL {
  const url = new URL(base);
  const params = url.searchParams;
  params.set("range", String(state.time.rangeSeconds));
  params.set("live", state.time.mode === "live" ? "1" : "0");
  if (state.time.mode === "fixed") {
    params.set("from", String(Math.round(state.time.start)));
    params.set("to", String(Math.round(state.time.end)));
    params.delete("paused");
  } else {
    params.delete("from");
    params.delete("to");
    if (state.time.paused) params.set("paused", "1");
    else params.delete("paused");
  }
  params.set("compare", state.compare);
  if (state.compare === "custom") params.set("compare_offset", String(state.customCompareSeconds));
  else params.delete("compare_offset");
  params.set("events", state.events ? "1" : "0");
  params.set("legend", state.legendMode);
  if (state.expandedChart) params.set("inspect", state.expandedChart);
  else params.delete("inspect");
  const hidden = [...state.hiddenSeries].sort();
  if (hidden.length) params.set("hidden", hidden.join(","));
  else params.delete("hidden");
  return url;
}
