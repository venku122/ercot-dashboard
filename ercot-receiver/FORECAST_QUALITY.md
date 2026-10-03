# Forecast-quality methodology

PR11 exposes diagnostic forecast-versus-outcome comparisons without treating target time as issue time or using future publications.

Supported semantic keys are `load.system`, `wind.stwpf`, and `solar.stppf`. Load pairs NP3-565 `systemTotal` with NP6-345 `total`; this is explicitly a diagnostic product pairing, not an ERCOT performance declaration. Wind pairs NP4-732 `STWPF_SYSTEM_WIDE` with `SYSTEM_WIDE_HSL`; solar pairs NP4-737 `STPPF_SYSTEM_WIDE` with `SYSTEM_WIDE_HSL`. Generic dashboard metrics and `SYSTEM_WIDE_GEN` are not quality inputs.

For target interval end `t` and horizon `H` (1h, 6h, or 24h elapsed), selection takes the newest official issue `i <= t-H` and requires `H <= t-i < H+3600`. Load additionally requires exactly one active (`inUseFlag`) model. Revision is selected forecast minus the adjacent earlier forecast for the same target and model; it is null across model changes or ambiguous operational vintages.

Signed error is `actual - forecast`, so positive means underforecast. Bias and MAE use the valid paired-row count. MAPE uses only strictly positive actual values and publishes its separate count. Quantiles use Hyndman-Fan Type 7. The historical empirical interval is shown only with at least 100 pairs, 30 Chicago delivery dates, 28 days of span, and 80% joint coverage. It is historical evidence, not probabilistic confidence.

`GET /api/v1/forecast-quality` is a bounded 90-day mutable manifest with a short cache lifetime. It summarizes completed UTC-day resources only, exposes missing reasons and source health, and advertises canonical URLs. `GET /api/v2/forecast-quality/{series_key}/v1/{content_version}/{horizon}/1d/{day_start}` is query-free and immutable. Corrections mint a new content version/current pointer; old bytes and ETags remain available. Authenticated `POST /api/forecast-quality/recompute` rebuilds one aligned UTC day and at most three horizons; no startup history scan occurs.

The Outlook panel is collapsed by default. Opening it loads one manifest and the latest completed canonical daily resource for the selected series and horizon. It provides exact tabular values and methodology disclosure without adding forecast-quality fanout to Overview or the ordinary Outlook request.
