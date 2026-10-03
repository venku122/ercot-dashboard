# PR14 market mechanics acceptance contract

This is an independent black-box acceptance oracle for PR14. It freezes the
public meaning of the market-mechanics resources without prescribing their
internal tables or collector implementation.

## Evidence, not decomposition

The feature answers "what market conditions accompanied this price?" It does
not claim that the displayed values add to a hub or load-zone Settlement Point
Price, and it does not claim that any adjacent reading caused that price.
System lambda, energy and Ancillary Service price adders, MCPC, capability,
outages, net load, and Settlement Point Prices retain their own source,
timestamp, cadence, and unit.

Every public response uses the stable policy token:

```text
time_adjacent_context_not_causal_decomposition
```

No response contains a calculated price, contribution percentage, causal
ranking, or arithmetic decomposition.

## Source contracts and time

The accepted current-day products are:

- NP6-322-CD: SCED System Lambda;
- NP6-323-CD: Real-Time Price Adders by SCED Interval;
- NP6-328-CD: Total Capability Available to Provide Ancillary Service;
- NP6-332-CD: Real-Time Clearing Prices for Capacity by SCED Interval.

SCED timestamps are America/Chicago wall-clock values paired with
`RepeatedHourFlag`. They normalize to UTC without truncating seconds. Document
`PublishDate` is publication provenance, never the observation timestamp. The
raw offset-bearing PublishDate must normalize exactly to `issued_at` and must
remain byte-for-byte available with each row that it sourced. A daily resource
accumulated from several documents therefore has row-level provenance rather
than one misleading resource-wide publication.

NP6-322 is the canonical System Lambda source. The SystemLambda repeated in
NP6-323 is a same-SCED parity check, not a second historical series. A current
market snapshot exists only at an exact normalized SCED timestamp having a
complete NP6-322 row, NP6-323 row, NP6-328 row, and all five NP6-332 AS rows.
Independent per-product latest rows may be shown separately, but may not be
presented as a coherent snapshot.

## Fixed scalar resource catalog

Each historical resource is scalar and has one immutable unit. The catalog is
exactly 31 identities:

- one NP6-322 System Lambda series;
- six NP6-323 price-adder series;
- eleven NP6-323 operational-input series;
- eight NP6-328 capability series;
- five NP6-332 MCPC series.

The six adders are energy, Reg-Up, Reg-Down, RRS, ECRS, and Non-Spin. Energy
uses `$/MWh`; Ancillary Service adders use `$/MW`. Operational inputs and
capability values use `MW`. MCPC uses `$/MW`. A resource row has one finite
numeric `value`; source field maps are never exposed as a chartable scalar.
Capability combinations overlap and must not be summed.

`RTDLL` remains the neutral public key `rtdll`: the reviewed first-party wire
contract and revision history expose the field but do not define its expansion.
Likewise, `RTBLTIMPORT` and `RTBLTEXPORT` use the neutral keys `rtblt-import`
and `rtblt-export`. UI copy must retain the raw source-field provenance and may
not expand either abbreviation without additional authoritative evidence.

NP6-324-CD and NP6-331-CD remain deferred 15-minute settlement products.
NP6-331 is ERCOT's time-weighted published result and must never be recreated
with a simple average. NP4-212-CD curves remain deferred because a bounded
live document contained 370,224 rows; they require a separate bounded curve
contract rather than generic time-series ingestion.

## Daily resources and corrections

Historical URLs are query-free, UTC-day-aligned, and content-addressed. The
open UTC day remains a mutable current snapshot and creates no immutable daily
resource versions. After rollover, the completed day is sealed once across the
exact 31 scalar identities. A sealed resource contains every current row in the
half-open day `[start, end)`, sorted by exact SCED timestamp. A later correction
replaces only the same product/natural-key row and creates a new content version
for the affected scalar; unrelated scalar versions do not churn. The prior URL
keeps identical bytes and ETag through its advertised lifetime.

The short-cache manifest may retain at most twelve recent SCED observations per
scalar series and its encoded response is bounded to 256 KiB. It may expose an
exact same-SCED current snapshot separately. Neither live representation is an
immutable canonical history tile. Acceptance ingests 300 current-day SCED
documents and requires zero resource blobs, then proves one rollover seal, no
growth for unchanged replay or further current-day ingestion, and exactly one
additional immutable version for a completed-day correction.

The current-day MIS files do not establish deep history. History before the
collector start remains explicitly unavailable until the NP6-792/793/794/795/
796 archive flow has a reviewed manifest, checksums, and gap report.

## Cache and lifecycle acceptance

The mutable manifest is short-cacheable and invalidated by every accepted
publication. A generation racing ingest cannot republish stale manifest state.
Canonical resources return deterministic bytes and one strong ETag across
leader, waiter, LRU hit, regeneration, and `304`. Errors and unknown versions
are `no-store`. The public payload never exposes SQLite identifiers.

Required deterministic tests cover exact 31-series cardinality and units,
multi-document accumulation, correction immutability, raw PublishDate equality,
same-SCED completeness, lambda parity match/mismatch, fall DST, multi-row
documents, valid empty versus failure, schema drift, negative/extreme finite
prices, singleflight, ETag/304, and cache-generation races.

## Browser and visual evidence

Local Darwin evidence on 2026-08-19 covers the collapsed-zero-request contract,
one manifest plus selected-series-only history, stale-source disclosure, exact
current-versus-previous deltas, native 44-point controls, intentional horizontal
scrolling confined to the exact-value table, and no 440-point viewport overflow.
The focused desktop Chromium case passed 1/1. The focused 440 x 956 iPhone
WebKit functional and visual cases passed 2/2.

The deterministic history fixture contains observations at relative seconds
60, 360, 1260, and 1560. Browser acceptance asserts two SVG polylines whose
x coordinates are `[0, 20]` and `[80, 100]`; it therefore proves that the
15-minute missing interval is positioned on the exact time axis and is visibly
discontinuous rather than bridged. Reviewed Darwin snapshots cover the energy
reading, the separated history profile, and the horizontally scrollable exact
values table on desktop Chromium and iPhone WebKit.

Pinned Linux/Ubuntu Noble baselines were generated and reviewed on 2026-08-19
with `CI=true` in `mcr.microsoft.com/playwright:v1.61.1-noble`. The update run
passed desktop Chromium 1/1 and iPhone Pro Max WebKit 2/2; an immediate
no-update comparison passed the same 1/1 and 2/2 matrix. The six Noble images
show the same readable energy evidence, exact-time discontinuous profile, and
internally scrolling table as their Darwin counterparts. The CI mobile job
explicitly includes `e2e/mobile-market-mechanics.spec.ts`.
