export type SettlementPointType = "Hub" | "Load Zone" | "Settlement Point";

export type SettlementPointMetadata = {
  code: string;
  label: string;
  type: SettlementPointType;
};

const labels: Record<string, string> = {
  HB_BUSAVG: "Bus Average Hub",
  HB_HOUSTON: "Houston Hub",
  HB_HUBAVG: "Hub Average",
  HB_NORTH: "North Hub",
  HB_PAN: "Panhandle Hub",
  HB_SOUTH: "South Hub",
  HB_WEST: "West Hub",
  LZ_AEN: "Austin Energy Load Zone",
  LZ_CPS: "CPS Energy Load Zone",
  LZ_HOUSTON: "Houston Load Zone",
  LZ_LCRA: "LCRA Load Zone",
  LZ_NORTH: "North Load Zone",
  LZ_RAYBN: "Rayburn Load Zone",
  LZ_SOUTH: "South Load Zone",
  LZ_WEST: "West Load Zone",
};

export const SETTLEMENT_PUBLICATION_INTERVAL_SECONDS = 15 * 60;

export function settlementPointMetadata(tag: string): SettlementPointMetadata {
  const code = tag.replace(/^ercot_region:/, "");
  const type: SettlementPointType = code.startsWith("HB_")
    ? "Hub"
    : code.startsWith("LZ_")
      ? "Load Zone"
      : "Settlement Point";
  const fallback = code
    .replace(/^(HB|LZ)_/, "")
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
  return { code, label: labels[code] ?? fallback, type };
}

export function settlementFreshness(ageSeconds: number) {
  if (ageSeconds <= SETTLEMENT_PUBLICATION_INTERVAL_SECONDS * 2) {
    return "Within the normal 15-minute settlement publication cadence";
  }
  return "Older than two normal settlement publication intervals";
}
