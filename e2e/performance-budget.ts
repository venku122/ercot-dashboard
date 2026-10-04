export type PerformanceMeasurements = {
  coldMs: number[];
  pointerMs: number[];
  readoutChanges: number;
  hoverHistoryRequests: number;
};
export function evaluatePerformanceBudget(value: PerformanceMeasurements) {
  const percentile = (samples: number[], fraction: number) =>
    [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1] ?? Infinity;
  const coldMedianMs = percentile(value.coldMs, 0.5);
  const pointerP95Ms = percentile(value.pointerMs, 0.95);
  const failures: string[] = [];
  if (value.coldMs.length !== 5 || value.coldMs.some((n) => !Number.isFinite(n) || n <= 0))
    failures.push("five valid cold contexts required");
  if (coldMedianMs > 2500) failures.push("cold median exceeds 2500ms");
  if (value.pointerMs.length < 200 || value.pointerMs.some((n) => !Number.isFinite(n) || n <= 0))
    failures.push("at least 200 valid pointer samples required");
  if (pointerP95Ms > 50) failures.push("pointer p95 exceeds 50ms");
  if (
    !Number.isInteger(value.readoutChanges) ||
    value.readoutChanges < 200 ||
    value.readoutChanges > value.pointerMs.length
  )
    failures.push("actual changing readouts required");
  if (value.hoverHistoryRequests !== 0) failures.push("hover must perform zero history requests");
  return { pass: failures.length === 0, failures, coldMedianMs, pointerP95Ms };
}
