import {
  formatWallTimeInput,
  parseWallTime,
  resolveWallTime,
  shiftInstantByCalendarDays,
} from "../time-range";

const CHICAGO = "America/Chicago";

export function shiftChicagoCalendar(timestamp: number, days: number): number {
  return shiftInstantByCalendarDays(timestamp * 1000, days, CHICAGO) / 1000;
}

export function parseChicagoDateTime(value: string): number {
  const parsed = parseWallTime(value);
  if (!parsed.ok) throw new Error("invalid_chicago_datetime");
  const resolved = resolveWallTime(parsed.parts, CHICAGO);
  if (resolved.kind !== "exact") {
    throw new Error(
      resolved.kind === "ambiguous" ? "ambiguous_chicago_datetime" : "nonexistent_chicago_datetime",
    );
  }
  return resolved.instantMs / 1000;
}

export function formatChicagoDateTimeInput(timestamp: number): string {
  return formatWallTimeInput(timestamp * 1000, CHICAGO);
}
