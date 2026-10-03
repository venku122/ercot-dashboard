# Frontend semantic tile planner

PR06 migrates fixed, non-comparison history for the cataloged core dashboard
series from arbitrary v1 chunk requests to canonical v2 semantic tiles. It does
not change live-tail or comparison loading.

## Dispatch boundary

The frontend dispatches requests by mode and catalog eligibility:

| Request                                          | Data path                                    |
| ------------------------------------------------ | -------------------------------------------- |
| fixed, comparison off, uniquely cataloged series | v2 semantic tiles                            |
| fixed, comparison off, unsupported series        | v1 chunk compatibility path                  |
| live                                             | existing `/api/series/batch` tail path       |
| any enabled comparison                           | existing `/api/series/batch` path until PR07 |

The served `/api/v2/tile-catalog` remains authoritative for metric identity,
canonical tags, rollup, cadence, allowed LODs, unit, and statistic policy. The
frontend validates schema 2 and resolves a chart series only when its metric,
requested tags, rollup, unit, and statistic policy produce one unique catalog
entry. A missing or ambiguous entry never becomes an empty v2 chart; it uses
the established v1 compatibility path.

The catalog currently maps 26 physical chart series across supply/demand,
frequency, fuel mix, storage, renewables, generation outages, and hub prices.
Ancillary services, DC ties, advanced system-condition metrics, METAR weather,
and application diagnostics remain on v1 until their identities and cadence are
verified and added to the server catalog.

## Deterministic planning

The pure planner accepts an injected `now` and uses integer UTC epoch
arithmetic. It selects the finest supported fixed LOD that stays near the
1,200-point target; spike-critical charts use a 600-bucket target because an
aggregate bucket can project both minimum and maximum points. If no supported
LOD meets the target, the coarsest declared LOD is used.

Only two tile spans exist:

- complete UTC days whose end is outside the 24-hour correction horizon use
  aligned `1d` tiles;
- intervals inside or crossing that horizon use aligned `1h` tiles.

A URL contains only the schema-defined semantic key, fixed span, aligned start,
and fixed LOD. It does not contain the selected dashboard range, viewport,
comparison mode, target point count, or an arbitrary resolution. Two dashboard
windows that need the same semantic tile/day/LOD therefore emit the same URL.

The selected window remains inclusive at both ends to preserve the established
frontend contract. Because v2 tiles are half-open, the planner covers through
`end + 1` and may request the tile beginning exactly at the selected end. It
then retains native observations with `start <= ts <= end`.

Coarse aggregate buckets are used only when their complete half-open interval
falls inside `[start, end + 1)`. Any tile containing a non-LOD-aligned boundary
is requested at native LOD. This prevents filtering a coarse bucket after the
fact, which cannot reproduce exact count, extrema, or integral semantics.

UTC arithmetic is unchanged across spring-forward and fall-back dates; browser
locale never participates in tile alignment.

## State, display, and statistics

Every tile and aggregate state is validated against its request before use:
schema, key, span, start/end, LOD, cadence, unit, policy, rollup, bucket bounds,
ordering, aggregate version, finite values, endpoint ordinals, and extrema.
Malformed or incomplete tile sets are discarded atomically for that physical
series and the series is reloaded from v1.

Native states reconstruct original observations in `(timestamp, tile-local
ordinal)` order. Ordinary coarse buckets display their arithmetic average at
the aligned bucket start. Spike-critical charts display the timestamped minimum
and maximum envelope in deterministic order. Empty coarse states do not create
zero-valued points.

Statistics never come from these display projections. Aggregate states are
merged directly, preserving count, sum, timestamped extrema, first/last, gaps,
and the left-step bridge between fragments. Average is `sum / count`, latest is
the merged last value, and MW energy is `integral_value_seconds / 3600` only for
power-policy series. Gauge series report no energy.

This makes v2 statistics exact for the observations represented by the selected
native edges and aligned coarse interior. The earlier v1 fixed loader computed
statistics from its downsampled display points; the exact raw-state result is a
deliberate semantic improvement with golden numeric tests, not an incidental
recalculation of the displayed spike envelope.

Derived series are calculated only after every physical input has either
completed v2 assembly or completed its v1 fallback. No physical series mixes a
partial v2 result with v1 points.

## Failure, cancellation, and fanout

Catalog fetch or validation failure falls back to the complete v1 fixed loader.
An unsupported series or any failed/malformed tile falls back atomically for
that physical series while eligible siblings remain on v2. Abort errors always
propagate and never start a compatibility request.

Identical canonical URLs are deduplicated within one dashboard load. Tile
requests run with a maximum concurrency of eight, preserving stable result
ordering even for a 12-month daily plan. Promise reuse across separate loads,
selected/comparison overlap reuse, and cancellation-safe application caching
remain PR07 scope.

## Verification and limitations

Deterministic tests cover:

- the 26 current core chart-to-catalog mappings;
- 1h, 6h, 12h, 24h, 3d, 7d, 30d, 90d, and 12-month LOD plans;
- 60-second, 5-minute, 15-minute, and hourly native cadences;
- correction-horizon and exact hour/day boundaries;
- inclusive end observations, UTC DST dates, native/coarse hybrid windows,
  missing buckets, gaps, and equal timestamps;
- raw-state statistics, negative power energy, gauges, spike envelopes, and
  derived series;
- catalog and tile validation failure, per-series fallback, AbortError,
  within-load deduplication, and the eight-request concurrency cap;
- unchanged live, comparison, and exact v1 compatibility contracts.

This PR does not add a cross-load browser cache, migrate comparisons, alter
visible chart definitions, activate an edge rule, merge, or deploy. Browser and
live-origin proof remain later stack gates; PR06's visual behavior is exercised
against the existing frontend and VRI suite before publication.
