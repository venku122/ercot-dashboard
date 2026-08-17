export type InformationLevel = "advanced" | "critical" | "operational";

export type DashboardViewId =
  | "advanced"
  | "diagnostics"
  | "generation"
  | "market"
  | "overview"
  | "reliability"
  | "weather";

export type CriticalMetricId =
  | "available-capacity"
  | "demand"
  | "frequency"
  | "grid-status"
  | "real-time-price"
  | "reserve-margin";

export const informationLevels = [
  {
    id: "critical",
    label: "Grid at a glance",
    description: "The current operating picture and the values that can change its interpretation.",
  },
  {
    id: "operational",
    label: "Operational detail",
    description: "Generation, reliability, market, and weather context for the current picture.",
  },
  {
    id: "advanced",
    label: "Advanced analysis",
    description:
      "Engineering signals remain available without competing with the operating summary.",
  },
] as const satisfies ReadonlyArray<{
  description: string;
  id: InformationLevel;
  label: string;
}>;

export const criticalMetricDefinitions = [
  { id: "grid-status", label: "Grid status", unit: null },
  { id: "demand", label: "Demand", unit: "MW" },
  { id: "available-capacity", label: "Available capacity", unit: "MW" },
  { id: "reserve-margin", label: "Reserve margin", unit: "%" },
  { id: "frequency", label: "Frequency", unit: "Hz" },
  { id: "real-time-price", label: "Real-time price", unit: "$/MWh" },
] as const satisfies ReadonlyArray<{
  id: CriticalMetricId;
  label: string;
  unit: string | null;
}>;

export const mobilePrimaryCriticalMetricIds: ReadonlyArray<CriticalMetricId> = [
  "grid-status",
  "demand",
  "reserve-margin",
  "real-time-price",
];

export const mobileSupportingCriticalMetricIds: ReadonlyArray<CriticalMetricId> = [
  "available-capacity",
  "frequency",
];

export const chartGroupDefinitions = [
  {
    name: "Grid conditions",
    level: "operational",
    description: "Demand, supply, and frequency behavior behind the current grid status.",
  },
  {
    name: "Generation",
    level: "operational",
    description: "Fuel mix, renewable output, and storage behavior.",
  },
  {
    name: "Reliability",
    level: "operational",
    description: "Capacity headroom, outages, and emergency conditions.",
  },
  {
    name: "Market",
    level: "operational",
    description: "Real-time price behavior and market context.",
  },
  {
    name: "Weather",
    level: "operational",
    description: "Temperature and wind observations near major grid centers.",
  },
  {
    name: "Advanced grid",
    level: "advanced",
    description: "PRC, time error, inertia, and DC tie engineering signals.",
  },
  {
    name: "Ancillary services",
    level: "advanced",
    description: "Regulation awards and detailed reserve products.",
  },
  {
    name: "Diagnostics",
    level: "advanced",
    description: "Internal collector utilization telemetry.",
  },
] as const satisfies ReadonlyArray<{
  description: string;
  level: InformationLevel;
  name: string;
}>;

export const dashboardViewDefinitions = [
  {
    id: "overview",
    label: "Overview",
    description: "Grid condition, critical readings, calculated context, and current alerts.",
    groups: ["Grid conditions"],
  },
  {
    id: "generation",
    label: "Generation",
    description: "Fuel mix, renewable output, and storage behavior.",
    groups: ["Generation"],
  },
  {
    id: "reliability",
    label: "Reliability",
    description: "Capacity headroom, outages, emergency conditions, and ERCOT notices.",
    groups: ["Reliability"],
  },
  {
    id: "market",
    label: "Market",
    description: "Real-time prices, settlement-point ranking, and market context.",
    groups: ["Market"],
  },
  {
    id: "weather",
    label: "Weather",
    description: "Temperature and wind observations near major grid centers.",
    groups: ["Weather"],
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Engineering signals and ancillary products.",
    groups: ["Advanced grid", "Ancillary services"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Collection health, source freshness, timestamps, and failure detail.",
    groups: ["Diagnostics"],
  },
] as const satisfies ReadonlyArray<{
  description: string;
  groups: readonly string[];
  id: DashboardViewId;
  label: string;
}>;

export const primaryDashboardViewIds: ReadonlyArray<DashboardViewId> = [
  "overview",
  "generation",
  "reliability",
  "market",
];

export const moreDashboardViewIds: ReadonlyArray<DashboardViewId> = [
  "weather",
  "advanced",
  "diagnostics",
];

const groupByName = new Map<string, (typeof chartGroupDefinitions)[number]>(
  chartGroupDefinitions.map((group) => [group.name, group]),
);

const dashboardViewById = new Map<DashboardViewId, (typeof dashboardViewDefinitions)[number]>(
  dashboardViewDefinitions.map((view) => [view.id, view]),
);

const dashboardViewByGroup = new Map<string, DashboardViewId>(
  dashboardViewDefinitions.flatMap((view) => view.groups.map((group) => [group, view.id])),
);

export function dashboardViewDefinition(id: DashboardViewId) {
  const definition = dashboardViewById.get(id);
  if (!definition) throw new Error(`unknown_dashboard_view:${id}`);
  return definition;
}

export function dashboardViewForGroup(group: string) {
  const view = dashboardViewByGroup.get(group);
  if (!view) throw new Error(`unassigned_chart_group:${group}`);
  return view;
}

export function chartGroupDefinition(name: string) {
  const definition = groupByName.get(name);
  if (!definition) throw new Error(`unknown_chart_group:${name}`);
  return definition;
}

export function initiallyCollapsedGroups(mobile: boolean): Set<string> {
  return new Set(
    chartGroupDefinitions
      .filter((group) => (mobile ? group.name !== "Grid conditions" : group.level === "advanced"))
      .map((group) => group.name),
  );
}

export function reserveMarginPercent(demandMw: number | null, availableCapacityMw: number | null) {
  if (demandMw === null || demandMw <= 0 || availableCapacityMw === null) return null;
  return ((availableCapacityMw - demandMw) / demandMw) * 100;
}
