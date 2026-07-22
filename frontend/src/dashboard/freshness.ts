export type Freshness = "delayed" | "fresh" | "stale";

export function freshnessState(ageSeconds: number | null, expectedSeconds: number): Freshness {
  if (ageSeconds === null || ageSeconds > expectedSeconds * 4) return "stale";
  if (ageSeconds > expectedSeconds * 2) return "delayed";
  return "fresh";
}
