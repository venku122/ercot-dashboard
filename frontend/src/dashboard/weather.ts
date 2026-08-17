import type { LatestQuery } from "./api";
import type { LatestPoint } from "./derived-metrics";

export const weatherStations = [
  { code: "KDFW", id: "dfw", label: "Dallas/Fort Worth" },
  { code: "KAUS", id: "austin", label: "Austin" },
  { code: "KHOU", id: "houston", label: "Houston" },
  { code: "KSAT", id: "san-antonio", label: "San Antonio" },
] as const;

export const weatherLatestQueries: LatestQuery[] = weatherStations.flatMap((station) => [
  {
    id: `weather-${station.id}-speed`,
    metric: "metar.winds.speed",
    tags: [`metar_code:${station.code}`],
  },
  {
    id: `weather-${station.id}-direction`,
    metric: "metar.winds.direction_degrees",
    tags: [`metar_code:${station.code}`],
  },
  {
    id: `weather-${station.id}-gust`,
    metric: "metar.winds.gust_mph",
    tags: [`metar_code:${station.code}`],
  },
]);

const compass = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const compassNames = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
] as const;
const travelArrows = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"] as const;

export type WindPresentation = {
  accessible: string;
  detail: string;
  headline: string;
};

export function formatWindCondition(
  speed: LatestPoint | undefined,
  direction: LatestPoint | undefined,
  gust: LatestPoint | undefined,
): WindPresentation {
  if (!speed) {
    return {
      accessible: "Wind observation unavailable",
      detail: "Awaiting observation",
      headline: "—",
    };
  }
  const roundedSpeed = Math.round(speed.value);
  const gustCopy = gust ? `, gusting to ${Math.round(gust.value)} miles per hour` : "";
  if (speed.value <= 1) {
    return {
      accessible: `Calm wind at ${roundedSpeed} miles per hour${gustCopy}`,
      detail: gust ? `Gust ${Math.round(gust.value)} mph` : "No gust reported",
      headline: `Calm · ${roundedSpeed} mph`,
    };
  }
  if (!direction) {
    return {
      accessible: `Variable wind direction at ${roundedSpeed} miles per hour${gustCopy}`,
      detail: gust ? `Gust ${Math.round(gust.value)} mph` : "No gust reported",
      headline: `Variable · ${roundedSpeed} mph`,
    };
  }
  const normalized = ((direction.value % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return {
    accessible: `Wind from ${compassNames[index]} at ${roundedSpeed} miles per hour${gustCopy}`,
    detail: `${Math.round(normalized)}°${gust ? ` · Gust ${Math.round(gust.value)} mph` : " · No gust reported"}`,
    headline: `${compass[index]} ${travelArrows[index]} · ${roundedSpeed} mph`,
  };
}
