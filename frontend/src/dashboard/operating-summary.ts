import { freshLatestPoint, type LatestPoint } from "./derived-metrics";
import { isPublicOperationsEvent } from "./operations-timeline";
import type { EventRecord, SourceHealth } from "./types";

export type OperatingState = "clear" | "emergency" | "unavailable" | "watch";
export type CoreDataState = "current" | "limited" | "unavailable";

export type OperatingSummary = {
  coreDataDetail: string;
  coreDataLabel: string;
  coreDataState: CoreDataState;
  coreObservedAt: number | null;
  operatingDetail: string;
  operatingLabel: string;
  operatingState: OperatingState;
  optionalProblemCount: number;
};

const materialSourceIds = new Set([
  "ercot_eea",
  "ercot_realtime",
  "operations_messages",
  "supply_demand",
]);

function isProblem(source: SourceHealth) {
  return source.state === "failed" || source.state === "stale";
}

function activeOperationalEvent(events: readonly EventRecord[]) {
  return events
    .filter(isPublicOperationsEvent)
    .filter((event) => {
      const status = event.status?.trim().toLowerCase() ?? "";
      const severity = event.severity?.trim().toLowerCase() ?? "";
      return status === "active" && ["emergency", "warning", "watch"].includes(severity);
    })
    .sort((left, right) => {
      const priority = (event: EventRecord) =>
        event.severity?.trim().toLowerCase() === "emergency" ? 0 : 1;
      return priority(left) - priority(right);
    })[0];
}

export function buildOperatingSummary({
  events,
  latest,
  now,
  requestFailed,
  sources,
}: {
  events: readonly EventRecord[];
  latest: Map<string, LatestPoint>;
  now: number;
  requestFailed: boolean;
  sources: readonly SourceHealth[];
}): OperatingSummary {
  const demand = freshLatestPoint(latest.get("demand"), now);
  const capacity = freshLatestPoint(latest.get("capacity"), now);
  const frequency = freshLatestPoint(latest.get("frequency"), now);
  const eea = freshLatestPoint(latest.get("health-eea"), now);
  const activeEvent = activeOperationalEvent(events);
  const activeSeverity = activeEvent?.severity?.trim().toLowerCase() ?? "";
  const eeaLevel = eea ? Math.max(0, Math.round(eea.value)) : null;

  let operatingState: OperatingState;
  let operatingLabel: string;
  let operatingDetail: string;
  if (activeSeverity === "emergency" || (eeaLevel !== null && eeaLevel >= 3)) {
    operatingState = "emergency";
    operatingLabel = "ERCOT emergency conditions active";
    operatingDetail = activeEvent?.title ?? "ERCOT is reporting Emergency Energy Alert level 3.";
  } else if (activeEvent || (eeaLevel !== null && eeaLevel >= 1)) {
    operatingState = "watch";
    operatingLabel = "ERCOT grid watch active";
    operatingDetail =
      activeEvent?.title ?? `ERCOT is reporting Emergency Energy Alert level ${String(eeaLevel)}.`;
  } else if (eeaLevel === 0) {
    operatingState = "clear";
    operatingLabel = "No active ERCOT emergency";
    operatingDetail = "ERCOT is reporting Emergency Energy Alert level 0.";
  } else {
    operatingState = "unavailable";
    operatingLabel = "ERCOT emergency status unavailable";
    operatingDetail = "A current ERCOT emergency-state reading is not available.";
  }

  const corePoints = [demand, capacity, frequency];
  const coreObservedAt = corePoints.every(Boolean)
    ? Math.min(...corePoints.map((point) => point?.ts ?? now))
    : null;
  const materialProblems = sources.filter(
    (source) => materialSourceIds.has(source.source_id) && isProblem(source),
  );
  const optionalProblemCount = sources.filter(
    (source) => !materialSourceIds.has(source.source_id) && isProblem(source),
  ).length;

  let coreDataState: CoreDataState;
  let coreDataLabel: string;
  let coreDataDetail: string;
  if (requestFailed && coreObservedAt === null) {
    coreDataState = "unavailable";
    coreDataLabel = "Core readings unavailable";
    coreDataDetail = "The latest dashboard update did not complete.";
  } else if (coreObservedAt === null || materialProblems.length > 0) {
    coreDataState = "limited";
    coreDataLabel = "Core readings limited";
    coreDataDetail = materialProblems.length
      ? `${String(materialProblems.length)} critical source${materialProblems.length === 1 ? " is" : "s are"} degraded.`
      : "Fresh demand, capacity, and frequency readings are required.";
  } else {
    coreDataState = "current";
    coreDataLabel = "Core readings are current";
    coreDataDetail = "Demand, available capacity, and frequency are current.";
  }

  return {
    coreDataDetail,
    coreDataLabel,
    coreDataState,
    coreObservedAt,
    operatingDetail,
    operatingLabel,
    operatingState,
    optionalProblemCount,
  };
}
