export function historicalContextAsOf(end: number): number {
  if (!Number.isFinite(end) || end < 0) throw new Error("invalid_historical_context_as_of");
  return Math.floor(end / 3_600) * 3_600;
}
