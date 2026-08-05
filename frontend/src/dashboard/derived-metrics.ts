import type { LatestQuery, TrendBaseline } from "./api";
import type { Point } from "./types";
import { formatSignedValue, formatValue } from "./units";

export type DerivedMetricId =
  | "capacity-utilization"
  | "demand-growth"
  | "forecast-peak"
  | "historical-comparison"
  | "hours-until-peak"
  | "price-percentile"
  | "renewable-share"
  | "reserve-margin"
  | "storage-state";

export type DerivedMetric = {
  available: boolean;
  detail: string;
  formula: string;
  id: DerivedMetricId;
  label: string;
  observedAt: number | null;
  valueLabel: string;
};

export type LatestPoint = { ts: number; value: number } | null;

export const derivedLatestQueries = [
  {
    id: "fuel-natural-gas",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:natural_gas"],
  },
  { id: "fuel-wind", metric: "ercot.fuel_mix.generation_mw", tags: ["fuel:wind"] },
  { id: "fuel-solar", metric: "ercot.fuel_mix.generation_mw", tags: ["fuel:solar"] },
  {
    id: "fuel-coal",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:coal_and_lignite"],
  },
  { id: "fuel-nuclear", metric: "ercot.fuel_mix.generation_mw", tags: ["fuel:nuclear"] },
  {
    id: "fuel-storage",
    metric: "ercot.fuel_mix.generation_mw",
    tags: ["fuel:power_storage"],
  },
  { id: "storage-net", metric: "ercot.storage.net_output_mw" },
] as const satisfies readonly LatestQuery[];

export const MAX_LATEST_AGE_SECONDS = 30 * 60;
const MAX_COMPARISON_DISTANCE_SECONDS = 60 * 60;
const unavailableDetail = "Required source data or comparison history is unavailable.";

function unavailable(
  id: DerivedMetricId,
  label: string,
  formula: string,
  detail = unavailableDetail,
): DerivedMetric {
  return { available: false, detail, formula, id, label, observedAt: null, valueLabel: "—" };
}

export function freshLatestPoint(
  point: LatestPoint | undefined,
  now: number,
  maxAgeSeconds = MAX_LATEST_AGE_SECONDS,
): Exclude<LatestPoint, null> | null {
  if (
    !point ||
    !Number.isFinite(point.ts) ||
    !Number.isFinite(point.value) ||
    point.ts > now + 60 ||
    now - point.ts > maxAgeSeconds
  ) {
    return null;
  }
  return point;
}

function nearestPoint(points: Point[], target: number, maxDistance: number): Point | null {
  const nearest = points
    .filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value))
    .reduce<Point | null>((best, candidate) => {
      if (!best) return candidate;
      return Math.abs(candidate[0] - target) < Math.abs(best[0] - target) ? candidate : best;
    }, null);
  return nearest && Math.abs(nearest[0] - target) <= maxDistance ? nearest : null;
}

function ordinal(value: number): string {
  const rounded = Math.round(value);
  const mod100 = rounded % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : (["th", "st", "nd", "rd"][rounded % 10] ?? "th");
  return `${rounded}${suffix} percentile`;
}

function percentChange(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

export function buildDerivedMetrics({
  context,
  latest,
  now,
  trendBaselines,
}: {
  context: Map<string, Point[]>;
  latest: Map<string, LatestPoint>;
  now: number;
  trendBaselines: Map<string, TrendBaseline>;
}): DerivedMetric[] {
  const demand = freshLatestPoint(latest.get("demand"), now);
  const capacity = freshLatestPoint(latest.get("capacity"), now);
  const reserveFormula = "(available capacity − demand) ÷ demand × 100";
  const reserve =
    demand && capacity && demand.value > 0
      ? {
          available: true,
          detail: "Available capacity remaining above current demand.",
          formula: reserveFormula,
          id: "reserve-margin" as const,
          label: "Reserve Margin %",
          observedAt: Math.min(demand.ts, capacity.ts),
          valueLabel: formatValue(((capacity.value - demand.value) / demand.value) * 100, "%"),
        }
      : unavailable("reserve-margin", "Reserve Margin %", reserveFormula);

  const utilizationFormula = "demand ÷ available capacity × 100";
  const utilization =
    demand && capacity && capacity.value > 0
      ? {
          available: true,
          detail: "Share of currently available capacity serving demand.",
          formula: utilizationFormula,
          id: "capacity-utilization" as const,
          label: "Capacity Utilization %",
          observedAt: Math.min(demand.ts, capacity.ts),
          valueLabel: formatValue((demand.value / capacity.value) * 100, "%"),
        }
      : unavailable("capacity-utilization", "Capacity Utilization %", utilizationFormula);

  const fuelIds = [
    "fuel-natural-gas",
    "fuel-wind",
    "fuel-solar",
    "fuel-coal",
    "fuel-nuclear",
    "fuel-storage",
  ] as const;
  const fuels = fuelIds.map((id) => freshLatestPoint(latest.get(id), now));
  const renewableFormula = "(wind + solar) ÷ total reported fuel generation × 100";
  const totalFuel = fuels.every(Boolean)
    ? fuels.reduce((total, point) => total + (point?.value ?? 0), 0)
    : null;
  const wind = fuels[1];
  const solar = fuels[2];
  const renewable =
    wind && solar && totalFuel !== null && totalFuel > 0
      ? {
          available: true,
          detail: "Wind and solar share of the six reported fuel categories.",
          formula: renewableFormula,
          id: "renewable-share" as const,
          label: "Renewable %",
          observedAt: Math.min(...fuels.map((point) => point?.ts ?? now)),
          valueLabel: formatValue(((wind.value + solar.value) / totalFuel) * 100, "%"),
        }
      : unavailable("renewable-share", "Renewable %", renewableFormula);

  const storage = freshLatestPoint(latest.get("storage-net"), now);
  const storageFormula = "net output: above +50 MW discharging; below −50 MW charging";
  const storageState = storage
    ? {
        available: true,
        detail: `Net output ${formatSignedValue(storage.value, "MW")}.`,
        formula: storageFormula,
        id: "storage-state" as const,
        label: "Storage State",
        observedAt: storage.ts,
        valueLabel: storage.value > 50 ? "Discharging" : storage.value < -50 ? "Charging" : "Idle",
      }
    : unavailable("storage-state", "Storage State", storageFormula);

  const baseline = trendBaselines.get("demand") ?? null;
  const validBaseline =
    baseline && Math.abs(baseline[0] - (now - 3600)) <= MAX_COMPARISON_DISTANCE_SECONDS
      ? baseline
      : null;
  const growthValue =
    demand && validBaseline ? percentChange(demand.value, validBaseline[1]) : null;
  const growthFormula = "(current demand − demand one hour ago) ÷ demand one hour ago × 100";
  const demandGrowth =
    demand && validBaseline && growthValue !== null
      ? {
          available: true,
          detail: `Demand was ${formatValue(validBaseline[1], "MW")} one hour ago.`,
          formula: growthFormula,
          id: "demand-growth" as const,
          label: "Demand Growth",
          observedAt: demand.ts,
          valueLabel: formatSignedValue(growthValue, "%"),
        }
      : unavailable("demand-growth", "Demand Growth", growthFormula);

  const forecastPoints = (context.get("derived:forecast-demand") ?? []).filter(
    ([timestamp, value]) =>
      timestamp >= now && timestamp <= now + 24 * 3600 && Number.isFinite(value),
  );
  const forecastPeak = forecastPoints.reduce<Point | null>(
    (peak, point) => (!peak || point[1] > peak[1] ? point : peak),
    null,
  );
  const forecastFormula = "maximum forecast demand over the next 24 hours";
  const peakMetric = forecastPeak
    ? {
        available: true,
        detail: `Expected ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(forecastPeak[0] * 1000))}.`,
        formula: forecastFormula,
        id: "forecast-peak" as const,
        label: "Forecast Peak",
        observedAt: forecastPeak[0],
        valueLabel: formatValue(forecastPeak[1], "MW"),
      }
    : unavailable("forecast-peak", "Forecast Peak", forecastFormula);

  const hoursFormula = "forecast peak timestamp − current time";
  const hoursMetric = forecastPeak
    ? {
        available: true,
        detail: "Time remaining until the next 24-hour forecast maximum.",
        formula: hoursFormula,
        id: "hours-until-peak" as const,
        label: "Hours Until Peak",
        observedAt: forecastPeak[0],
        valueLabel: formatValue((forecastPeak[0] - now) / 3600, "hours"),
      }
    : unavailable("hours-until-peak", "Hours Until Peak", hoursFormula);

  const price = freshLatestPoint(latest.get("price"), now);
  const priceHistory = (context.get("derived:price-history") ?? []).filter(
    ([timestamp, value]) =>
      timestamp >= now - 24 * 3600 && timestamp <= now && Number.isFinite(value),
  );
  const priceFormula = "percent of Houston prices in the past 24 hours at or below current price";
  const percentile =
    price && priceHistory.length
      ? (priceHistory.filter(([, value]) => value <= price.value).length / priceHistory.length) *
        100
      : null;
  const pricePercentile =
    price && percentile !== null
      ? {
          available: true,
          detail: `${priceHistory.length} Houston observations in the comparison window.`,
          formula: priceFormula,
          id: "price-percentile" as const,
          label: "Price Percentile",
          observedAt: price.ts,
          valueLabel: ordinal(percentile),
        }
      : unavailable("price-percentile", "Price Percentile", priceFormula);

  const yesterday = nearestPoint(
    context.get("derived:demand-yesterday") ?? [],
    now - 24 * 3600,
    MAX_COMPARISON_DISTANCE_SECONDS,
  );
  const historicalValue = demand && yesterday ? percentChange(demand.value, yesterday[1]) : null;
  const historicalFormula = "(current demand − demand 24 hours ago) ÷ demand 24 hours ago × 100";
  const historical =
    demand && yesterday && historicalValue !== null
      ? {
          available: true,
          detail: `Demand was ${formatValue(yesterday[1], "MW")} at this time yesterday.`,
          formula: historicalFormula,
          id: "historical-comparison" as const,
          label: "Historical Comparison",
          observedAt: demand.ts,
          valueLabel: formatSignedValue(historicalValue, "%"),
        }
      : unavailable("historical-comparison", "Historical Comparison", historicalFormula);

  return [
    reserve,
    utilization,
    renewable,
    storageState,
    demandGrowth,
    peakMetric,
    hoursMetric,
    pricePercentile,
    historical,
  ];
}
