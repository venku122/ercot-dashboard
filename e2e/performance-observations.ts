import type { Page } from "@playwright/test";
import { formatValue } from "../frontend/src/dashboard/units";

export function isHistoryDataRequest(method: string, url: string): boolean {
  if (method !== "GET" && method !== "POST") return false;
  const path = new URL(url).pathname;
  // These endpoints expose health/current snapshots, never selected-window history.
  if (["/api/v1/source-health", "/api/latest/batch", "/api/v1/ranking"].includes(path))
    return false;
  return path.startsWith("/api/");
}
export type ObservedHistoryRequest = { method: string; url: string };
export type ObservedTile = {
  lod: string;
  series_key: string;
  buckets: Array<{
    start: number;
    end: number;
    state: {
      count: number;
      first_ts: number;
      first_value: number;
      last_ts: number;
      last_value: number;
      minimum: number;
      minimum_ts: number;
      maximum: number;
      maximum_ts: number;
    };
  }>;
};

type Batch = {
  series?: Array<{
    id: string;
    points: Array<[number, number]>;
    meta?: { stats?: { latest?: number } };
  }>;
};
export function observeHistory(page: Page, publishColdOracle = false) {
  const requests: ObservedHistoryRequest[] = [];
  const tiles = new Map<string, ObservedTile>();
  const pending: Promise<void>[] = [];
  const latest = new Map<string, { timestamp: number; value: number }>();
  let pairedRequested = false;
  const retain = (id: string, timestamp: number, value: number) => {
    if (Number.isFinite(value) && timestamp >= (latest.get(id)?.timestamp ?? -Infinity))
      latest.set(id, { timestamp, value });
  };
  page.on("request", (request) => {
    if (!isHistoryDataRequest(request.method(), request.url())) return;
    requests.push({ method: request.method(), url: request.url() });
    if (request.url().includes("/tiles/supply-demand.paired-headroom/")) pairedRequested = true;
  });
  page.on("response", (response) => {
    const url = response.url();
    // Long raw v1 windows may exceed Chromium inspector body cache; only
    // cold readiness needs their contents. Request events remain recorded.
    if (!publishColdOracle && url.includes("/api/series/batch")) return;
    if (!url.includes("/api/series/batch") && !url.includes("/api/v2/tiles/supply-demand.")) return;
    const reading = (async () => {
      if (!response.ok()) return;
      const body = (await response.json()) as ObservedTile & Batch;
      if (body.buckets) {
        tiles.set(url, body);
        const id =
          body.series_key === "supply-demand.paired-headroom"
            ? "headroom"
            : body.series_key === "supply-demand.available-capacity"
              ? "capacity"
              : body.series_key === "supply-demand.demand"
                ? "demand"
                : null;
        // An hourly forecast is a separate product, never the observed demand oracle.
        if (id) for (const { state } of body.buckets) retain(id, state.last_ts, state.last_value);
      }
      for (const series of body.series ?? []) {
        const id =
          series.id === "supply-demand:demand:current"
            ? "demand"
            : series.id === "supply-demand:available-capacity:current"
              ? "capacity"
              : null;
        const point = series.points.at(-1);
        if (id && point) retain(id, point[0], series.meta?.stats?.latest ?? point[1]);
      }
      if (publishColdOracle) {
        const demand = latest.get("demand"),
          capacity = latest.get("capacity");
        const headroom = pairedRequested
          ? latest.get("headroom")?.value
          : demand && capacity && demand.timestamp === capacity.timestamp
            ? capacity.value - demand.value
            : undefined;
        const oracle = {
          demand: formatValue(demand?.value ?? null, "MW"),
          capacity: formatValue(capacity?.value ?? null, "MW"),
          headroom: formatValue(headroom ?? null, "MW"),
        };
        await page.evaluate(
          (value) => Object.assign(window, { __performanceExpectedReadings: value }),
          oracle,
        );
      }
    })();
    pending.push(reading);
  });
  return { requests, tiles, settled: () => Promise.all(pending) };
}

export function selectedPairedTileProof(tiles: Iterable<ObservedTile>, start: number, end: number) {
  let count = 0,
    minimum = Infinity,
    maximum = -Infinity;
  const requiredPoints = new Map<number, number>();
  let maximumVertices = 0;
  for (const tile of tiles) {
    if (tile.series_key !== "supply-demand.paired-headroom") continue;
    for (const bucket of tile.buckets) {
      const native = tile.lod === "native";
      if (
        native
          ? bucket.state.first_ts < start || bucket.state.first_ts > end
          : bucket.start < start || bucket.end > end + 1
      )
        continue;
      const state = bucket.state;
      count += state.count;
      minimum = Math.min(minimum, state.minimum);
      maximum = Math.max(maximum, state.maximum);
      requiredPoints.set(state.first_ts, state.first_value);
      requiredPoints.set(state.last_ts, state.last_value);
      requiredPoints.set(state.minimum_ts, state.minimum);
      requiredPoints.set(state.maximum_ts, state.maximum);
      // A bounded spike envelope can retain first/last/min/max at real epochs.
      maximumVertices += native ? 1 : 4;
    }
  }
  return { count, minimum, maximum, requiredPoints, maximumVertices };
}
