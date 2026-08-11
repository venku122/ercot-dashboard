import { describe, expect, it } from "vitest";

import type { EventRecord } from "./types";
import {
  buildOperationsTimeline,
  classifyOperationsCategory,
  classifyOperationsSeverity,
  filterOperationsTimeline,
} from "./operations-timeline";

function event(title: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    dedupe_key: title,
    event_type: "Operational Information",
    starts_at: 100,
    title,
    ...overrides,
  };
}

describe("operations timeline policy", () => {
  it.each([
    ["Heat advisory remains in effect", "heat-advisory"],
    ["Generator unit 4 tripped offline", "generator-trip"],
    ["Physical Responsive Capability reserve watch", "reserve-watch"],
    ["EEA Level 2 issued", "eea"],
    ["Transmission constraint on a DC tie", "transmission-event"],
  ])("classifies %s", (title, category) => {
    expect(classifyOperationsCategory(event(title))).toBe(category);
  });

  it("falls back to a truthful operational-notice category", () => {
    expect(classifyOperationsCategory(event("Control room update"))).toBe("operational-notice");
  });

  it("normalizes explicit and text-derived severities", () => {
    expect(classifyOperationsSeverity(event("EEA Level 3 issued"))).toBe("emergency");
    expect(classifyOperationsSeverity(event("Generator tripped"))).toBe("warning");
    expect(classifyOperationsSeverity(event("Reserve watch", { severity: "warning" }))).toBe(
      "watch",
    );
    expect(classifyOperationsSeverity(event("Heat advisory"))).toBe("watch");
    expect(classifyOperationsSeverity(event("Routine update", { severity: "info" }))).toBe(
      "information",
    );
  });

  it("orders newest first without mutating the API response", () => {
    const input = [event("older", { starts_at: 100 }), event("newer", { starts_at: 200 })];
    expect(buildOperationsTimeline(input).map((item) => item.title)).toEqual(["newer", "older"]);
    expect(input.map((item) => item.title)).toEqual(["older", "newer"]);
  });

  it("filters by normalized severity", () => {
    const timeline = buildOperationsTimeline([
      event("EEA Level 2 issued"),
      event("Reserve watch"),
      event("Routine update"),
    ]);
    expect(filterOperationsTimeline(timeline, "watch").map((item) => item.title)).toEqual([
      "Reserve watch",
    ]);
    expect(filterOperationsTimeline(timeline, "all")).toHaveLength(3);
  });
});
