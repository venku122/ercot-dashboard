# ERP-04 shared archived-forecast fixture

Both ordinary browser API installers (`installMobileApi` and dashboard.spec.ts's
private `installApi`) serve `/api/v1/historical-forecast` through one authored
synthetic NP3-565 systemTotal helper. Previously this endpoint returned an
unhandled 404, so ordinary populated tests silently lost the historical forecast.
This repair changes test fixtures only; an actual old receiver still makes the
client display explicit archived-forecast unavailability.

Rows use native UTC hour-ending targets, `interval_start = target - 3600`, and
`interval_end = target`. The forecast generator is independent of observed-demand
and source-paired headroom generators. Each issue is two hours before its delivery
end, must precede delivery start, selected as-of, and fixture retrieval. Retrieval
is fixed browser clock minus 137 seconds; first ingestion is minus 113 seconds.
These clocks are distinct and can follow historical delivery: the fixture claims
official pre-delivery issue, never system-known-at-delivery evidence. Payloads and
vintage/model identities explicitly identify authored synthetic provenance.

Source selection follows the requested half-open target bounds and caps span at
366 days. Count and coverage derive from actual hourly slots and selected rows;
there are no repeated 300-second copies or invented fine-grained observations.
At the fixed hourly-aligned clock, 6-hour/24-hour/7-day source target windows
including the left ending-hour edge contain 7/25/169 native records. The record
ending exactly at the selected start has no overlapping delivery interval;
interval-aware rendering can exclude that edge. Browser checks separately verify
source coverage and the forecast's actual accessible values, allowing that
explicit endpoint/overlap distinction. Cursor policy is validated separately by
the product's delivery-interval regression tests.

Normal, stale and other populated scenarios serve eligible archived rows. Empty
serves a valid unavailable archive with accurate missing-slot counts; error returns 503. The helper also supports an explicit missing-archive 404 for old-receiver
regressions. Later scenario-specific routes can override this shared default.
No source-pair cadence helper or legacy batch generator is rewritten. A focused
browser counterfactual offers a 999999-MW current future snapshot only if the
retired batch forecast query is requested; the client never requests or displays
that substitute.

Focused Chromium tests cover both installers at 320/390/768/1440 for normal
6-hour/24-hour/7-day selections. Mobile tests check exact native target/interval,
issue/retrieval/first-ingestion clocks, source coverage, independent forecast
readouts, accessible table values, and exclusion of legacy future batch queries.
Separate empty/error/missing-archive tests preserve populated actual demand and
explicit forecast unavailability. These are synthetic local browser contracts,
not a public-source capture, production API, or physical-device acceptance claim.
No product code, snapshots or tolerances are changed.
