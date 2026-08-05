import { describe, expect, it } from "vitest";

import { sortDiagnostics, summarizeDiagnostics } from "./diagnostics";
import type { SourceHealth } from "./types";

function source(sourceId: string, state: SourceHealth["state"] = "healthy"): SourceHealth {
  return {
    age_seconds: 60,
    collection_age_seconds: 30,
    collection_state: state === "failed" ? "failed" : state === "delayed" ? "delayed" : "healthy",
    consecutive_failures: state === "failed" ? 2 : 0,
    data_age_seconds: 60,
    display_name: `ERCOT ${sourceId}`,
    expected_interval_seconds: 300,
    freshness_state: state === "stale" ? "stale" : state === "delayed" ? "delayed" : "fresh",
    last_attempt_ts: 1,
    last_error: state === "failed" ? "fixture failure" : null,
    last_row_count: 1,
    last_success_ts: 1,
    publication_interval_seconds: 300,
    publication_mode: "polling",
    source_id: sourceId,
    source_timestamp_ts: 1,
    state,
  };
}

describe("diagnostics summary", () => {
  it("reports the exact healthy default without surfacing per-source detail", () => {
    const summary = summarizeDiagnostics([source("Fuel Mix"), source("Supply and Demand")]);
    expect(summary).toMatchObject({
      headline: "Data Sources Healthy",
      problemCount: 0,
      state: "healthy",
      worstSource: null,
    });
    expect(summary.counts.healthy).toBe(2);
  });

  it("counts degraded sources and prioritizes a failure for drill-down context", () => {
    const summary = summarizeDiagnostics([
      source("Delayed", "delayed"),
      source("Failed", "failed"),
      source("Stale", "stale"),
      source("Healthy"),
    ]);
    expect(summary).toMatchObject({
      headline: "3 Data Sources Need Attention",
      problemCount: 3,
      state: "attention",
    });
    expect(summary.worstSource?.source_id).toBe("Failed");
    expect(sortDiagnostics([source("Healthy"), source("Stale", "stale")])[0]?.state).toBe("stale");
  });

  it("distinguishes an absent health report from a healthy report", () => {
    expect(summarizeDiagnostics([])).toMatchObject({
      headline: "Source Health Unavailable",
      state: "unavailable",
    });
  });
});
