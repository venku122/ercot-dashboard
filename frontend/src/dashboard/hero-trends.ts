import { formatValue } from "./units";

export type HeroTrendDirection = "down" | "steady" | "unavailable" | "up";

export type HeroTrend = {
  arrow: "▲" | "▼" | "—";
  comparisonLabel: "Last hour";
  deltaLabel: string;
  direction: HeroTrendDirection;
  observedAt: number | null;
  timestampLabel: string;
};

function formatTimestamp(timestamp: number | null) {
  if (timestamp === null || !Number.isFinite(timestamp)) return "Update time unavailable";
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
  return `Updated ${formatted}`;
}

export function buildHeroTrend(
  current: number | null,
  baseline: number | null,
  unit: string,
  observedAt: number | null,
): HeroTrend {
  const timestampLabel = formatTimestamp(observedAt);
  if (
    current === null ||
    baseline === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(baseline)
  ) {
    return unavailableHeroTrend(observedAt);
  }

  const delta = current - baseline;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(current), Math.abs(baseline));
  if (Math.abs(delta) <= tolerance) {
    return {
      arrow: "—",
      comparisonLabel: "Last hour",
      deltaLabel: "No change",
      direction: "steady",
      observedAt,
      timestampLabel,
    };
  }

  return {
    arrow: delta > 0 ? "▲" : "▼",
    comparisonLabel: "Last hour",
    deltaLabel: `${delta > 0 ? "+" : "−"}${formatValue(Math.abs(delta), unit)}`,
    direction: delta > 0 ? "up" : "down",
    observedAt,
    timestampLabel,
  };
}

export function unavailableHeroTrend(observedAt: number | null): HeroTrend {
  return {
    arrow: "—",
    comparisonLabel: "Last hour",
    deltaLabel: "Trend unavailable",
    direction: "unavailable",
    observedAt,
    timestampLabel: formatTimestamp(observedAt),
  };
}
