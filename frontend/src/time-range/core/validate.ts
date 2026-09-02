import type { TimeRangeConfig, TimeRangeValidationError } from "./types";

function durationLabel(durationMs: number): string {
  if (durationMs % 86_400_000 === 0) return `${durationMs / 86_400_000} days`;
  if (durationMs % 3_600_000 === 0) return `${durationMs / 3_600_000} hours`;
  return `${durationMs / 60_000} minutes`;
}

export function validateResolvedTimeWindow(
  window: { fromMs: number; toMs: number },
  config: TimeRangeConfig,
): TimeRangeValidationError | null {
  if (!Number.isFinite(window.fromMs)) {
    return { code: "invalid_instant", field: "from", message: "From must be a valid time." };
  }
  if (!Number.isFinite(window.toMs)) {
    return { code: "invalid_instant", field: "to", message: "To must be a valid time." };
  }
  if (window.fromMs >= window.toMs) {
    return {
      code: "from_not_before_to",
      field: "range",
      message: "From must be earlier than To.",
    };
  }
  const durationMs = window.toMs - window.fromMs;
  if (durationMs < config.minDurationMs) {
    return {
      code: "range_too_short",
      field: "range",
      message: `Time range must be at least ${durationLabel(config.minDurationMs)}.`,
    };
  }
  if (durationMs > config.maxDurationMs) {
    return {
      code: "range_too_long",
      field: "range",
      message: `Time range must be no more than ${durationLabel(config.maxDurationMs)}.`,
    };
  }
  return null;
}
