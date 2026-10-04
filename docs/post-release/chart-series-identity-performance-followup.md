# Chart dataset source identity follow-up

The shared dashboard series map changes when any historical source publishes. Previously, a completed frequency response invalidated the datasets and invoked the data update path of populated Supply and demand and Capacity headroom charts even when their own LoadedSeries objects remained unchanged.

This change gives only dataset construction a stable per-card projection. The projection includes every chart.series entry, including input-only entries, and an external interpretation reference when present. Complete LoadedSeries objects retain their points, comparison, metadata, coverage, interval policy, completed selection and error state. Replacing or removing a relevant entry invalidates the projection. The descriptor, requested selection, actual plot time, comparison, visibility, presentation and events remain dependencies. All other consumers, including current readouts, CSV, tables, storage and live callbacks, continue to receive the complete current map.

The regression holds a real frequency history request until both core plots are populated. Before the change, releasing that request produced one Supply and demand data-update publication despite unchanged core observations. After the change, both core plots record zero such publications. Selecting an earlier fixed window then changes the actual demand value and updates the existing plot without constructing a replacement. Test-only MutationObservers watch the existing canvas readiness publication immediately after the ChartCard data update path; they do not modify production counters or substitute source data.

Verification on base `58fd4d25ecba3e5332dacd83cb47bd122dcbb916`:

- Strengthened actual held-request regression: RED, expected0/received1; then GREEN after restoring the change.
- Seven priority, constructor, identity and warm-context Chromium cases: PASS,8.4s.
- Identity plus four warm-context WebKit cases: PASS,8.9s.
- Sixteen source cursor, interval plot, CSV, accessible table, core price compatibility and interaction cases: PASS,20.5s.
- Seven per-card identity model cases and typecheck: PASS.

Raw logs and original regression trace are preserved under `/tmp/ercot-post-release-2026-10/chart-series-identity-*`. No fixture, threshold, tolerance, request or numeric observer was changed. This proves unnecessary chart work was removed; native and exact Linux cold-budget measurements remain root-owned verification gates. The pre-existing Linux strict failures are not waived or reclassified by this supplement.
