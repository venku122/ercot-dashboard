# PR20 historical context and records acceptance

PR20 v1 is demand-only. It summarizes observations accumulated by this dashboard and does not
claim an ERCOT historical archive, forecast, causal model, or all-time record. Its policy literal is
`collection_history_season_and_local_hour_context_not_forecast_or_all_time_record`.

## Exact source boundary

The only accepted v1 series is tile-catalog key `supply-demand.demand`:

- metric `ercot.supply_demand.demand_mw`;
- exact tag `source:supply_demand`;
- unit MW;
- source `supply_demand`, the official ERCOT Supply and Demand dashboard;
- native observation cadence 300 seconds; and
- timestamp basis: the exact source-row epoch, normalized to integer UTC seconds.

The receiver's deduplicated metric history begins when this deployment collected it. There is no
archive backfill and no guarantee that a prior day, week, or year exists. Empty source history,
missing comparison history, insufficient statistical history, incomplete coverage, and source
failure remain different states. Copy says “dashboard observations since collection began,” never
“ERCOT history,” “historical normal,” or “all-time ERCOT record.”

Legacy `ercot.pricing` and other tile-catalog series are outside v1. In particular, a capture-timed
series without a reviewed source timestamp must not inherit the demand timestamp or statistical
contract merely because it can be drawn as a historical tile.

## Target civil hour and coverage

The target is the most recently completed America/Chicago civil-hour label. A local civil hour is
the set of all UTC instants whose Chicago local date and hour match the label. It is complete only
after every UTC interval belonging to that label has ended.

- An ordinary civil hour contains twelve expected five-minute observation slots.
- The repeated fall-back hour `01` combines both folds under one civil-hour label and contains
  twenty-four expected slots. The dashboard never chooses or hides one fold.
- The nonexistent spring-forward hour `02` contains zero slots and is `unavailable`; it is never
  shifted to `01` or `03`.

The hourly statistic is the maximum observed native demand value in that civil hour. Equal maxima
select the earliest UTC observation timestamp. Samples are never filled, interpolated, or borrowed
from adjacent hours. Every result exposes observed count, expected count, coverage ratio, earliest
and latest observed UTC timestamp, local date/hour, and the UTC interval or intervals represented.

An ordinary or repeated hour is qualified only when `observed_count / expected_count >= 0.80`.
Exactly 80 percent qualifies. A zero expected count is unavailable rather than complete. An
unqualified maximum may be exposed only as a partial observed value and is excluded from
comparisons, percentile cohorts, and record ranks.

## Exact calendar comparisons

Previous-day, previous-week, and previous-year targets preserve the same America/Chicago local
hour and use local calendar arithmetic:

- previous day subtracts one local calendar date;
- previous week subtracts seven local calendar dates; and
- previous year uses the same month and day in the preceding calendar year.

These are not fixed 24-hour, 168-hour, or 365-day UTC offsets. A February 29 target has no previous
year comparison when the prior year lacks February 29; it returns
`unavailable_no_calendar_anniversary` and is never coerced to February 28 or March 1. A comparison
is available only when that exact prior civil hour is qualified. The response retains each target's
own UTC interval list, so 60-minute and 120-minute civil hours are not presented as equal elapsed
windows.

## Season and local-hour percentile cohort

The percentile cohort uses only qualified civil-hour maxima on local dates strictly before the
target local date. It includes at most the preceding 400 completed America/Chicago dates and must
match both:

- the target local hour `00` through `23`; and
- the target meteorological season: December–February `DJF`, March–May `MAM`, June–August `JJA`,
  or September–November `SON`.

No target observation, future observation, different local hour, or different season enters the
cohort. Fall repeated-hour dates contribute one combined civil-hour maximum, not two independently
weighted samples. Spring dates without the target civil hour contribute no sample and are counted
as excluded.

Percentiles are exact Hyndman–Fan/R Type 7 p10, p50, and p90 over the bounded raw hourly maxima:
sort ascending, set `h = (n - 1) * p`, and linearly interpolate between zero-based values
`floor(h)` and `ceil(h)`. The percentile state is insufficient unless it has at least 30 distinct
qualified local dates. The result exposes method, season, local hour, sample count, eligible and
excluded date counts, first and last cohort dates, 400-date lookback bound, 80-percent qualification
threshold, and unit.

## Daily peak rank and observed records

A Chicago local day spans local midnight to the next local midnight and therefore has 276, 288, or
300 expected five-minute slots on a 23-, 24-, or 25-hour day. Its daily peak is the maximum observed
native demand sample, with the earliest UTC timestamp winning equal maxima. It qualifies at the same
80-percent day coverage threshold.

The ranked target is the most recently completed qualified Chicago local day. Its cohort is the
target plus qualified prior completed days in the preceding 365 local dates. Competition rank is
`1 + count(cohort_peak > target_peak)`; equal peaks share a rank and no rank is skipped by timestamp
tie-breaking. The response exposes target peak, rank, cohort size, qualifying/excluded counts,
coverage, cohort date bounds, and unit. Fewer comparison days is a truthful partial cohort, not a
claim about a full year.

Rolling windows are exactly 7, 30, and 365 completed Chicago local dates. Each exposes highest and
lowest **observed** native values, their earliest UTC timestamps on ties, covered/expected sample
counts, coverage, and actual available date span. The since-collection extrema use the same observed
language and expose the first retained observation timestamp. Neither rolling nor since-collection
copy uses “all-time,” “record for ERCOT,” or another claim beyond retained dashboard observations.

## Corrections, materialization, and cache truth

Reusable summaries are derived, methodology-versioned resources. A proposed bounded implementation
materializes at most 400 Chicago daily summaries, each with at most 24 civil-hour summaries, plus a
bounded since-collection extrema state for the one accepted series. Raw demand remains the source of
truth; existing tile count, sum, minimum, and maximum state is insufficient to reconstruct exact
Type 7 percentiles.

An inserted or corrected demand observation invalidates every affected Chicago local-day summary,
comparison, cohort, rank, and rolling/since-collection result. A correction that moves an
observation between timestamps invalidates both old and new local dates. Exact replay is byte-stable
and creates no new version. Content identity includes methodology version, exact series identity,
affected local date or cohort bounds, and all contributing summary versions.

Strong ETags and response bytes are stable across MISS, HIT, cold singleflight waiters, and `304`.
Generation-aware invalidation prevents a correction arriving during computation from repopulating
stale bytes. No non-content-addressed statistical response is called immutable, because older source
observations can be corrected.

## Bounded wire and UI truth

The future public resource must remain demand-only and bounded: one series identity, one target
civil hour, three calendar comparisons, one percentile summary, three rolling windows, one daily
peak rank, one since-collection summary, explicit coverage/methodology, and bounded source health.
Exact route, root keys, enums, content-version grammar, and cache headers are frozen only when core
exports them; acceptance must not infer a provisional wire.

The UI labels the values as observed historical context. It visibly distinguishes ready, partial,
insufficient history, missing comparison, nonexistent civil hour, stale last-good, refresh failure,
and unavailable source states. It does not use percentile bands as forecasts, expected ranges,
probabilities, alerts, or evidence that demand was caused by weather, price, storage, or an event.

## Independent acceptance goldens

Source and pure-statistics acceptance must cover:

1. exact demand metric, tag, MW unit, source epoch, and rejection of other series;
2. ordinary-hour 12-slot and exact 80-percent qualification boundaries;
3. both fall folds combined into one 24-slot `01` hour;
4. unavailable spring `02` and 23-/24-/25-hour daily expected counts;
5. local-calendar day/week/year comparisons across UTC-offset changes;
6. February 29 previous-year unavailability without coercion;
7. prior-only same-season and same-hour filtering with no target/future leakage;
8. exact Type 7 interpolation and the 29/30-date insufficiency boundary;
9. earliest-timestamp extrema ties and daily competition-rank ties;
10. rolling 7/30/365 bounds, partial available spans, and observed-not-all-time copy;
11. missing points without fill/interpolation and exclusion of unqualified hours/days; and
12. insert, exact replay, correction, timestamp-moving correction, content-version, ETag, `304`,
    singleflight, and in-flight invalidation behavior.

Once core exports a stable API/resource contract, an independent receiver black-box test binds its
exact query allowlist, response keys and enums, cardinality and byte bounds, coverage arithmetic,
methodology identity, correction behavior, cache headers, ETag bytes, `304`, singleflight, and
generation guard. Until then this document is the acceptance oracle and no implementation-owned
file is modified by this task.

## Deferred

- archive backfill and any guarantee of a previous year;
- pricing, frequency, storage, renewables, outages, fuel mix, weather, or arbitrary metric records;
- weekday/weekend, holiday, climate-normal, or weather-conditioned cohorts;
- approximate percentile sketches or percentiles reconstructed from tile averages/extrema;
- forecasts, anomaly alerts, causal attribution, and ERCOT all-time records; and
- cross-series ranking or comparisons with different timestamp, cadence, unit, or statistic
  semantics.
