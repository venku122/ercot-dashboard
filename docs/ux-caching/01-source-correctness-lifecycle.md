# Source correctness and lifecycle policy

This change establishes the first production-hardening layer after collector checkpoint recovery.

- Fuel Mix accepts the current official payload, which no longer contains the former `types`
  array. A minimized 2026-08-14 fixture reproduces that drift, while the prior fixture remains in
  coverage. Fuel identity comes from the actual day/time maps and freshness uses the newest
  generation observation.
- A chart with no points distinguishes a healthy empty range from a failed or stale source. Normal
  views show a concise source-aware state and the age of the last valid observation; raw backend
  errors remain in Diagnostics.
- PowerOutage.us is intentionally disabled because no API credential will be configured. Its loop
  is not started, its chart is not in the public catalog, and legacy health rows are filtered from
  active diagnostics without deleting stored data.
- Operations history suppresses detector heartbeats that explicitly say no qualifying generation
  loss occurred. Authoritative event rows remain stored.
- Collector Duty Cycle is application telemetry and therefore appears in Diagnostics, not Advanced
  grid analysis.

Regression coverage includes the current Fuel Mix schema, disabled-source health filtering,
negative-event presentation policy, source-aware chart lifecycle copy, and a browser fixture that
requires actual demand, forecast demand, and available capacity to remain visible as distinct
series.
