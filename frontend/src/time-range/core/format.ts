import { resolveTimeRange } from "./resolve";
import type { TimeRangeConfig, TimeRangeValue } from "./types";

export function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    remainingMinutes ? `${remainingMinutes}m` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatInstant(instantMs: number, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: timezone,
  }).format(instantMs);
}

export function formatTimeRangeLabel(
  value: TimeRangeValue,
  nowMs: number,
  config: TimeRangeConfig,
  labels: {
    calendar?: ReadonlyMap<string, string>;
    presets?: ReadonlyMap<string, string>;
  } = {},
): string {
  const resolved = resolveTimeRange(value, nowMs, config);
  let label: string;
  if (value.selection.kind === "relative") {
    label =
      (value.selection.presetId && labels.presets?.get(value.selection.presetId)) ||
      `Past ${formatDuration(value.selection.durationMs)}`;
  } else if (value.selection.kind === "calendar") {
    label =
      labels.calendar?.get(value.selection.preset) ?? value.selection.preset.replaceAll("_", " ");
  } else if (value.selection.kind === "growing") {
    label = `Since ${formatInstant(value.selection.fromMs, value.timezone, config.locale)}`;
  } else {
    const origin =
      value.selection.origin === "custom"
        ? "Custom"
        : value.selection.origin === "zoom"
          ? "Zoom"
          : "Window";
    label = `${origin} · ${formatDuration(resolved.toMs - resolved.fromMs)}`;
  }
  return value.playback.kind === "paused" ? `${label} · Paused` : label;
}
