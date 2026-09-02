import { isLiveCapableSelection, resolveTimeRange } from "./resolve";
import { isValidTimezone } from "./timezone";
import type { TimeRangeConfig, TimeRangeValidationError, TimeRangeValue } from "./types";

const MAX_DATE_MS = 8_640_000_000_000_000;

function durationLabel(durationMs: number): string {
  if (durationMs % 86_400_000 === 0) return `${durationMs / 86_400_000} days`;
  if (durationMs % 3_600_000 === 0) return `${durationMs / 3_600_000} hours`;
  return `${durationMs / 60_000} minutes`;
}

export function validateResolvedTimeWindow(
  window: { fromMs: number; toMs: number },
  config: TimeRangeConfig,
): TimeRangeValidationError | null {
  if (!Number.isFinite(window.fromMs) || Math.abs(window.fromMs) > MAX_DATE_MS) {
    return { code: "invalid_instant", field: "from", message: "From must be a valid time." };
  }
  if (!Number.isFinite(window.toMs) || Math.abs(window.toMs) > MAX_DATE_MS) {
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

export function validateTimeRangeValue(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
): TimeRangeValidationError | null {
  if (!isValidTimezone(value.timezone)) {
    return {
      code: "invalid_timezone",
      field: "range",
      message: "Timezone must be a valid IANA timezone.",
    };
  }
  if (value.playback.kind === "paused") {
    if (value.selection.kind === "fixed") {
      return {
        code: "invalid_semantics",
        field: "range",
        message: "A fixed range cannot use paused playback.",
      };
    }
    if (!isLiveCapableSelection(value.selection)) {
      return {
        code: "invalid_semantics",
        field: "range",
        message: "This calendar range cannot be paused or resumed live.",
      };
    }
    const running = {
      playback: { kind: "running" as const },
      selection: value.selection,
      timezone: value.timezone,
    };
    const expected = resolveTimeRange(running, value.playback.toMs, config);
    if (expected.fromMs !== value.playback.fromMs || expected.toMs !== value.playback.toMs) {
      return {
        code: "invalid_semantics",
        field: "range",
        message: "Paused endpoints must match the semantic live range.",
      };
    }
  }
  const resolved = resolveTimeRange(value, nowMs, config);
  return validateResolvedTimeWindow(resolved, config);
}
