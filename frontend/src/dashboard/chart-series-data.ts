import { seriesKey } from "./chart-config";
import type { ChartDefinition, LoadedSeries } from "./types";

/** Cache only plot dependencies; other card consumers keep the complete source map. */
export function retainChartSeriesData(
  chart: ChartDefinition,
  source: Map<string, LoadedSeries>,
  previous: Map<string, LoadedSeries> | undefined,
): Map<string, LoadedSeries> {
  const keys = new Set(chart.series.map((series) => seriesKey(chart.id, series.id)));
  if (chart.interpretation?.mode === "reference-ratio") {
    keys.add(chart.interpretation.referenceSeriesKey);
  }
  let present = 0;
  let unchanged = Boolean(previous);
  for (const key of keys) {
    const loaded = source.get(key);
    if (loaded !== undefined) present += 1;
    if (loaded !== previous?.get(key)) unchanged = false;
  }
  if (unchanged && previous?.size === present) return previous;
  return new Map(
    [...keys].flatMap((key) => {
      const loaded = source.get(key);
      return loaded === undefined ? [] : [[key, loaded] as const];
    }),
  );
}
