import type { EventRecord } from "./types";

export type OperationsCategory =
  | "eea"
  | "generator-trip"
  | "heat-advisory"
  | "operational-notice"
  | "reserve-watch"
  | "transmission-event";

export type OperationsSeverity = "emergency" | "information" | "warning" | "watch";

export type TimelineEvent = EventRecord & {
  category: OperationsCategory;
  categoryLabel: string;
  severityLabel: string;
  timelineSeverity: OperationsSeverity;
};

export const operationsSeverityOptions: ReadonlyArray<{
  label: string;
  value: "all" | OperationsSeverity;
}> = [
  { value: "all", label: "All severities" },
  { value: "emergency", label: "Emergency" },
  { value: "warning", label: "Warning" },
  { value: "watch", label: "Watch" },
  { value: "information", label: "Information" },
];

const categoryLabels: Record<OperationsCategory, string> = {
  eea: "EEA",
  "generator-trip": "Generator trip",
  "heat-advisory": "Heat advisory",
  "operational-notice": "Operational notice",
  "reserve-watch": "Reserve watch",
  "transmission-event": "Transmission event",
};

function eventText(event: EventRecord) {
  return `${event.event_type} ${event.title} ${event.body ?? ""}`.toLowerCase();
}

export function classifyOperationsCategory(event: EventRecord): OperationsCategory {
  const text = eventText(event);
  if (/\beea\b|emergency energy alert/.test(text)) return "eea";
  if (/reserve|physical responsive capability|\bprc\b/.test(text)) return "reserve-watch";
  if (/heat|temperature|weather advisory|conservation appeal/.test(text)) {
    return "heat-advisory";
  }
  if (/generator|generation resource|generating unit/.test(text) && /trip|loss|outage/.test(text)) {
    return "generator-trip";
  }
  if (/transmission|constraint|dc tie|transmission line|transformer/.test(text)) {
    return "transmission-event";
  }
  return "operational-notice";
}

export function classifyOperationsSeverity(event: EventRecord): OperationsSeverity {
  const raw = event.severity?.trim().toLowerCase() ?? "";
  const text = eventText(event);
  if (
    ["critical", "emergency"].includes(raw) ||
    /\beea(?:\s+level)?\s*[23]\b|emergency energy alert|load shed/.test(text)
  ) {
    return "emergency";
  }
  if (raw === "watch" || /\bwatch\b/.test(text)) return "watch";
  if (raw === "warning" || /\bwarning\b|\btrip(?:ped)?\b|unplanned loss/.test(text)) {
    return "warning";
  }
  if (/\badvisory\b|conservation appeal/.test(text)) return "watch";
  return "information";
}

export function buildOperationsTimeline(events: readonly EventRecord[]): TimelineEvent[] {
  return [...events]
    .sort((left, right) => right.starts_at - left.starts_at)
    .map((event) => {
      const category = classifyOperationsCategory(event);
      const timelineSeverity = classifyOperationsSeverity(event);
      return {
        ...event,
        category,
        categoryLabel: categoryLabels[category],
        timelineSeverity,
        severityLabel:
          operationsSeverityOptions.find((option) => option.value === timelineSeverity)?.label ??
          "Information",
      };
    });
}

export function filterOperationsTimeline(
  events: readonly TimelineEvent[],
  severity: "all" | OperationsSeverity,
) {
  return severity === "all"
    ? [...events]
    : events.filter((event) => event.timelineSeverity === severity);
}
