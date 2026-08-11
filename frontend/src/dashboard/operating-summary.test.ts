import { describe, expect, it } from "vitest";

import { buildOperatingSummary } from "./operating-summary";
import type { EventRecord, SourceHealth } from "./types";

const now = 1_800_000_000;

function source(sourceId: string, state: SourceHealth["state"]): SourceHealth {
  return {
    age_seconds: 60,
    collection_age_seconds: 60,
    collection_state: state === "failed" ? "failed" : "healthy",
    consecutive_failures: state === "failed" ? 3 : 0,
    data_age_seconds: 60,
    display_name: `ERCOT ${sourceId}`,
    expected_interval_seconds: 300,
    freshness_state: state === "stale" ? "stale" : "fresh",
    last_attempt_ts: now,
    last_error: null,
    last_row_count: 1,
    last_success_ts: now,
    publication_interval_seconds: 300,
    publication_mode: "polling",
    source_id: sourceId,
    source_timestamp_ts: now,
    state,
  };
}

function latest(eea = 0) {
  return new Map([
    ["demand", { ts: now - 30, value: 70_000 }],
    ["capacity", { ts: now - 30, value: 90_000 }],
    ["frequency", { ts: now - 30, value: 60 }],
    ["health-eea", { ts: now - 30, value: eea }],
  ]);
}

function event(severity: string): EventRecord {
  return {
    body: "Review current grid conditions.",
    dedupe_key: severity,
    event_type: "Operational Information",
    severity,
    starts_at: now - 60,
    status: "Active",
    title: `${severity} notice`,
  };
}

describe("operating summary", () => {
  it.each([
    [0, "clear", "No active ERCOT emergency"],
    [1, "watch", "ERCOT grid watch active"],
    [2, "watch", "ERCOT grid watch active"],
    [3, "emergency", "ERCOT emergency conditions active"],
  ] as const)("maps EEA level %i to %s", (eea, operatingState, operatingLabel) => {
    expect(
      buildOperatingSummary({
        events: [],
        latest: latest(eea),
        now,
        requestFailed: false,
        sources: [],
      }),
    ).toMatchObject({ operatingLabel, operatingState });
  });

  it("prioritizes active operational notices", () => {
    expect(
      buildOperatingSummary({
        events: [event("emergency")],
        latest: latest(0),
        now,
        requestFailed: false,
        sources: [],
      }),
    ).toMatchObject({ operatingState: "emergency", operatingDetail: "emergency notice" });
  });

  it("keeps optional source failures separate from operating state", () => {
    expect(
      buildOperatingSummary({
        events: [],
        latest: latest(0),
        now,
        requestFailed: false,
        sources: [source("energy_storage", "failed"), source("fuel_mix", "stale")],
      }),
    ).toMatchObject({
      coreDataState: "current",
      operatingState: "clear",
      optionalProblemCount: 2,
    });
  });

  it("limits core data without inventing an emergency", () => {
    expect(
      buildOperatingSummary({
        events: [],
        latest: latest(0),
        now,
        requestFailed: false,
        sources: [source("supply_demand", "failed")],
      }),
    ).toMatchObject({ coreDataState: "limited", operatingState: "clear" });
  });

  it("reports stale emergency and missing core readings independently", () => {
    const stale = latest(0);
    stale.set("health-eea", { ts: now - 3600, value: 0 });
    stale.delete("frequency");
    expect(
      buildOperatingSummary({ events: [], latest: stale, now, requestFailed: true, sources: [] }),
    ).toMatchObject({ coreDataState: "unavailable", operatingState: "unavailable" });
  });
});
