type NormalizedUnit = {
  maximumFractionDigits: number;
  minimumFractionDigits: number;
  unit: string;
  value: number;
};

const precisionByUnit: Record<string, readonly [minimum: number, maximum: number]> = {
  "$ per MWh": [2, 2],
  "%": [1, 1],
  "°C": [1, 1],
  GW: [1, 1],
  GW·s: [1, 1],
  Hz: [3, 3],
  MW: [1, 1],
  MWh: [1, 1],
  mph: [1, 1],
  "s/min": [3, 3],
  seconds: [1, 1],
  TW·s: [1, 1],
  customers: [0, 0],
  level: [0, 0],
};

export function normalizeUnit(value: number, unit: string): NormalizedUnit {
  let normalizedValue = value;
  let normalizedUnit = unit === "$/MWh" ? "$ per MWh" : unit;

  if (unit === "MW" && Math.abs(value) >= 1000) {
    normalizedValue = value / 1000;
    normalizedUnit = "GW";
  } else if (unit === "GW·s" && Math.abs(value) >= 1000) {
    normalizedValue = value / 1000;
    normalizedUnit = "TW·s";
  }

  const [minimumFractionDigits, maximumFractionDigits] = precisionByUnit[normalizedUnit] ?? [0, 1];
  return {
    maximumFractionDigits,
    minimumFractionDigits,
    unit: normalizedUnit,
    value: normalizedValue,
  };
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const normalized = normalizeUnit(value, unit);
  const absoluteValue =
    normalized.unit === "$ per MWh" ? Math.abs(normalized.value) : normalized.value;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: normalized.maximumFractionDigits,
    minimumFractionDigits: normalized.minimumFractionDigits,
    useGrouping: true,
  }).format(absoluteValue);

  if (normalized.unit === "$ per MWh") {
    return `${normalized.value < 0 ? "-" : ""}$${formatted}/MWh`;
  }
  if (normalized.unit === "%") return `${formatted}%`;
  return `${formatted} ${normalized.unit}`;
}

export function formatSignedValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return formatValue(0, unit);
  return `${value > 0 ? "+" : "−"}${formatValue(Math.abs(value), unit)}`;
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown age";
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h old`;
  return `${Math.floor(seconds / 86400)}d old`;
}
