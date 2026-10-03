# Historical context and observed records

PR20 adds a demand-only historical context surface for the canonical
`supply-demand.demand` series. It describes observations accumulated by this
dashboard; it does not claim ERCOT all-time records, forecast performance, or
causal relationships.

The selected statistic is the maximum observed native five-minute demand in
the most recently completed America/Chicago civil hour. A normal hour expects
12 unique slots. The repeated fall 01 hour combines both UTC folds and expects
24 slots; the nonexistent spring 02 hour remains unavailable. An hour qualifies
only at 80% or better coverage. Missing samples are never interpolated or
replaced with zero.

Previous-day, previous-week, and previous-year comparisons use exact local
calendar coordinates. February 29 has no coerced prior-year counterpart.
Seasonal percentiles use qualified maxima from the same meteorological season
and local hour on the prior 400 completed local dates, excluding the target
date. They use Type 7 p10/p50/p90 and require at least 30 qualified dates.

Daily peak rank uses standard competition ranking for the most recent completed
Chicago market day against the preceding 364 local dates. Sparse or
under-qualified history returns a partial rank with explicit numerator,
denominator, excluded-date, and coverage evidence. Rolling 7-, 30-, and 365-day
extrema end at the last completed local day. “Since collection” is bounded by
the receiver's observed coverage and is never labeled an all-time ERCOT record.

The receiver persists correction-aware local-hour and local-day summaries.
Demand inserts or corrections mark the affected Chicago dates dirty and advance
the series generation in the same transaction. Recalculation is incremental;
the resolver does not return an older current resource while dirty work remains.

The short-cache resolver is strict and query-order canonical:

`/api/v1/historical-context?series_key=supply-demand.demand&as_of={utc_hour}`

It embeds the complete bounded summary and links to a deterministic immutable
snapshot:

`/api/v2/historical-context/supply-demand.demand/v1/{content_version}/{utc_hour}`

The content version hashes canonical summary bytes rather than retrieval time or
replica-local generation counters. A correction creates a new URL; an already
advertised old URL retains the same bytes and ETag. The Overview panel is lazy,
makes no request while closed, fetches only one selected summary, and preserves
explicit unavailable, partial, stale-last-good, and refresh-failed states.
