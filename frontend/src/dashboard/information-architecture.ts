export type InformationLevel = "advanced" | "critical" | "operational";

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
    name: "Operations",
    level: "advanced",
    description: "Internal collector utilization telemetry.",
  },
] as const satisfies ReadonlyArray<{
  description: string;
  level: InformationLevel;
  name: string;
}>;

const groupByName = new Map<string, (typeof chartGroupDefinitions)[number]>(
  chartGroupDefinitions.map((group) => [group.name, group]),
);

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
