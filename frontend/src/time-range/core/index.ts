import { DAY_MS, MINUTE_MS, type TimeRangeConfig } from "./types";

export const DEFAULT_TIME_RANGE_CONFIG: TimeRangeConfig = {
  defaultTimezone: "UTC",
  locale: "en-US",
  maxDurationMs: 365 * DAY_MS,
  minDurationMs: 5 * MINUTE_MS,
};

export * from "./codec";
export * from "./resolve";
export * from "./timezone";
export * from "./transitions";
export * from "./types";
export * from "./validate";
