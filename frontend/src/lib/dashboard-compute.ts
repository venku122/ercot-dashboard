export type Transform = {
  bucket_seconds?: number;
  label?: string;
  mode?: string;
  seasonal_period?: number;
} | null;

export type PointTuple = [number, number];

export type LatestPoint = {
  ts: number;
  value: number;
};

type MetricConfig = {
  metric: string;
  tag?: string;
};

type ComputeNode = {
  left?: ChartConfig;
  op: string;
  right?: ChartConfig;
  series?: Array<ChartConfig>;
  source?: ChartConfig;
};

export type ChartConfig = {
  compute?: ComputeNode;
  metric?: string;
  tag?: string;
};

export type LatestQuery = {
  id: string;
  metric: string;
  tags: Array<string>;
};

function hasMetric(config: ChartConfig): config is ChartConfig & MetricConfig {
  return typeof config.metric === "string";
}

export function keyFor(metric: string, since: number | null, tags: Array<string>, until?: number) {
  return JSON.stringify({ metric, since, until, tags: tags || [] });
}

export function seriesKey(metric: string, tags: Array<string>, transform: Transform) {
  return JSON.stringify({ metric, tags: tags || [], transform: transform || null });
}

function alignSeriesList(seriesList: Array<Array<PointTuple>>) {
  const counts = new Map<string, number>();
  const sums = new Map<string, number>();
  for (const series of seriesList) {
    for (const [ts, value] of series) {
      const key = String(ts);
      sums.set(key, (sums.get(key) || 0) + value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const aligned: Array<PointTuple> = [];
  for (const [key, sum] of sums.entries()) {
    if (counts.get(key) !== seriesList.length) continue;
    aligned.push([Number.parseInt(key, 10), sum]);
  }
  aligned.sort((a, b) => a[0] - b[0]);
  return aligned;
}

function alignSeries(left: Array<PointTuple>, right: Array<PointTuple>) {
  const rightMap = new Map(right.map(([ts, value]) => [ts, value]));
  const merged: Array<PointTuple> = [];
  for (const [ts, value] of left) {
    const rightValue = rightMap.get(ts);
    if (rightValue === undefined) continue;
    merged.push([ts, value - rightValue]);
  }
  return merged;
}

function metricKey(config: MetricConfig, transform: Transform) {
  return seriesKey(config.metric, config.tag ? [config.tag] : [], transform);
}

function latestKey(config: MetricConfig) {
  return keyFor(config.metric, null, config.tag ? [config.tag] : []);
}

export function collectLatestQueries(
  config: ChartConfig,
  queries: Map<string, LatestQuery>,
  labels: Map<string, ChartConfig>,
) {
  if (hasMetric(config)) {
    const id = latestKey(config);
    if (!queries.has(id)) {
      queries.set(id, { id, metric: config.metric, tags: config.tag ? [config.tag] : [] });
    }
    labels.set(id, config);
    return;
  }

  const compute = config.compute;
  if (!compute) return;

  if (compute.op === "latest_minus") {
    if (compute.left) collectLatestQueries(compute.left, queries, labels);
    if (compute.right) collectLatestQueries(compute.right, queries, labels);
    return;
  }

  if (compute.op === "latest_sum" || compute.op === "max_latest") {
    for (const series of compute.series || []) {
      collectLatestQueries(series, queries, labels);
    }
    return;
  }

  if (compute.op === "latest_sum_all" && compute.source) {
    collectLatestQueries(compute.source, queries, labels);
  }
}

export function computeSeriesFromMap(
  config: ChartConfig,
  seriesMap: Map<string, Array<PointTuple>>,
  transform: Transform,
): Array<PointTuple> {
  if (hasMetric(config)) {
    return seriesMap.get(metricKey(config, transform)) || [];
  }

  const compute = config.compute;
  if (!compute) return [];

  if (compute.op === "minus" && compute.left && compute.right) {
    return alignSeries(
      computeSeriesFromMap(compute.left, seriesMap, transform),
      computeSeriesFromMap(compute.right, seriesMap, transform),
    );
  }

  if (compute.op === "sum") {
    return alignSeriesList(
      (compute.series || []).map((series) => computeSeriesFromMap(series, seriesMap, transform)),
    );
  }

  if (compute.op === "clip_positive" && compute.source) {
    return computeSeriesFromMap(compute.source, seriesMap, transform).map(([ts, value]) => [
      ts,
      Math.max(0, value),
    ]);
  }

  if (compute.op === "diff" && compute.source) {
    const raw = computeSeriesFromMap(compute.source, seriesMap, transform);
    const output: Array<PointTuple> = [];
    for (let i = 1; i < raw.length; i += 1) {
      const [ts, value] = raw[i];
      output.push([ts, value - raw[i - 1][1]]);
    }
    return output;
  }

  if (compute.op === "sum_all" && compute.source) {
    return computeSeriesFromMap(compute.source, seriesMap, transform);
  }

  return [];
}

export function computeLatestFromMap(
  config: ChartConfig,
  latestMap: Map<string, LatestPoint | null>,
): LatestPoint | null {
  if (hasMetric(config)) {
    return latestMap.get(latestKey(config)) || null;
  }

  const compute = config.compute;
  if (!compute) return null;

  if (compute.op === "latest_minus" && compute.left && compute.right) {
    const left = computeLatestFromMap(compute.left, latestMap);
    const right = computeLatestFromMap(compute.right, latestMap);
    if (!left || !right) return null;
    return { ts: Math.max(left.ts, right.ts), value: left.value - right.value };
  }

  if (compute.op === "latest_sum") {
    const points = (compute.series || [])
      .map((series) => computeLatestFromMap(series, latestMap))
      .filter((point): point is LatestPoint => point !== null);
    if (!points.length) return null;
    return {
      ts: Math.max(...points.map((point) => point.ts)),
      value: points.reduce((sum, point) => sum + point.value, 0),
    };
  }

  if (compute.op === "max_latest") {
    const points = (compute.series || [])
      .map((series) => computeLatestFromMap(series, latestMap))
      .filter((point): point is LatestPoint => point !== null);
    if (!points.length) return null;
    return points.reduce((best, current) => (current.value > best.value ? current : best));
  }

  if (compute.op === "latest_sum_all" && compute.source) {
    return computeLatestFromMap(compute.source, latestMap);
  }

  return null;
}
