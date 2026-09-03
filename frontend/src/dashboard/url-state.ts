import { createRelativeRange, decodeTimeRange, encodeTimeRange } from "../time-range";
import {
  ERCOT_TIME_RANGE_CONFIG,
  legacyTimeRangeFromUrl,
  writeLegacyTimeRangeProjection,
} from "./time-range-adapter";
import type { CompareMode, DashboardState, LegendMode } from "./types";
import { dashboardViewDefinitions, type DashboardViewId } from "./information-architecture";

const compareModes = new Set<CompareMode>(["none", "previous_period", "day", "week", "custom"]);
const legendModes = new Set<LegendMode>(["compact", "expanded"]);
const dashboardViewIds = new Set<DashboardViewId>(dashboardViewDefinitions.map((view) => view.id));

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dashboardViewFromUrl(url: URL): DashboardViewId {
  const value = url.searchParams.get("view") as DashboardViewId | null;
  return value && dashboardViewIds.has(value) ? value : "overview";
}

export function dashboardViewToUrl(view: DashboardViewId, base: URL): URL {
  const url = new URL(base);
  url.searchParams.set("view", view);
  if (view !== "texas-grid") url.searchParams.delete("grid_resource");
  if (view !== "external-context") url.searchParams.delete("context_source");
  return url;
}

export function dashboardStateFromUrl(url: URL, now: number): DashboardState {
  const params = url.searchParams;
  const nowMs = now * 1000;
  const time =
    decodeTimeRange(params, ERCOT_TIME_RANGE_CONFIG, nowMs) ??
    legacyTimeRangeFromUrl(params, nowMs) ??
    createRelativeRange(
      6 * 60 * 60 * 1000,
      "past-6-hours",
      ERCOT_TIME_RANGE_CONFIG.defaultTimezone,
    );
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
    history: params.get("history") === "1",
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

export function dashboardStateToUrl(
  state: DashboardState,
  base: URL,
  now = Date.now() / 1000,
): URL {
  const url = new URL(base);
  const semanticParams = encodeTimeRange(state.time, url.searchParams);
  const params = writeLegacyTimeRangeProjection(state.time, semanticParams, now * 1000);
  params.set("compare", state.compare);
  if (state.compare === "custom") params.set("compare_offset", String(state.customCompareSeconds));
  else params.delete("compare_offset");
  params.set("events", state.events ? "1" : "0");
  if (state.history) params.set("history", "1");
  else params.delete("history");
  params.set("legend", state.legendMode);
  if (state.expandedChart) params.set("inspect", state.expandedChart);
  else params.delete("inspect");
  const hidden = [...state.hiddenSeries].sort();
  if (hidden.length) params.set("hidden", hidden.join(","));
  else params.delete("hidden");
  url.search = params.toString();
  return url;
}
