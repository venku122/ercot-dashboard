import type { LatestQuery } from "./api";
import { freshLatestPoint, type LatestPoint } from "./derived-metrics";
import type { Point } from "./types";
import { formatSignedValue, formatValue } from "./units";

export type GridHealthFactorId =
  | "capacity"
  | "eea"
  | "forecast"
  | "frequency"
  | "outages"
  | "prices"
  | "reserve-margin"
  | "weather";

export type GridHealthStatus =
  | "critical"
  | "limited"
  | "normal"
  | "strained"
  | "unavailable"
  | "watch";

export type GridHealthFactor = {
  available: boolean;
  detail: string;
  id: GridHealthFactorId;
  label: string;
  penalty: number | null;
  weight: number;
};

export type GridHealthScore = {
  coveragePercent: number;
  detail: string;
  factors: GridHealthFactor[];
  label: "CRITICAL" | "LIMITED DATA" | "NORMAL" | "SCORE UNAVAILABLE" | "STRAINED" | "WATCH";
  score: number | null;
  status: GridHealthStatus;
};

export const healthLatestQueries = [
  { id: "health-eea", metric: "ercot.eea_level" },
  { id: "health-outages", metric: "ercot.generation_outages.total_mw" },
  { id: "health-weather-dfw", metric: "metar.temperature", tags: ["metar_code:KDFW"] },
  { id: "health-weather-austin", metric: "metar.temperature", tags: ["metar_code:KAUS"] },
  { id: "health-weather-houston", metric: "metar.temperature", tags: ["metar_code:KHOU"] },
  {
    id: "health-weather-san-antonio",
    metric: "metar.temperature",
    tags: ["metar_code:KSAT"],
  },
] as const satisfies readonly LatestQuery[];

const MIN_SCORE_COVERAGE = 70;
const weatherIds = [
  "health-weather-dfw",
  "health-weather-austin",
  "health-weather-houston",
  "health-weather-san-antonio",
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function interpolate(value: number, stops: ReadonlyArray<readonly [number, number]>) {
  if (value <= stops[0]![0]) return stops[0]![1];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]!;
    const next = stops[index]!;
    if (value <= next[0]) {
      const progress = (value - previous[0]) / (next[0] - previous[0]);
      return previous[1] + progress * (next[1] - previous[1]);
    }
  }
  return stops.at(-1)![1];
}

function factor(
  id: GridHealthFactorId,
  label: string,
  weight: number,
  penalty: number | null,
  detail: string,
): GridHealthFactor {
  return {
    available: penalty !== null,
    detail,
    id,
    label,
    penalty: penalty === null ? null : clamp(penalty, 0, weight),
    weight,
  };
}

function statusFor(score: number | null, coverage: number, eeaLevel: number | null) {
  if (score === null) {
    return { label: "SCORE UNAVAILABLE" as const, status: "unavailable" as const };
  }
  if (eeaLevel !== null && eeaLevel >= 3) {
    return { label: "CRITICAL" as const, status: "critical" as const };
  }
  if (eeaLevel !== null && eeaLevel >= 2) {
    return { label: "STRAINED" as const, status: "strained" as const };
  }
  if (eeaLevel !== null && eeaLevel >= 1) {
    return { label: "WATCH" as const, status: "watch" as const };
  }
  if (score < 50) return { label: "CRITICAL" as const, status: "critical" as const };
  if (score < 70) return { label: "STRAINED" as const, status: "strained" as const };
  if (score < 85) return { label: "WATCH" as const, status: "watch" as const };
  if (coverage < 100) {
    return { label: "LIMITED DATA" as const, status: "limited" as const };
  }
  return { label: "NORMAL" as const, status: "normal" as const };
}

export function buildGridHealthScore({
  context,
  latest,
  now,
}: {
  context: Map<string, Point[]>;
  latest: Map<string, LatestPoint>;
  now: number;
}): GridHealthScore {
  const demand = freshLatestPoint(latest.get("demand"), now);
  const capacity = freshLatestPoint(latest.get("capacity"), now);
  const frequency = freshLatestPoint(latest.get("frequency"), now);
  const eea = freshLatestPoint(latest.get("health-eea"), now);
  const outages = freshLatestPoint(latest.get("health-outages"), now);
  const price = freshLatestPoint(latest.get("price"), now);
  const weather = weatherIds
    .map((id) => freshLatestPoint(latest.get(id), now, 2 * 3600))
    .filter((point): point is NonNullable<LatestPoint> => point !== null);
  const forecast = (context.get("derived:forecast-demand") ?? [])
    .filter(
      ([timestamp, value]) =>
        timestamp >= now && timestamp <= now + 24 * 3600 && Number.isFinite(value),
    )
    .reduce<Point | null>((peak, point) => (!peak || point[1] > peak[1] ? point : peak), null);

  const reserveMargin =
    demand && capacity && demand.value > 0
      ? ((capacity.value - demand.value) / demand.value) * 100
      : null;
  const reservePenalty =
    reserveMargin === null
      ? null
      : interpolate(reserveMargin, [
          [-5, 25],
          [0, 25],
          [5, 20],
          [10, 10],
          [15, 0],
        ]);

  const frequencyDeviation = frequency ? Math.abs(frequency.value - 60) : null;
  const frequencyPenalty =
    frequencyDeviation === null
      ? null
      : interpolate(frequencyDeviation, [
          [0.02, 0],
          [0.05, 5],
          [0.1, 10],
          [0.2, 15],
        ]);

  const eeaLevel = eea ? Math.max(0, Math.round(eea.value)) : null;
  const eeaPenalty = eeaLevel === null ? null : [0, 5, 10, 15][Math.min(3, eeaLevel)]!;
  const outagePercent =
    outages && capacity && capacity.value > 0 ? (outages.value / capacity.value) * 100 : null;
  const outagePenalty =
    outagePercent === null
      ? null
      : interpolate(outagePercent, [
          [5, 0],
          [8, 4],
          [12, 8],
          [20, 10],
        ]);

  const pricePenalty = price
    ? price.value >= 0
      ? interpolate(price.value, [
          [100, 0],
          [500, 3],
          [1000, 6],
          [5000, 10],
        ])
      : interpolate(Math.abs(price.value), [
          [0, 0],
          [50, 2],
          [250, 6],
          [1000, 10],
        ])
    : null;

  const temperatures = weather.map((point) => point.value);
  const maximumTemperature = temperatures.length ? Math.max(...temperatures) : null;
  const minimumTemperature = temperatures.length ? Math.min(...temperatures) : null;
  const heatPenalty =
    maximumTemperature === null
      ? null
      : interpolate(maximumTemperature, [
          [35, 0],
          [40, 3],
          [45, 5],
        ]);
  const coldPenalty =
    minimumTemperature === null
      ? null
      : interpolate(-minimumTemperature, [
          [0, 0],
          [10, 3],
          [20, 5],
        ]);
  const weatherPenalty =
    heatPenalty === null || coldPenalty === null ? null : Math.max(heatPenalty, coldPenalty);

  const utilization =
    demand && capacity && capacity.value > 0 ? (demand.value / capacity.value) * 100 : null;
  const capacityPenalty =
    utilization === null
      ? null
      : interpolate(utilization, [
          [80, 0],
          [90, 5],
          [100, 10],
        ]);
  const forecastPressure =
    forecast && capacity && capacity.value > 0 ? (forecast[1] / capacity.value) * 100 : null;
  const forecastPenalty =
    forecastPressure === null
      ? null
      : interpolate(forecastPressure, [
          [85, 0],
          [95, 5],
          [100, 10],
        ]);

  const factors = [
    factor(
      "reserve-margin",
      "Reserve margin",
      25,
      reservePenalty,
      reserveMargin === null
        ? "Fresh demand and capacity required."
        : `${formatValue(reserveMargin, "%")} available above demand.`,
    ),
    factor(
      "frequency",
      "Frequency",
      15,
      frequencyPenalty,
      frequency
        ? `${formatValue(frequency.value, "Hz")} observed; nominal is 60 Hz.`
        : "Fresh frequency required.",
    ),
    factor(
      "eea",
      "EEA level",
      15,
      eeaPenalty,
      eeaLevel === null ? "Fresh EEA state required." : `ERCOT EEA level ${String(eeaLevel)}.`,
    ),
    factor(
      "outages",
      "Generation outages",
      10,
      outagePenalty,
      outagePercent === null
        ? "Fresh outage and capacity data required."
        : `${formatValue(outages?.value ?? null, "MW")} unavailable, ${formatValue(outagePercent, "%")} of capacity.`,
    ),
    factor(
      "prices",
      "Houston price",
      10,
      pricePenalty,
      price
        ? `${formatSignedValue(price.value, "$/MWh")} current settlement price.`
        : "Fresh Houston price required.",
    ),
    factor(
      "weather",
      "Weather stress",
      5,
      weatherPenalty,
      maximumTemperature === null || minimumTemperature === null
        ? "At least one METAR temperature no more than two hours old is required."
        : `${formatValue(minimumTemperature, "°C")} to ${formatValue(maximumTemperature, "°C")} across ${String(weather.length)} stations.`,
    ),
    factor(
      "capacity",
      "Capacity utilization",
      10,
      capacityPenalty,
      utilization === null
        ? "Fresh demand and capacity required."
        : `${formatValue(utilization, "%")} of available capacity in use.`,
    ),
    factor(
      "forecast",
      "Forecast pressure",
      10,
      forecastPenalty,
      forecastPressure === null
        ? "A next-24-hour demand forecast and fresh capacity are required."
        : `Forecast peak is ${formatValue(forecastPressure, "%")} of current capacity.`,
    ),
  ];

  const availableFactors = factors.filter((entry) => entry.available);
  const coveragePercent = availableFactors.reduce((total, entry) => total + entry.weight, 0);
  const coreAvailable = factors
    .filter((entry) => ["capacity", "frequency", "reserve-margin"].includes(entry.id))
    .every((entry) => entry.available);
  const totalPenalty = availableFactors.reduce((total, entry) => total + (entry.penalty ?? 0), 0);
  const score =
    coreAvailable && coveragePercent >= MIN_SCORE_COVERAGE
      ? Math.round(100 * (1 - totalPenalty / coveragePercent))
      : null;
  const state = statusFor(score, coveragePercent, eeaLevel);
  const missingCount = factors.length - availableFactors.length;
  const detail =
    score === null
      ? `Fresh core readings and at least ${String(MIN_SCORE_COVERAGE)}% weighted coverage are required.`
      : missingCount
        ? `${String(coveragePercent)}% weighted coverage; ${String(missingCount)} factor${missingCount === 1 ? " is" : "s are"} unavailable.`
        : "All eight weighted factors are current and included.";

  return { coveragePercent, detail, factors, score, ...state };
}
