import { describe, expect, it } from "vitest";

import { rationalizeAlerts } from "./alert-policy";
import type { EventRecord, SourceHealth } from "./types";

const activeEvent: EventRecord = {
  body: "Reserve conditions require heightened awareness.",
  dedupe_key: "active-warning",
  event_type: "Operational Information",
  severity: "warning",
  starts_at: 1,
  status: "Active",
  title: "Transmission constraint",
};

function source(sourceId: string, state: SourceHealth["state"]): SourceHealth {
  return {
    age_seconds: 900,
    collection_age_seconds: 900,
    collection_state: state === "failed" ? "failed" : "healthy",
    consecutive_failures: state === "failed" ? 3 : 0,
    data_age_seconds: 900,
    display_name: `ERCOT ${sourceId}`,
    expected_interval_seconds: 300,
    freshness_state: state === "stale" ? "stale" : "fresh",
    last_attempt_ts: 1,
    last_error: "internal collector detail",
    last_row_count: 0,
    last_success_ts: 1,
    publication_interval_seconds: 300,
    publication_mode: "polling",
    source_id: sourceId,
    source_timestamp_ts: 1,
    state,
  };
}

describe("public alert policy", () => {
  it("surfaces active interpretive notices with all required fields", () => {
    expect(rationalizeAlerts([activeEvent], [], false)).toEqual([
      expect.objectContaining({
        action: "review-operations",
        cause: "Transmission constraint",
        impact: "Reserve conditions require heightened awareness.",
        recommendedAction: expect.any(String),
        severity: "warning",
      }),
    ]);
  });

  it("suppresses closed notices and noncritical collector noise", () => {
    expect(
      rationalizeAlerts(
        [{ ...activeEvent, status: "Closed" }],
        [source("energy_storage", "failed")],
        false,
      ),
    ).toEqual([]);
  });

  it("keeps the highest-severity active notice on the overview", () => {
    const alerts = rationalizeAlerts(
      [activeEvent, { ...activeEvent, dedupe_key: "emergency", severity: "emergency" }],
      [],
      false,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
  });

  it("surfaces material critical-source staleness without internal errors", () => {
    const [alert] = rationalizeAlerts([], [source("supply_demand", "failed")], false);
    expect(alert).toMatchObject({
      action: "review-diagnostics",
      label: "Critical data limited",
      severity: "warning",
    });
    expect(JSON.stringify(alert)).not.toContain("internal collector detail");
  });

  it("turns request failure into actionable public language", () => {
    const [alert] = rationalizeAlerts([], [], true);
    expect(alert).toMatchObject({
      action: "retry-data",
      cause: "One or more dashboard data requests did not complete.",
      impact: "Existing data is preserved; this is not an empty-data state.",
    });
  });
});
