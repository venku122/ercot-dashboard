# PR13 regional geography acceptance contract

This document is an independent black-box acceptance oracle for PR13. It
freezes source meaning, taxonomy, geography, storage, API, and user-interface
requirements without prescribing implementation symbols. Production code,
sanitized fixtures, receiver tests, frontend tests, and browser evidence must
agree with it.

## Scope and source authority

PR13 covers three different regional taxonomies. They are not interchangeable:

- load weather zones: `coast`, `east`, `far-west`, `north`, `north-central`,
  `south-central`, `southern`, `west`;
- wind regions: `panhandle`, `coastal`, `south`, `west`, `north`;
- solar regions: `center-west`, `north-west`, `far-west`, `far-east`,
  `south-east`, `center-east`.

The same-looking words in different taxonomies do not establish shared
boundaries. No implementation may map, merge, or compare regions across these
families without a separately reviewed official crosswalk.

The official source authority is ERCOT's Public API inventory, ERCOT MIS
documents, and ERCOT's [Generation information](https://www.ercot.com/gridinfo/generation/index.html).
ERCOT's [media-kit map page](https://www.ercot.com/news/mediakit/maps/index)
defines weather zones and offers a raster reference map. It does not provide a
reviewed machine-readable polygon contract for these three taxonomies.

## Load weather zones

Existing preserved publications provide the complete supportable load
contract:

- forecast: NP3-565-CD
  `/np3-565-cd/lf_by_model_weather_zone`;
- actual: NP6-345-CD `/np6-345-cd/act_sys_load_by_wzn`;
- unit: MW;
- analytic identity: normalized UTC interval-end `target_ts`, retaining raw
  delivery/operating day, hour ending, and DST flag.

The exact forecast measures are `coast`, `east`, `farWest`, `north`,
`northCentral`, `southCentral`, `southern`, `west`, and `systemTotal`. Forecast
rows also retain `postedDatetime`, `model`, `inUseFlag`, and `DSTFlag`. Actual
measures are `coast`, `east`, `farWest`, `north`, `northC`, `southC`,
`southern`, `west`, and `total`, plus `DSTFlag`.

The only accepted field-name translations are:

| Public region | NP3-565 forecast | NP6-345 actual |
| ------------- | ---------------- | -------------- |
| Coast         | `coast`          | `coast`        |
| East          | `east`           | `east`         |
| Far West      | `farWest`        | `farWest`      |
| North         | `north`          | `north`        |
| North Central | `northCentral`   | `northC`       |
| South Central | `southCentral`   | `southC`       |
| Southern      | `southern`       | `southern`     |
| West          | `west`           | `west`         |

NP3-566-CD and NP6-346-CD are not substitutes. A bounded official MIS check on
2026-08-18 found NP3-566's exact CSV header to contain only `DeliveryDate`,
`HourEnding`, `Valley`, `Model`, and `DSTFlag`, while NP6-346 contains
`OperDay`, `HourEnding`, `NORTH`, `SOUTH`, `WEST`, `HOUSTON`, `TOTAL`, and
`DSTFlag`. `Valley` must never be guessed into the four-zone actual taxonomy.

Load forecast selection and error reuse the PR11 contract: select per target,
at the requested elapsed lead cutoff, require exactly one `inUseFlag=true`
row, and compute `error_mw = actual_mw - forecast_mw`. The UI must call this a
diagnostic product pairing, preserve issue/retrieval provenance, and never look
ahead to actual outcomes during forecast selection.

## Renewable source contracts

All four products are public, official MIS CSV ZIP documents. Publication
identity uses the exact numeric DocID plus raw offset-bearing PublishDate and
file identity. The parser retains the raw PublishDate and normalizes an
unambiguous UTC issue epoch. Observed PublishDate grammar was
`YYYY-MM-DDTHH:mm:ss-05:00`; the contract accepts the reviewed numeric offset
form rather than freezing a daylight offset.

Header fingerprints are lowercase SHA-256 of the UTF-8 compact JSON array of
the exact ordered header strings, with no whitespace.

PR13 ingests the hourly NP4-742 and NP4-745 products. Its "current" value is
the newest available hourly `GEN`, and its change is the exact difference from
the prior hourly target. It does not claim five-minute freshness. Ingestion of
NP4-743 and NP4-746 is explicitly deferred to P1. Their verified contracts are
recorded below so the later adapter cannot invent a schema, but they are not
advertised in the PR13 runtime manifest, source health, freshness, or UI.

### NP4-742-CD hourly wind geography

- report type: `14787`;
- Public API path: `/np4-742-cd/wpp_hrly_actual_fcast_geo`;
- exact header count: 28;
- fingerprint:
  `19cd7f070b74ac47bc1678b3804015a994def81971bce1fb327d6e941be15b22`.

```text
DELIVERY_DATE,HOUR_ENDING,SYSTEM_WIDE_GEN,COP_HSL_SYSTEM_WIDE,STWPF_SYSTEM_WIDE,WGRPP_SYSTEM_WIDE,GEN_PANHANDLE,COP_HSL_PANHANDLE,STWPF_PANHANDLE,WGRPP_PANHANDLE,GEN_COASTAL,COP_HSL_COASTAL,STWPF_COASTAL,WGRPP_COASTAL,GEN_SOUTH,COP_HSL_SOUTH,STWPF_SOUTH,WGRPP_SOUTH,GEN_WEST,COP_HSL_WEST,STWPF_WEST,WGRPP_WEST,GEN_NORTH,COP_HSL_NORTH,STWPF_NORTH,WGRPP_NORTH,SYSTEM_WIDE_HSL,DSTFlag
```

### NP4-743-CD five-minute wind actual geography

- report type: `14788`;
- Public API path: `/np4-743-cd/wpp_actual_5min_avg_values_geo`;
- exact header count: 9;
- fingerprint:
  `4bfd30a0e32745e8eef7bdda6cf7e3b0dac7f398e90f518436253ebd0e2d76a1`.

```text
INTERVAL_ENDING,SYSTEM_WIDE_GEN,PANHANDLE,COASTAL,SOUTH,WEST,NORTH,SYSTEM_WIDE_HSL,DSTFlag
```

### NP4-745-CD hourly solar geography

- report type: `21809`;
- Public API path: `/np4-745-cd/spp_hrly_actual_fcast_geo`;
- exact header count: 32;
- fingerprint:
  `6e18bdac7331a4b544205a9010601b130d92e5f5c5ac4e74e2cbd001de276954`.

```text
DELIVERY_DATE,HOUR_ENDING,SYSTEM_WIDE_GEN,COP_HSL_SYSTEM_WIDE,STPPF_SYSTEM_WIDE,PVGRPP_SYSTEM_WIDE,GEN_CenterWest,COP_HSL_CenterWest,STPPF_CenterWest,PVGRPP_CenterWest,GEN_NorthWest,COP_HSL_NorthWest,STPPF_NorthWest,PVGRPP_NorthWest,GEN_FarWest,COP_HSL_FarWest,STPPF_FarWest,PVGRPP_FarWest,GEN_FarEast,COP_HSL_FarEast,STPPF_FarEast,PVGRPP_FarEast,GEN_SouthEast,COP_HSL_SouthEast,STPPF_SouthEast,PVGRPP_SouthEast,GEN_CenterEast,COP_HSL_CenterEast,STPPF_CenterEast,PVGRPP_CenterEast,SYSTEM_WIDE_HSL,DSTFlag
```

### NP4-746-CD five-minute solar actual geography

- report type: `21810`;
- Public API path: `/np4-746-cd/spp_actual_5min_avg_values_geo`;
- exact header count: 10;
- fingerprint:
  `a875f73d7a15ec12568ddb990c8f55539eedef77630f9b89e020d67d163af2f3`.

```text
INTERVAL_ENDING,SYSTEM_WIDE_GEN,CenterWest_GEN,NorthWest_GEN,FarWest_GEN,FarEast_GEN,SouthEast_GEN,CenterEast_GEN,SYSTEM_WIDE_HSL,DSTFlag
```

The hourly date grammar is `MM/DD/YYYY`, hour ending is exactly two ASCII
digits `01` through `24`, and DST is `Y` or `N`. The observed five-minute wind
interval grammar is `MM/DD/YYYY HH:mm`; solar included seconds and an AM/PM
suffix. These product-specific raw grammars must not be collapsed into one
permissive parser. Every normalized target must pass the reviewed
America/Chicago DST and repeated-hour conversion, remain strictly increasing,
and be unique within a publication.

All measure cells are non-negative finite MW within a reviewed upper bound.
Hourly regional and system `GEN` plus `SYSTEM_WIDE_HSL` may be blank for future
targets. COP HSL, STWPF/STPPF, and WGRPP/PVGRPP remain required. Five-minute
actual measures are required. Any other blank, width drift, duplicate target,
invalid calendar value, unsafe ZIP entry, or multiple CSV payload is rejected.

The bounded 2026-08-18 check observed 216 hourly rows with 48 historical rows
and 168 future rows, and 12 five-minute rows. Those counts describe the checked
documents; they are not timeless parser equality requirements. Hard maximums
must remain bounded and tested.

## Renewable forecast truthfulness

ERCOT states that STWPF and STPPF attempt to predict HSL, which is uncurtailed
power-generation potential. Regional `GEN` is actual generation and can be
curtailed. Therefore:

- current generation is the region `GEN` field;
- current share is region `GEN / SYSTEM_WIDE_GEN` from the same target and
  product, only with a positive denominator;
- current change uses exact elapsed endpoints and never interpolates;
- forecast is the matching regional STWPF or STPPF;
- COP HSL and WGRPP/PVGRPP are separately named context;
- renewable forecast error is unavailable with stable reason
  `generation_is_curtailment_affected_forecast_targets_hsl`.

The UI and API must never rename forecast-minus-generation as error, accuracy,
bias, or performance. Missing error is not zero.

## Storage and canonical resources

Existing wide NP3-565 and NP6-345 rows are reused for load geography. PR13 must
not duplicate them into one row per zone.

Hourly renewable vintages preserve publication identity and wide rows. At the
observed cadence, 24 publications/day times 216 rows is 5,184
publication-target rows per product per day. A conservative 1 KiB/row planning
scenario is about 5.1 MiB/day, 152 MiB/30 days, 456 MiB/90 days, and 1.85
GiB/year per product before indexes. Publication retention beyond a reviewed
30–90 day window requires a measured SQLite benchmark; immutable derived tiles
may remain addressable longer.

When the deferred five-minute P1 is implemented, its overlapping documents
must be deduplicated by reviewed source target rather than storing every
repeated document row as independent history. The source has 288 five-minute
targets/day. Keep a wide target row and indexed time path, not a row per
measure.

The public current/manifest response is bounded and short-cacheable. Historical
resources use semantic, query-free, content-addressed daily URLs; full served
bytes determine the content version and ETag. Mutable freshness or evaluation
cutoffs live on manifest links, never under one immutable URL. Corrections mint
a new version while prior bytes remain addressable.

## Geography and interaction

No reviewed polygon asset exists in the repository. PR13 must render separate
schematics, never inferred Texas-region polygons. The visible heading is:

> ERCOT region schematic — not geographic boundaries

The three taxonomies use separate selectable controls. Every region is a native
button with a visible name, numeric value, and textual up/down/flat or
unavailable state. Selection uses `aria-pressed`; arrow-key roving focus plus
Enter/Space is supported; every target is at least 44 by 44 CSS pixels. Color
is supplementary only.

An exact table equivalent is always reachable and includes region, current MW,
same-source system share, exact one-hour change, forecast MW, error or stable
unavailability reason, observation time, issue time, and freshness. No critical
detail is hover-only.

On mobile, the schematic becomes a contained one- or two-column layout. The
table may scroll inside its own labeled wrapper, but the page must not overflow
horizontally. Selected detail remains visible after touch or keyboard selection.

## Lifecycle and request acceptance

The panel belongs in Generation and is collapsed by default. Acceptance
requires:

1. collapsed panel makes zero regional manifest or history requests;
2. opening makes one bounded manifest/current request;
3. only the selected region's history is requested;
4. overlap across summary, chart, and table reuses one canonical fetch;
5. switching or disabling aborts stale work and prevents late response commit;
6. loading, valid-empty, partial-region, stale, source failure, schema failure,
   and renewable-error-unavailable states are distinct;
7. stale last-good data remains visible only with explicit stale provenance;
8. URL state restores layer and region through reload and Back/Forward;
9. desktop Chromium and iPhone Pro Max WebKit prove keyboard/touch operation,
   minimum targets, table equivalence, and no horizontal overflow.

DST acceptance covers 23- and 25-hour load/hourly renewable days, both repeated
hours as distinct UTC targets, half-open daily history bounds, and exact elapsed
change endpoints. Source totals and region shares use the same product and
target; cross-taxonomy totals are never silently reconciled.
