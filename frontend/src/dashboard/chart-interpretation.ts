import type {
  ChartDefinition,
  ChartInterpretation,
  InterpretationBand,
  LoadedSeries,
} from "./types";
import { formatValue } from "./units";

export type ResolvedInterpretationBand = InterpretationBand & {
  lowerValue: number | undefined;
  upperValue: number | undefined;
};

function latestFiniteValue(loaded: LoadedSeries | undefined) {
  for (let index = (loaded?.points.length ?? 0) - 1; index >= 0; index -= 1) {
    const value = loaded?.points[index]?.[1];
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

export function resolveInterpretationBands(
  interpretation: ChartInterpretation,
  seriesData: Map<string, LoadedSeries>,
): ResolvedInterpretationBand[] {
  if (interpretation.mode === "absolute") {
    return interpretation.bands.map((band) => ({
      ...band,
      lowerValue: band.lower,
      upperValue: band.upper,
    }));
  }

  const reference = latestFiniteValue(seriesData.get(interpretation.referenceSeriesKey));
  if (reference === null || reference <= 0) return [];
  return interpretation.bands.map((band) => ({
    ...band,
    lowerValue: band.lower === undefined ? undefined : band.lower * reference,
    upperValue: band.upper === undefined ? undefined : band.upper * reference,
  }));
}

export function formatInterpretationRange(
  interpretation: ChartInterpretation,
  band: InterpretationBand,
  unit: string,
) {
  const format = (value: number) =>
    interpretation.mode === "reference-ratio"
      ? formatValue(value * 100, "%")
      : formatValue(value, unit);
  if (band.lower === undefined) return `Below ${format(band.upper!)}`;
  if (band.upper === undefined) return `${format(band.lower)} or above`;
  return `${format(band.lower)}–${format(band.upper)}`;
}

export function interpretationAriaDescription(chart: ChartDefinition) {
  const interpretation = chart.interpretation;
  if (!interpretation) return "";
  const bands = interpretation.bands
    .map((band) => `${band.label}, ${formatInterpretationRange(interpretation, band, chart.unit)}`)
    .join("; ");
  return `Interpretation guide for ${interpretation.subject}. ${interpretation.basis}. ${bands}.`;
}

export function interpretationPolicyIssues(chart: ChartDefinition) {
  const interpretation = chart.interpretation;
  if (!interpretation) return [];
  const issues: string[] = [];
  if (!chart.series.some((series) => series.id === interpretation.subjectSeriesId)) {
    issues.push(`${chart.id}: missing subject series ${interpretation.subjectSeriesId}`);
  }
  if (!interpretation.bands.length) issues.push(`${chart.id}: no interpretation bands`);
  interpretation.bands.forEach((band, index) => {
    if (index === 0 && band.lower !== undefined) {
      issues.push(`${chart.id}:${band.id}: first band must be open below`);
    }
    if (index === interpretation.bands.length - 1 && band.upper !== undefined) {
      issues.push(`${chart.id}:${band.id}: last band must be open above`);
    }
    if (band.lower !== undefined && band.upper !== undefined && band.lower >= band.upper) {
      issues.push(`${chart.id}:${band.id}: lower must be less than upper`);
    }
    const previous = interpretation.bands[index - 1];
    if (previous && previous.upper !== band.lower) {
      issues.push(`${chart.id}:${band.id}: bands must be contiguous`);
    }
  });
  if (
    interpretation.mode === "reference-ratio" &&
    !interpretation.referenceSeriesKey.includes(":")
  ) {
    issues.push(`${chart.id}: reference series key must include chart and series ids`);
  }
  return issues;
}
