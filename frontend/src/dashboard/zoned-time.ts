const ZONE = "America/Chicago";

type DateParts = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
};

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsAt(timestamp: number): DateParts {
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as DateParts;
}

function utcLike(parts: DateParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function epochForChicagoParts(parts: DateParts): number {
  const desired = utcLike(parts);
  let candidate = desired;
  for (let index = 0; index < 4; index += 1) {
    const observed = utcLike(partsAt(candidate / 1000));
    const adjustment = desired - observed;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return candidate / 1000;
}

export function shiftChicagoCalendar(timestamp: number, days: number): number {
  const current = partsAt(timestamp);
  const shifted = new Date(
    Date.UTC(
      current.year,
      current.month - 1,
      current.day + days,
      current.hour,
      current.minute,
      current.second,
    ),
  );
  return epochForChicagoParts({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  });
}

export function parseChicagoDateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error("invalid_chicago_datetime");
  return epochForChicagoParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  });
}

export function formatChicagoDateTimeInput(timestamp: number): string {
  const parts = partsAt(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
