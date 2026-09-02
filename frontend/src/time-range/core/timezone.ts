import type {
  WallTimeOccurrence,
  WallTimeParseResult,
  WallTimeParts,
  WallTimeResolution,
} from "./types";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });
  formatterCache.set(timezone, created);
  return created;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone).format(0);
    return true;
  } catch {
    formatterCache.delete(timezone);
    return false;
  }
}

export function wallPartsAt(instantMs: number, timezone: string): WallTimeParts {
  const values = Object.fromEntries(
    formatter(timezone)
      .formatToParts(new Date(instantMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Omit<WallTimeParts, "millisecond">;
  return { ...values, millisecond: new Date(instantMs).getUTCMilliseconds() };
}

function utcLike(parts: WallTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function sameWallParts(left: WallTimeParts, right: WallTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

export function parseWallTime(value: string): WallTimeParseResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value.trim(),
  );
  if (!match) return { ok: false, reason: "invalid_wall_time" };
  const parts: WallTimeParts = {
    day: Number(match[3]),
    hour: Number(match[4]),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
    minute: Number(match[5]),
    month: Number(match[2]),
    second: Number(match[6] ?? 0),
    year: Number(match[1]),
  };
  const normalized = new Date(utcLike(parts));
  const valid =
    normalized.getUTCFullYear() === parts.year &&
    normalized.getUTCMonth() + 1 === parts.month &&
    normalized.getUTCDate() === parts.day &&
    normalized.getUTCHours() === parts.hour &&
    normalized.getUTCMinutes() === parts.minute &&
    normalized.getUTCSeconds() === parts.second &&
    normalized.getUTCMilliseconds() === parts.millisecond;
  return valid ? { ok: true, parts } : { ok: false, reason: "invalid_wall_time" };
}

export function resolveWallTime(
  parts: WallTimeParts,
  timezone: string,
  occurrence?: WallTimeOccurrence,
): WallTimeResolution {
  if (!isValidTimezone(timezone)) return { kind: "nonexistent" };
  const desired = utcLike(parts);
  const offsets = new Set<number>();
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
    const sample = desired + deltaHours * 3_600_000;
    offsets.add(utcLike(wallPartsAt(sample, timezone)) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => desired - offset)
    .filter((candidate) => sameWallParts(wallPartsAt(candidate, timezone), parts))
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort((left, right) => left - right);
  if (candidates.length === 0) return { kind: "nonexistent" };
  const earlierMs = candidates[0]!;
  const laterMs = candidates.at(-1)!;
  if (earlierMs !== laterMs) {
    if (occurrence) {
      return {
        instantMs: occurrence === "earlier" ? earlierMs : laterMs,
        kind: "exact",
        occurrence,
      };
    }
    return { earlierMs, kind: "ambiguous", laterMs };
  }
  return { instantMs: earlierMs, kind: "exact" };
}

export function exactInstantForWallParts(parts: WallTimeParts, timezone: string): number {
  const resolved = resolveWallTime(parts, timezone, "earlier");
  if (resolved.kind !== "exact") throw new Error("nonexistent_wall_time");
  return resolved.instantMs;
}

export function shiftWallDate(parts: WallTimeParts, days: number): WallTimeParts {
  const shifted = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ),
  );
  return {
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    millisecond: shifted.getUTCMilliseconds(),
    minute: shifted.getUTCMinutes(),
    month: shifted.getUTCMonth() + 1,
    second: shifted.getUTCSeconds(),
    year: shifted.getUTCFullYear(),
  };
}

export function shiftInstantByCalendarDays(
  instantMs: number,
  days: number,
  timezone: string,
): number {
  const shifted = shiftWallDate(wallPartsAt(instantMs, timezone), days);
  const resolved = resolveWallTime(shifted, timezone);
  if (resolved.kind === "exact") return resolved.instantMs;
  if (resolved.kind === "ambiguous") return resolved.earlierMs;
  // Match Temporal's compatible disambiguation: advance a gap wall time by the gap.
  for (let minutes = 1; minutes <= 180; minutes += 1) {
    const candidate = shiftWallDate({ ...shifted, minute: shifted.minute + minutes }, 0);
    const next = resolveWallTime(candidate, timezone, "earlier");
    if (next.kind === "exact") return next.instantMs;
  }
  throw new Error("nonexistent_wall_time");
}

export function formatWallTimeInput(instantMs: number, timezone: string): string {
  const parts = wallPartsAt(instantMs, timezone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
