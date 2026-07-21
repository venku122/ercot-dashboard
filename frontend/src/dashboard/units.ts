export function formatValue(value: number | null, unit: string, compact = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const maximumFractionDigits = unit === "Hz" ? 3 : absolute < 10 ? 2 : 1;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    notation: compact && absolute >= 1000 ? "compact" : "standard",
  }).format(value);
  return `${formatted} ${unit}`;
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown age";
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h old`;
  return `${Math.floor(seconds / 86400)}d old`;
}
