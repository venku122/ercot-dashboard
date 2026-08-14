# Weather and time-error analytics

## METAR wind semantics

The collector preserves the Aviation Weather observation timestamp on every emitted point. It
emits `metar.winds.direction_degrees` and `metar.winds.gust_mph` only when the official payload
contains numeric values. A `VRB` direction is intentionally left absent rather than converted to
an invented bearing.

The Weather view presents the four major-load-center stations as current-condition cards. The
compass label describes where wind originates; the arrow describes where the air is traveling.
Calm and direction-unavailable observations use explicit text instead of a fabricated direction.

## Time-error trend

The recovery chart computes a rolling Theil–Sen slope over the trailing 15 minutes:

1. Transform each instantaneous time-error sample `e(t)` to `|e(t)|`.
2. Calculate the slope for every valid pair in the trailing window, normalized to seconds per
   minute.
3. Plot the median pairwise slope once at least three valid samples exist.

Negative values mean the absolute error is shrinking toward zero (recovering). Positive values
mean it is growing away from zero (drifting). Values within ±0.01 seconds per minute are labeled
stable. The raw time-error input is queried to derive the trend but is deliberately excluded from
the trend chart legend, CSV, canvas, and accessible table because it has a different unit.

The estimator is deterministic for irregular sampling, tolerates missing non-finite values, and
does not infer a recovery state from the sign of the raw error. Unit tests cover negative and
positive recovery/drift, a zero crossing, irregular intervals, and missing values.

## Validation contract

- Collector fixture tests cover numeric direction, optional gust, `VRB`, observation timestamps,
  and knot-to-mph conversion.
- Frontend unit tests cover wind narration and all time-error direction cases.
- WebKit projects cover iPad portrait (834×1194) and landscape (1194×834) without horizontal
  overflow.
