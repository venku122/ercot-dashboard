import type { EventRecord, SourceHealth } from "./types";
import { isPublicOperationsEvent } from "./operations-timeline";

export type PublicAlert = {
  action: "retry-data" | "review-diagnostics" | "review-operations";
  cause: string;
  id: string;
  impact: string;
  label: string;
  recommendedAction: string;
  severity: "critical" | "warning";
};

const materialSourceIds = new Set([
  "ercot_eea",
  "ercot_realtime",
  "operations_messages",
  "supply_demand",
]);

const eventPriority: Record<PublicAlert["severity"], number> = { critical: 0, warning: 1 };

function operationalAlert(event: EventRecord): PublicAlert | null {
  const status = event.status?.trim().toLowerCase() ?? "";
  const severity = event.severity?.trim().toLowerCase() ?? "";
  if (status !== "active" || !["emergency", "warning", "watch"].includes(severity)) return null;
  const critical = severity === "emergency";
  return {
    action: "review-operations",
    cause: event.title,
    id: `event:${event.dedupe_key}`,
    impact:
      event.body?.trim() ||
      "Current grid interpretation may differ from normal operating conditions.",
    label: critical ? "Emergency grid notice" : "Active grid watch",
    recommendedAction: critical
      ? "Review the active ERCOT notice and current reserves before making operational decisions."
      : "Review the active ERCOT notice and continue monitoring grid conditions.",
    severity: critical ? "critical" : "warning",
  };
}

function materialDataAlert(sources: readonly SourceHealth[]): PublicAlert | null {
  const affected = sources
    .filter(
      (source) =>
        materialSourceIds.has(source.source_id) &&
        (source.state === "failed" || source.state === "stale"),
    )
    .sort((left, right) => Number(right.state === "failed") - Number(left.state === "failed"));
  const primary = affected[0];
  if (!primary) return null;
  return {
    action: "review-diagnostics",
    cause:
      primary.display_name.replace(/^ERCOT /, "") +
      ` data is ${primary.state}` +
      (affected.length > 1 ? `; ${affected.length - 1} other critical source affected` : ""),
    id: "material-data-quality",
    impact: "One or more critical grid values or notices may not reflect current conditions.",
    label: "Critical data limited",
    recommendedAction: "Review System health before relying on the affected values.",
    severity: "warning",
  };
}

export function rationalizeAlerts(
  events: readonly EventRecord[],
  sources: readonly SourceHealth[],
  requestFailed: boolean,
): PublicAlert[] {
  const operationalAlerts = events
    .filter(isPublicOperationsEvent)
    .map(operationalAlert)
    .filter((alert): alert is PublicAlert => alert !== null)
    .sort((left, right) => eventPriority[left.severity] - eventPriority[right.severity]);
  const alerts = operationalAlerts.slice(0, 1);
  const dataAlert = materialDataAlert(sources);
  if (dataAlert) alerts.push(dataAlert);
  if (requestFailed) {
    alerts.push({
      action: "retry-data",
      cause: "One or more dashboard data requests did not complete.",
      id: "dashboard-request",
      impact: "Existing data is preserved; this is not an empty-data state.",
      label: "Dashboard update interrupted",
      recommendedAction: "Retry the update. If it continues to fail, review System health.",
      severity: "warning",
    });
  }
  return alerts.sort((left, right) => eventPriority[left.severity] - eventPriority[right.severity]);
}
