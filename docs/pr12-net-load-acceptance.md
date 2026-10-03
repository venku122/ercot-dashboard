# PR12 net-load and ramp acceptance contract

This document is an independent black-box acceptance oracle for PR12. It
defines observable semantics, not implementation details. Production code,
API resources, tests, and user-facing copy must agree with it.

## Source and formula boundary

ERCOT defines net load as load minus wind and solar. The derived actual is:

```text
actual_net_load_mw = actual_load_mw - wind_generation_mw - solar_generation_mw
```

All three inputs must describe the same interval, use MW, and have compatible
load/generation semantics. Missing inputs remain missing; they are never
filled with zero or interpolated.

The current official comparator is the Real-Time System Conditions quartet
from one source scrape: Actual System Demand, Total Wind Output, Total PVGR
Output, and Average Net Load. The scrape timestamp is shared by all four
values. The dashboard reports the calculated value and its difference from
the published Average Net Load without silently forcing them to agree.

Historical hourly actuals use actual generation, not HSL. In particular,
`SYSTEM_WIDE_GEN` from NP4-732-CD and NP4-737-CD is distinct from
`SYSTEM_WIDE_HSL`. An implementation that substitutes HSL for actual wind or
solar generation does not satisfy this contract.

The preserved forecast curve is:

```text
forecast_net_load_mw = load_forecast_mw - STWPF_SYSTEM_WIDE - STPPF_SYSTEM_WIDE
```

STWPF and STPPF forecast HSL, or uncurtailed renewable potential. Therefore
the public label is **Derived forecast net load — HSL-potential basis**. It is
not labeled ERCOT's official net-load forecast and is not represented as the
intra-hour IHLF/IHWPF/IHPPF calculation used in ERCOT ancillary-service
methodology.

Forecast components come from a coherent, whole-curve preserved publication
selection. The policy cutoff is the requested lead before the UTC or market-day
start, while `effective_as_of` is capped at the dataset/current cutoff. A future
day therefore remains `finalized=false` until the policy cutoff has passed; it
never reads a future publication or masquerades as a per-target lead forecast.
Selection never examines actual outcomes. The response exposes the semantic
vintage keys, issue times, policy cutoff, effective as-of, basis, finalization,
and missing reasons. A target is missing if any component of its selected curve
is missing or unit-incompatible.

## Ramp oracle

For exact hourly UTC interval-end targets:

```text
ramp_1h_mw[t] = net_load_mw[t] - net_load_mw[t - 3600]
ramp_3h_mw[t] = net_load_mw[t] - net_load_mw[t - 10800]
```

Positive means the load remaining after wind and solar increased; negative
means it decreased. These values are MW changes, not MW/hour slopes and not
forecast lead horizons. A visible request fetches a three-hour lookback halo,
computes exact deltas, and clips output to the requested half-open interval.
It never computes a shorter edge delta or bridges a missing point.

## Daily evening-ramp oracle

Methodology `dashboard_evening_v1` groups rows by ERCOT market day in
`America/Chicago` and defines the evening window as local clock time
`[16:00, 22:00)`. The evening peak is the greatest valid net-load value in
that window, with the earlier UTC target winning an equal-value tie. The
starting minimum is the smallest valid value in that market day at or before
the selected peak, again with the earlier target winning a tie.

```text
daily_evening_ramp_mw = evening_peak_mw - preceding_minimum_mw
```

The API exposes both values and timestamps, observed and expected hourly
counts, completeness, methodology version, and exclusion reason. A complete
spring-forward day has 23 distinct UTC targets and no HE2. A complete
fall-back day has 25 targets and two distinct HE2 intervals ordered by their
source DST/repeat flag. UTC identity, not a formatted local-hour label,
governs ordering and 1h/3h deltas.

## Storage boundary

Storage is context only and is never an input to either net-load formula.
ERCOT storage net output is positive while discharging and negative while
charging. The UI may place that measurement beside the ramp, but must not add,
subtract, or negate it to manufacture an “adjusted net load.” It must not say
storage caused, covered, or absorbed a ramp without a separately supported
analysis.

## Canonical resource and cache contract

Every historical resource identity includes its series/basis, methodology
version, immutable content version, LOD, UTC tile start, and span. Bounds are
half-open. URLs contain no query string, SQLite ID, credential, or mutable
“latest” alias. Canonical JSON bytes and strong ETag are identical across
origin generation, singleflight leader and waiters, cache HIT, regeneration,
and a matching conditional request returns 304 with no body.

Mutable manifests may point to a replacement immutable content version, but a
client replacement is atomic: mixed actual/forecast vintages or methodology
versions never render together. Corrections create a new content identity and
cannot repopulate an invalidated old current pointer through an in-flight
request.

Catalog entries and API metadata distinguish:

- published ERCOT Average Net Load;
- derived actual net load using actual generation;
- derived forecast net load on the HSL-potential basis;
- 1h and 3h MW changes; and
- `dashboard_evening_v1` daily summary.

## Frontend acceptance

Net-load data is requested only while its owning surface is active. Hide,
navigation, selection change, and unmount abort obsolete requests. Loading,
unavailable, partial, stale, and ready states remain distinct, and stale data
never presents as current.

The Generation view leads with “Demand remaining after wind and solar” and
shows actual, explicitly qualified forecast, 1h/3h change, and the daily
evening ramp without treating color as the only sign cue. Exact accessible
tables expose source values, target times, issue/cutoff metadata, and missing
reasons. Storage appears as a separate contextual reading.

At phone and tablet widths, controls retain 44 CSS-pixel targets, tables use a
bounded horizontal scroll region rather than page overflow, charts remain
usable without hover, and the primary net-load/ramp interpretation precedes
methodology detail.

## Required deterministic gates

- same-scrape current quartet and published-versus-derived difference;
- rejection of mixed scrape timestamps;
- actual generation versus HSL source discrimination;
- coherent whole-curve forecast publication selection and no-lookahead cutoff;
- missing component, unit mismatch, correction, and equal-value tie behavior;
- exact first-visible 1h/3h deltas using the lookback halo;
- no delta across missing or non-exact timestamps;
- normal, 23-hour spring, and 25-hour fall market days;
- both repeated fall HE2 intervals and exact UTC ordering;
- `[16:00, 22:00)` boundary inclusion/exclusion and preceding-minimum rule;
- explicit proof that storage changes do not change net-load values;
- canonical URL, byte, ETag, singleflight, invalidation, and 304 behavior; and
- lazy request, abort, source-state, accessible-table, mobile, and no-overflow
  browser evidence.

## Source authority and limitations

- [ERCOT Summer 2024 Operational and Market Review](https://www.ercot.com/files/docs/2024/10/03/7-summer-2024-operational-and-market-review.pdf)
  states the load-minus-wind-minus-solar formula and discusses evening net-load
  peaks.
- [ERCOT 2025 ancillary-service methodology](https://www.ercot.com/files/docs/2024/10/03/9-3-1-recommendation-regarding-2025-ercot-methodologies-for-determining-minimum-ancillary-service-requirements.pdf)
  defines its intra-hour net-load forecast from load, wind, and solar forecast
  components. PR12's hourly sources are not relabeled as those intra-hour
  products.
- [Real-Time System Conditions](https://www.ercot.com/content/cdr/html/real_time_system_conditions.html)
  publishes the live Average Net Load comparator and its component readings.
- [Combined Wind and Solar](https://www.ercot.com/gridmktinfo/dashboards/combinedwindandsolar)
  distinguishes actual generation from HSL and explains that STWPF/STPPF
  forecast uncurtailed potential.
- [Energy Storage Resources](https://www.ercot.com/gridmktinfo/dashboards/energystorageresources)
  defines the charging/discharging signs used for the separate storage context.

The `[16:00, 22:00)` window is a versioned dashboard policy informed by ERCOT
operational reviews, not a claim that ERCOT publishes one timeless universal
definition of “evening ramp.” The precise load basis of each historical source
must remain visible; similarity links between dashboard and report products do
not prove one-to-one equality.
