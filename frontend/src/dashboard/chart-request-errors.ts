import type { ChartDefinition } from "./types";

export type ChartRequestErrors = Map<string, Map<string, string>>;

/** Update only the series in the completed request cohort, preserving unrelated failures. */
export function updateChartRequestErrors(
  previous: ChartRequestErrors,
  charts: ChartDefinition[],
  error: string | null,
): ChartRequestErrors {
  let next = previous;
  for (const chart of charts) {
    const current = next.get(chart.id);
    const changed = chart.series.some((series) => (current?.get(series.id) ?? null) !== error);
    if (!changed) continue;
    if (next === previous) next = new Map(previous);
    const cohort = new Map(current);
    for (const series of chart.series) {
      if (error === null) cohort.delete(series.id);
      else cohort.set(series.id, error);
    }
    if (cohort.size) next.set(chart.id, cohort);
    else next.delete(chart.id);
  }
  return next;
}

export function chartRequestError(
  errors: ChartRequestErrors,
  chart: ChartDefinition,
): string | null {
  const id = chart.id === "pricing-collection" ? "pricing" : chart.id;
  const cohort = errors.get(id);
  return chart.series.map((series) => cohort?.get(series.id)).find(Boolean) ?? null;
}
