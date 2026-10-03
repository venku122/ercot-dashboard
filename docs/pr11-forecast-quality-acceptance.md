# PR11 forecast-quality acceptance contract

This document is an independent acceptance oracle for PR11. It intentionally
does not describe implementation internals. Production code, receiver tests,
collector fixtures, frontend tests, and reviewer checks should all agree with
these externally visible semantics.

## Source boundary

The initially supportable load comparison is an explicitly labeled diagnostic
pairing:

- forecast: NP3-565-CD weather-zone load forecast;
- actual: NP6-345-CD actual weather-zone load;
- system mapping: `systemTotal` to `total`;
- zone mappings: `coast`, `east`, `farWest`, `north`, `northCentral` to
  `northC`, `southCentral` to `southC`, `southern`, and `west`.

The product labels and `MW` declarations do not prove one-for-one semantic
parity. Public UI and API methodology text must call the result a diagnostic
comparison until official definitions and ERCOT's published Mid-Term Load
Forecast performance methodology have been cross-checked.

Renewable quality uses only the verified hourly actual/forecast products:

- wind: NP4-732-CD `wpp_hrly_avrg_actl_fcast`, forecast `STWPF`, actual
  `SYSTEM_WIDE_HSL`;
- solar: NP4-737-CD `spp_hrly_avrg_actl_fcast`, forecast `STPPF`, actual
  `SYSTEM_WIDE_HSL`.

`GEN` is not an accepted actual for either product. The existing combined
wind/solar dashboard feed is also not a vintage source: its mutable target-time
metrics do not preserve the issue that produced each forecast.

The strict collector/receiver contract now fixture-backs the exact live field
order and types, units, issue and target timestamps, DST flags, bounded document
enumeration, provenance, and immutable publication identity. Renewable quality
still reports unavailable on a fresh deployment until the disabled-by-default
runner is explicitly enabled and preserved publications have accumulated.

## Per-target horizon selection

For target interval end `t`, requested lead `H`, and verified publication
cadence `C`, select a forecast row independently for that target:

1. retain only the requested semantic source, measure, and model policy;
2. retain only rows whose official issue `i` satisfies `i <= t - H`;
3. select the greatest eligible `i`;
4. require `H <= t - i < H + C`, otherwise record a stale/missing exclusion.

PR11 horizons are `3600`, `21600`, and `86400` elapsed seconds. The last is
labeled **24-hour ahead**, not ERCOT DAM and not “same local hour yesterday.”

The operational model policy requires exactly one `inUseFlag=true` row at the
selected issue and target. Multiple active models are an ambiguity, not a
tie-break. A fixed-model policy has a different public series identity. Model
transitions are counted and disclosed; revisions never cross a model change.

UTC `target_ts` is the analytic identity. Chicago delivery date, hour ending,
DST, and repeat flags remain provenance/display fields. Spring and fall days
therefore contain 23 and 25 distinct hourly UTC targets without changing lead
seconds.

## Numeric oracle

For every finite, unit-compatible pair:

```text
error_mw          = actual_mw - forecast_mw
absolute_error_mw = abs(error_mw)
bias_mw           = sum(error_mw) / valid_error_count
mae_mw            = sum(absolute_error_mw) / valid_error_count
ape_percent       = 100 * absolute_error_mw / abs(actual_mw)
mape_percent      = sum(ape_percent) / valid_ape_count
```

APE is valid only when actual is strictly positive. MAPE has its own count.
Missing, null, zero-denominator, ambiguous, stale, and unit-incompatible rows
are never filled with zero.

Revision is separate from error:

```text
revision_mw = selected_forecast_mw - reference_forecast_mw
```

Positive error means underforecast; positive revision means the forecast moved
up. Both meanings must be stated in text, not conveyed only by color.

Quantiles use deterministic Hyndman-Fan Type 7 interpolation. For sorted values
`x[0..n-1]`, `h=(n-1)*p`; interpolate between `floor(h)` and `ceil(h)`. The
signed-error `p10`, `p50`, and `p90`, plus absolute-error `p80`, are exposed.
For a forecast `f`, the historical 80% empirical outcome band is
`[f+p10(error), f+p90(error)]`.

This is a historical empirical error band, not probabilistic confidence. It is
qualified only with at least 100 valid errors, 30 distinct Chicago delivery
dates, a 28-day target span, and 80% joint forecast/actual coverage. Counts,
coverage, thresholds, methodology version, and failure reasons are public.

## Actual and no-lookahead policy

NP6-345 has no verified official publication time. Its outcome is the latest
retrieved content snapshot at or before the dataset/evaluation cutoff; it is
not described as a final actual. Later corrections or backfills create a new
quality content version.

Forecast selection depends only on official issue, target, model policy, and
the dataset cutoff. It never examines the actual value. A walk-forward
historical empirical band uses only outcomes available before its evaluation
cutoff. A descriptive report may use all completed outcomes in its explicitly
versioned dataset.

## Canonical resources and caching

Every public identity is semantic and contains no SQLite ID. A chart resource
is canonical only when it fixes:

```text
methodology version + content/dataset version + quality key + horizon
+ LOD + UTC tile start/span
```

Tiles use half-open UTC bounds. Strong ETags and byte identity must hold across
MISS, HIT, singleflight waiter, regeneration, and 304 responses. An immutable
URL is allowed only when its content version is in the path and old bytes
remain reproducible. Otherwise the resource is mutable, uses a short TTL, and
has precise correction-range invalidation guarded against in-flight stale
repopulation.

Bias, MAE, and MAPE are never averages of tile averages. Mergeable state keeps
`sum_error`, `sum_absolute_error`, `valid_error_count`, `sum_ape`, and
`valid_ape_count`. Exact empirical quantiles come from a bounded raw-point
summary or an explicitly versioned and documented deterministic method.

## Frontend acceptance

- Quality data is requested only when its owning view/panel is active.
- Hide, navigation, selection change, and unmount abort obsolete requests.
- A replacement is atomic; mixed horizons, models, or dataset versions never
  render together.
- Loading, unavailable, no actuals, insufficient history, unqualified
  interval, and ready states remain distinct.
- The parser validates methodology, source pairing, horizon, model policy,
  content version, counts, units, formulas, and bounded ordering.
- Summary statistics come from the exact summary contract, never display LOD
  points.
- Methodology, sample count, coverage, date span, exclusions, source caveat,
  and positive/negative sign meanings are visible or one keyboard action deep.
- Charts have an exact accessible table; mobile controls meet 44-point targets,
  do not depend on hover or color, and do not create page-level horizontal
  overflow.

## Required deterministic gates

Acceptance includes independent goldens for per-target changing-vintage
selection, exact horizon boundaries, stale candidates, future issues, model
ambiguity, model transitions, 23/25-hour DST days, missing and corrected
actuals, zero-denominator MAPE, revision sign, Type 7 quantiles, and interval
qualification immediately below and at every threshold.

Cache tests cover deterministic bytes/ETag across leader, ten waiters, HIT,
regeneration, and 304; in-flight forecast or actual correction cannot restore
an obsolete content version. API tests enforce bounded ranges and semantic
allowlists, and assert that neither internal IDs nor credentials/provenance
secrets are public.
