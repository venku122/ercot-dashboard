import { describe, expect, it } from "vitest";

import { chartDefinitions } from "./chart-config";
import {
  chartGroupDefinition,
  chartGroupDefinitions,
  criticalMetricDefinitions,
  dashboardViewDefinitions,
  dashboardViewForGroup,
  initiallyCollapsedGroups,
  mobilePrimaryCriticalMetricIds,
  mobileSupportingCriticalMetricIds,
  reserveMarginPercent,
} from "./information-architecture";

describe("dashboard information architecture", () => {
  it("puts the six required critical metrics in scan order", () => {
    expect(criticalMetricDefinitions.map((metric) => metric.id)).toEqual([
      "grid-status",
      "demand",
      "available-capacity",
      "reserve-margin",
      "frequency",
      "real-time-price",
    ]);
  });

  it("partitions mobile critical metrics into four primary and two supporting readings", () => {
    expect(mobilePrimaryCriticalMetricIds).toEqual([
      "grid-status",
      "demand",
      "reserve-margin",
      "real-time-price",
    ]);
    expect(mobileSupportingCriticalMetricIds).toEqual(["available-capacity", "frequency"]);

    const allMobileIds = [...mobilePrimaryCriticalMetricIds, ...mobileSupportingCriticalMetricIds];
    expect(new Set(allMobileIds).size).toBe(allMobileIds.length);
    expect(new Set(allMobileIds)).toEqual(
      new Set(criticalMetricDefinitions.map((metric) => metric.id)),
    );
  });

  it("assigns every chart to one declared hierarchy group", () => {
    const declared = new Set(chartGroupDefinitions.map((group) => group.name));
    expect(new Set(chartDefinitions.map((chart) => chart.group))).toEqual(declared);
    for (const chart of chartDefinitions) expect(chartGroupDefinition(chart.group)).toBeTruthy();
  });

  it("assigns every chart group to exactly one progressive-disclosure view", () => {
    expect(dashboardViewDefinitions.map((view) => view.id)).toEqual([
      "overview",
      "outlook",
      "generation",
      "reliability",
      "market",
      "texas-grid",
      "external-context",
      "weather",
      "advanced",
      "diagnostics",
    ]);
    const assignedGroups = dashboardViewDefinitions.flatMap((view) => view.groups);
    expect(new Set(assignedGroups).size).toBe(assignedGroups.length);
    expect(new Set(assignedGroups)).toEqual(
      new Set(chartGroupDefinitions.map((group) => group.name)),
    );
    for (const view of dashboardViewDefinitions) {
      for (const group of view.groups) expect(dashboardViewForGroup(group)).toBe(view.id);
    }
  });

  it("keeps engineering signals in the advanced layer", () => {
    const advancedIds = chartDefinitions
      .filter((chart) => chartGroupDefinition(chart.group).level === "advanced")
      .map((chart) => chart.id);
    expect(advancedIds).toEqual(
      expect.arrayContaining([
        "reserves",
        "time-error",
        "inertia",
        "dc-ties",
        "ancillary-regulation",
        "ancillary-reserves",
        "collector-duty-cycle",
      ]),
    );
  });

  it("defaults advanced desktop groups and noncritical mobile groups to collapsed", () => {
    expect([...initiallyCollapsedGroups(false)]).toEqual([
      "Advanced grid",
      "Ancillary services",
      "Diagnostics",
    ]);
    expect(initiallyCollapsedGroups(true).has("Grid conditions")).toBe(false);
    expect(initiallyCollapsedGroups(true).size).toBe(chartGroupDefinitions.length - 1);
  });

  it("computes the critical reserve-margin card without inventing unavailable values", () => {
    expect(reserveMarginPercent(68_000, 88_400)).toBeCloseTo(30);
    expect(reserveMarginPercent(0, 88_400)).toBeNull();
    expect(reserveMarginPercent(null, 88_400)).toBeNull();
    expect(reserveMarginPercent(68_000, null)).toBeNull();
  });
});
