# Net-load and ramp methodology

PR12 publishes dashboard-derived net load. It is not labeled as ERCOT's official
net-load product.

Actual net load uses only values captured at the same timestamp from ERCOT's
[Real-Time System Conditions](https://www.ercot.com/content/cdr/html/real_time_system_conditions.html):

`Actual System Demand - Total Wind Output - Total PVGR Output`

The simultaneously published `Average Net Load` is retained as a comparison.
`published_residual_mw` is derived minus published; it is diagnostic rather than
an equality requirement because ERCOT's internal averaging and timing may differ.

Forecast net load uses one coherent preserved curve from each source under one
cutoff: NP3-565 `systemTotal`, NP4-732 `STWPF_SYSTEM_WIDE`, and NP4-737
`STPPF_SYSTEM_WIDE`. Public keys explicitly say the latest coherent curve is
capped 1, 6, or 24 hours before the UTC day. For a future day,
the manifest reports `effective_as_of=min(policy_cutoff,dataset_cutoff)` and the
resource remains provisional until the policy cutoff is reached. Contributor
`issued_at` may never be newer than that effective time; `retrieved_at` is
preserved provenance and may be later for a backfill. The mutable cutoff belongs
to the manifest link rather than immutable resource bytes. These are not
per-target lead-time claims. The renewable terms forecast uncurtailed HSL potential; ERCOT's
[Combined Wind and Solar](https://www.ercot.com/gridmktinfo/dashboards/combinedwindandsolar)
page warns that dashboard actual generation is curtailment-affected and should
not be used as forecast-performance truth.

## Ramps and storage

One-hour and three-hour ramp values are exact elapsed MW changes. A missing
endpoint produces a missing ramp; values are never interpolated or bridged.

`dashboard_evening_v1` is a dashboard-defined Central-time policy, not an ERCOT
interval: `[16:00,22:00) America/Chicago`, evening maximum with earliest ties,
and the preceding/on-peak daily minimum with earliest ties. Daily resources are
separate from UTC chart tiles so 23-, 24-, and 25-hour market days remain exact.
Incomplete daily inputs publish no ramp summary.

ERCOT's published Supply/System-Wide Demand basis excludes ESR charging. Storage
net output is therefore context only and is never added to or subtracted from
the formula. Positive net output means discharging and negative means charging,
consistent with the [Energy Storage Resources](https://www.ercot.com/gridmktinfo/dashboards/energystorageresources)
dashboard. Proximity is not presented as causation.

## Canonical resources and lifecycle

`GET /api/v1/net-load` is a bounded, short-cache manifest. It advertises the
same semantic keys and native-only policy exposed under `derived_resources` in
`GET /api/v2/tile-catalog`.

UTC time-series tiles use:

`/api/v2/net-load/{series_key}/v1/{content_version}/1d/{utc_day_start}/native`

Central-time summaries use:

`/api/v2/net-load-daily/{series_key}/v1/{content_version}/{delivery_date}`

Both are query-free, content-addressed, strongly ETagged, and immutable. A
correction creates a new current pointer while old bytes remain addressable.
Actual tiles are finalized only after UTC rollover. Forecast publication ingest
attempts only bounded intersecting days and publishes a pointer only once the
load, wind, and solar curves (including the three-hour ramp halo) are coherent.
The manifest retains 90 historical days and at most eight future forecast days.

Authenticated `POST /api/net-load/recompute` rebuilds one aligned UTC day and one
semantic series. It is the bounded bootstrap/backfill mechanism; startup never
scans history. Existing installations therefore need an explicit bounded
backfill if pre-PR12 history should be discoverable immediately.
