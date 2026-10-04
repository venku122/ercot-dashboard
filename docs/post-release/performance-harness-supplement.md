# ERP-06 source and harness supplement

This changes tests and deterministic fixtures only. It does not optimize production or qualify a numeric miss. The final integrated code still needs measurement; the preparatory native branch has the legacy local headroom derivation and no inline Outlook widget.

`homepage-performance.spec.ts` records actual GET/POST request events for every API data endpoint, excluding only current snapshot, source-health and ranking polling. It requires 200 changed populated cursor tuples, with each observed value present, and zero history requests during hover plus actual solo/restore. Catalog, canonical tile, historical forecast and chunk GETs count. The fixture callback array is no longer the request gate.

The same cold predicate on both heads requires populated balance and headroom canvases with values read from consistent source responses. When the existing inline next24 widget is present, its actual populated SVG geometry is required, including a truthful partial profile. The existing 14-row Outlook publication fixture remains unchanged; only two targets fall inside next24. No optional-product omission, complete-24 fabrication, threshold change or warm-cache substitution is used.

Both `mobile-fixtures.ts` and `paired-headroom-fixtures.ts` receive individual and combined SHA256 hashes in each report; a missing shared helper is recorded explicitly. Copy the exact same files and harness to both measurement checkouts. A different hash requires a new comparison. The older query-index values and old measurements are historical.

Native fixture mode uses one timestamp-indexed 300-second source for batch, contributor tiles and paired tiles. The pairing oracle subtracts the two source values at each epoch before aggregation. Inclusive v1 bounds retain the end observation; half-open tiles exclude their own ending epoch and include the same source epoch in the adjacent tile when available. Native availability includes fixed NOW, without deleting the existing v1 observation. Default legacy 64/42-point aggregate screenshot mode and its canonical publication cutoff remain unchanged.

The v1 fixture honors actual requested `max_points`/aggregation. Statistics retain every underlying observation; minmax vertices are real source epochs, with complete native count and extrema. Unbounded source verification explicitly requests `max_points:0`. A native year has 105,121 observations with inclusive endpoints. The bounded physical v1 response has at most 1,200 vertices; the independent paired 1h envelope may legitimately have about 35,040 vertices. No 1,200-point ceiling is applied to that paired path.

The six-range regression checks genuine paired coverage, all retained first/last/min/max epochs, extrema and exact distinct CSV cardinality on a head supporting the paired metric. Native edge tiles are clipped and coarse interiors are fully aligned. Older local-derivation heads explicitly test unavailable coarse headroom rather than falsely claim paired-source acceptance. Their PASS does not prove the integrated paired branch.

The real browser source test failed before correction: the same 6h demand epoch yielded 66,482.96666239861 through v1 and 65,550.95529892591 through the native tile. It now checks every overlapping source tuple across 6h/24h/7d/30d/90d/1y, contributor/pair subtraction, native endpoint contracts, bounded real extrema and complete source counts. Its JSON attachment records each range's native count, returned count, bucket width and source statistics.

Preparatory strict numeric evidence: cold runs 2,543.408 / 2,543.366 / 2,538.938 / 2,528.598 / 2,557.910 ms, median 2,543.366 ms, **FAIL** against unchanged 2,500 ms; pointer p95 34 ms, 200 changed readouts and zero actual history requests. An earlier corrected-oracle report (median 2,566.889 ms) is also preserved as FAIL in campaign evidence. Final strict verification after requiring every counted readout to be populated measured 2,644.933 / 2,669.269 / 2,613.785 / 2,605.154 / 2,546.833 ms (median 2,613.785 ms), also **FAIL**, with 34 ms pointer p95, 200 changed readouts and zero actual GET/POST history requests. All failures remain preserved. These are measurements of the old native product branch, not the final product or a new baseline/candidate comparison.

```sh
PLAYWRIGHT_PORT=4311 pnpm exec playwright test e2e/native-source-fixture-consistency.spec.ts --project=chromium
PLAYWRIGHT_PORT=4311 pnpm exec playwright test e2e/homepage-performance.spec.ts --project=chromium
```
