import type { Point } from "./types";

export type SeriesStats = {
  average: number | null;
  latest: number | null;
  maximum: number | null;
  minimum: number | null;
  sum: number | null;
};

export function seriesStats(points: Point[]): SeriesStats {
  if (!points.length) {
    return { average: null, latest: null, maximum: null, minimum: null, sum: null };
  }
  const values = points.map((point) => point[1]);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    average: sum / values.length,
    latest: values.at(-1) ?? null,
    maximum: Math.max(...values),
    minimum: Math.min(...values),
    sum,
  };
}
