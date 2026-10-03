# PR 21 — Texas Grid long-horizon source acceptance

## Truth policy

The public policy literal is
`official_planning_snapshots_not_committed_capacity_or_realization_forecast`.

This slice presents official planning-report snapshots. A project in an
interconnection study, an executed interconnection agreement, posted financial
security, a projected commercial-operation date, or a forecast is not a
commitment that capacity or load will be realized. The UI must not describe a
net capacity change as gross additions or retirements.

The smallest accepted implementation contains two independent monthly sources:

- Generator Interconnection Status (GIS), aggregated by official study phase
  and fuel; and
- Resource Capacity Trend, retaining the source's operational, planned, and
  small-generator distinctions.

Long-term load forecast, large-load status, and retirements remain explicit
unavailable sections in this slice. No project row, project name, INR, POI,
county, entity, live document identifier, or other row-level identifier may be
stored or served.

## Official sources

The evidence below was rechecked against credential-free official ERCOT pages
and workbooks on 2026-08-20. Current filenames are evidence fixtures, not a
permanent discovery mechanism.

### Generator Interconnection Status

- Product page:
  `https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er`
- EMIL ID: `pg7-200-er`
- Report Type ID: `15933`
- Audience/classification: Public/Public
- Frequency/file type: Chron - Monthly/XLSX
- First run: 2017-02-01
- Retention metadata: N/A; display duration 2555
- Credential-free listing:
  `https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId=15933`
- Ephemeral download template:
  `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={DocID}`

The collector selects a listing `Document` only when `ReportTypeID` is 15933,
`Extension` is `xlsx`, and `FriendlyName` matches `^GIS_Report_`. The source
month token may be an exact English full month or its three-letter abbreviation;
official history includes both `June` and `Jun`. Unknown tokens fail closed. It
selects the greatest `PublishDate`. A document identifier may be held in memory
just long enough to download that workbook. It must not be logged, persisted,
included in provenance, or returned by an API.

The workbook sheet names are exact and ordered:

1. `Contents`
2. `Disclaimer and References`
3. `Acronyms`
4. `Summary`
5. `Project Details - Large Gen`
6. `Project Details - Small Gen`
7. `GIM Trends`
8. `data_GIM Trends_1`
9. `data_GIM Trends_2`
10. `data_GIM Trends_3`
11. `data_GIM Trends_4`
12. `Commissioning Update`
13. `Inactive Projects`
14. `Cancellation Update`

`Project Details - Large Gen` has its primary header on row 31 and source
subheaders on row 32. The semantic columns, in order, are:

`INR`, `Project Name`, `GIM Study Phase`, `Interconnecting Entity`,
`POI Location`, `County`, `CDR Reporting Zone`, `Projected COD`, `Fuel`,
`Technology`, `Capacity (MW)`, `Screening Study Started`,
`Screening Study Complete`, `FIS Requested`, `FIS Approved`,
`Economic Study Required`, `IA Signed`, `Air Permit`, `GHG Permit`,
`Water Availability`, `Meets Planning`, `Meets All Planning`,
`Construction Start`, `Construction End`, `Approved for Energization`,
`Approved for Synchronization`, `Comment`.

`Project Details - Small Gen` has its header on row 15. Its semantic columns
are `INR`, `Project Name`, `Model Ready Date`, `Interconnecting Entity`,
`POI Location`, `County`, `CDR Reporting Zone`, `Projected COD`, `Fuel`,
`Technology`, `Capacity (MW)`, `Change indicators: Proj Name, MW`, `IA Signed`,
`Financial Security`, `Approved for Energization`,
`Approved for Synchronization`, `Comment`.

The canonical ordered phase registry follows `Summary` columns G:P, followed
by one collapsed small-generator category:

| ID                                   | Exact source label                     |
| ------------------------------------ | -------------------------------------- |
| `ss_started_fis_not_started_no_ia`   | `SS Started, FIS Not Started, No IA`   |
| `ss_started_fis_started_no_ia`       | `SS Started, FIS Started, No IA`       |
| `ss_completed_fis_not_started_no_ia` | `SS Completed, FIS Not Started, No IA` |
| `ss_completed_fis_started_no_ia`     | `SS Completed, FIS Started, No IA`     |
| `ss_completed_fis_completed_no_ia`   | `SS Completed, FIS Completed, No IA`   |
| `ss_started_fis_not_started_ia`      | `SS Started, FIS Not Started, IA`      |
| `ss_started_fis_started_ia`          | `SS Started, FIS Started, IA`          |
| `ss_completed_fis_not_started_ia`    | `SS Completed, FIS Not Started, IA`    |
| `ss_completed_fis_started_ia`        | `SS Completed, FIS Started, IA`        |
| `ss_completed_fis_completed_ia`      | `SS Completed, FIS Completed, IA`      |
| `small_generator`                    | `Small Generator`                      |

The final category combines the source's `Small Generator / Not Model Ready`
and `Small Generator / Model Ready` columns. It must not be described as a
large-generator study phase.

The canonical ordered fuel registry comes from the workbook's `Acronyms`
sheet, including valid categories with no current detail rows:

| Code  | Wire ID      | Exact source meaning |
| ----- | ------------ | -------------------- |
| `BIO` | `biomass`    | Biomass              |
| `COA` | `coal`       | Coal                 |
| `GAS` | `gas`        | Gas                  |
| `GEO` | `geothermal` | Geothermal           |
| `HYD` | `hydrogen`   | Hydrogen             |
| `NUC` | `nuclear`    | Nuclear              |
| `OIL` | `fuel_oil`   | Fuel Oil             |
| `OTH` | `other`      | Other                |
| `PET` | `petcoke`    | Petcoke              |
| `SOL` | `solar`      | Solar                |
| `WAT` | `water`      | Water                |
| `WIN` | `wind`       | Wind                 |

For each phase/fuel pair, `count` is a project-row count and `capacity_mw` is
the finite signed sum of the exact `Capacity (MW)` column. The source disclaimer
permits negative capacity for a repowering project's net capacity change, so a
source row and even a phase/fuel aggregate may be negative. The result is a
source capacity sum including repowering adjustments, not installed or
committed capacity and not evidence of a retirement. The collector must fail
closed on an unknown phase/fuel or malformed capacity and must discard all
source rows after producing at most 11 × 12 = 132 aggregate rows.

### Resource Capacity Trend

The stable discovery page is `https://www.ercot.com/gridinfo/resource`. ERCOT
describes these as charts and data showing annual and monthly resource-capacity
changes by fuel, incorporating historical additions and planned projects being
studied in the interconnection-request process.

The two exact current evidence URLs are:

- `https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026.xlsx`
- `https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026_PlannedMonthly.xlsx`

Future discovery accepts only a same-publication pair linked by the official
page and matching the exact annual and `_PlannedMonthly` filename families.
The source period is the month named by the pair; the publication instant is
the official page's posting date. URL path dates are not separately interpreted
as source periods.

Both workbooks have exactly these five sheets and exact project-table headers:

| Series ID            | Sheet                      |
| -------------------- | -------------------------- |
| `wind`               | `Wind Chart`               |
| `solar`              | `Solar Chart`              |
| `battery`            | `Battery Chart`            |
| `gas_combined_cycle` | `Gas-Combined Cycle Chart` |
| `gas_other`          | `Gas-Other Chart`          |

Project-table header: `INR`, `Project Name`, `County`, `Projected COD`,
`IA Signed`, `Fuel`, `Technology`, `Capacity (MW)`, `Year`,
`Financial Security`. These project rows are never retained or exposed.

The annual aggregate table begins with `Year`; the planned-monthly table begins
with `Month/Year`. Their canonical category mapping is:

| Wire key                          | Exact source header                            | Meaning                                                        |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `official_total_mw`               | `Cumulative Operational, No FS, and FS Posted` | official total of every component column present in that table |
| `operational_mw`                  | `Cumulative MW Operational`                    | operational capacity                                           |
| `ia_financial_security_posted_mw` | `IA Signed-Financial Security Posted`          | planned with IA and posted security                            |
| `ia_no_financial_security_mw`     | `IA Signed-No Financial Security`              | planned with IA and no posted security                         |
| `other_planned_mw`                | `Other Planned`                                | other source-defined planned capacity                          |
| `small_generator_mw`              | `Small Generator`                              | source-defined small-generator capacity                        |

Capitalization and trailing whitespace in the two workbooks may differ only as
observed above and must be normalized to these keys. Despite its narrower
header text, live annual workbook formulas show that column B includes every
component column present in that table, including `Other Planned` and
`Small Generator`. It is therefore named `official_total_mw`. It must equal the
sum of every present component column C:G within `1e-6 MW`, treating an absent
column as zero only for this invariant. It is not an additive category and must
never be stacked or summed with its components.

All values use MW. A column absent from a particular source table becomes
`null`, never zero. In the current planned-monthly workbook, `Other Planned` is
absent from four sheets and present on `Gas-Other Chart`. Annual periods become
integer years. Planned periods become canonical `YYYY-MM`; their source cell's
day has no meaning. Neither dataset has a DST or civil-time transformation.

## Long-term load forecast and deferred sources

### Long-term load forecast

The official page links the 2025 monthly peak-demand and energy workbook and
methodology report. The workbook contains exactly 240 monthly rows for each of
`ERCOT Adjusted Forecast` and `TSP Provided Forecast`. Appendix A of the report
defines peak demand in MW and annual energy in TWh. The reviewed contract binds
workbook monthly peaks as MW and monthly energy as MWh only after annual sums of
the adjusted monthly values reproduce the report's rounded 2025--2031 TWh
figures. This cross-document check is frozen as
`official_report_appendix_a_mw_twh_monthly_sum_v1`; no unit is guessed.

The selected content-versioned resource preserves both scenarios, the exact
workbook/report hashes and URLs, calendar-month time basis, and the methodology
statements used for large-load forecast assumptions.

### Large load and retirements

No stable public machine-readable source was verified for project-level
large-load category/status progression. Forecast populations such as
TSP-provided, ERCOT-adjusted, Contract, and Officer Letter are not equivalent
to queue, energized, or operational statuses.

GIS inactive/cancellation rows are not generator retirements. Commissioning
approvals are milestones. Net operational-capacity changes cannot establish
gross additions and retirements. These sections remain:

- `large_load`: forecast methodology context may be available, but individual
  project status remains `no_stable_public_machine_readable_status_source`
- `retirements`: `no_verified_gross_retirement_source`

## Publication and correction identity

Every publication carries a canonical `source_period` (`YYYY-MM`), integer
`published_at`, integer `retrieved_at`, stable `source_page_url`, and SHA-256 of
each exact workbook byte stream. GIS provenance exposes the stable product page,
not its ephemeral download URL. Resource Capacity Trend provenance may expose
its two official `https://www.ercot.com/files/docs/...xlsx` URLs.

`published_at <= retrieved_at`. Current selection is monotonic only by
`(published_at, retrieved_at)`; a content hash never decides source truth. A
later publication for the same source month is a correction. The same
`published_at` with a later `retrieved_at` may also carry a correction. Equal
publication and retrieval clocks with identical semantic bytes are an
idempotent replay; equal clocks with different semantic bytes are a collision
and fail closed with HTTP 400. Older replay must never regress a current
pointer.

`content_version` is `tg1-` plus the lowercase SHA-256 of canonical immutable
resource JSON. Source hashes use `sha256:` plus 64 lowercase hex digits. No
locale, timezone, current clock, database sequence, or document identifier may
affect resource bytes.

## Public wire contract

Both write routes require the receiver API key. A successful publication uses
`POST /api/texas-grid/ingest`. A collector fetch or parse failure has no
publication body and uses `POST /api/texas-grid/source-attempt` with exactly:

```json
{
  "schema": 1,
  "stream": "gis",
  "status": "failed",
  "attempted_at": 0,
  "error": "official_source_fetch_or_parse_failed"
}
```

`stream` is `gis`, `resource_capacity_trend`, or `long_term_load_forecast`;
`attempted_at` is an integer no
more than 300 seconds in the future. The response is exactly
`{schema:1,stream,status}` where status is `recorded`, `unchanged`, or
`ignored_older`. An attempt newer than the last attempt/success is recorded; an
equal attempt is unchanged; an older attempt is ignored. Thus a delayed failure
cannot regress or double-count after recovery. A recorded failure updates and
invalidates only that source's health. It does not clear its last good selected
resource, change the peer source, or fabricate publication clocks. A later
successful ingest for that stream resets its failure counter and error.

### Resolver

`GET /api/v1/texas-grid` is queryless and returns fixed top-level keys:

```json
{
  "schema": 1,
  "kind": "texas_grid_long_horizon",
  "policy": "official_planning_snapshots_not_committed_capacity_or_realization_forecast",
  "generated_at": 0,
  "generator_interconnection": { "state": "unavailable", "selected": null },
  "resource_capacity_trend": { "state": "unavailable", "selected": null },
  "long_term_load_forecast": { "state": "unavailable", "selected": null },
  "large_load": {
    "state": "unavailable",
    "scope": "forecast_methodology_not_project_status",
    "reason": "no_stable_public_machine_readable_status_source"
  },
  "retirements": {
    "state": "unavailable",
    "reason": "no_verified_gross_retirement_source"
  },
  "source_health": []
}
```

Source-backed section states are `available`, `stale`, `unavailable`, or
`failed`. `selected` is non-null for `available` and `stale`, and null for
`unavailable` and `failed`. A selected object has exactly
`source_period`, `published_at`, `retrieved_at`, `content_version`, `url`, and
`source_page_url`. URLs are queryless, same-origin immutable resource paths:

`/api/v2/texas-grid/{gis|resource_capacity_trend|long_term_load_forecast}/v1/{tg1-64hex}`.

### GIS immutable resource

Its exact top-level keys are `schema`, `kind`, `policy`, `stream`,
`publication`, `unit`, `statistic`, `phases`, `fuels`, `aggregates`, and
`limits`. Literals are `stream:"gis"`, `unit:"MW"`, and
`statistic:"project_count_and_source_capacity_sum"`.

`publication` has exactly `source_period`, `published_at`, `retrieved_at`,
`source_page_url`, and `workbook_sha256`. `phases` contains ordered `{id,label}`
rows; `fuels` contains ordered `{code,label}` rows. Aggregates are sorted by
registry order and contain exactly `{phase,fuel,count,capacity_mw}`. Their
`fuel` field uses the canonical wire ID in the table above, not the source code.
Count is an integer from 0 through 10,000; capacity is finite and its absolute
value is at most 10,000,000 MW.
`limits` is `{max_aggregates:132}`.

### Resource Capacity Trend immutable resource

Its exact top-level keys are `schema`, `kind`, `policy`, `stream`,
`publication`, `unit`, `series`, and `limits`. Literals are
`stream:"resource_capacity_trend"` and `unit:"MW"`.

`publication` has exactly `source_period`, `published_at`, `retrieved_at`,
`source_page_url`, `annual_workbook_url`, `annual_workbook_sha256`,
`planned_monthly_workbook_url`, and `planned_monthly_workbook_sha256`.

`series` contains exactly five `{series_id,label,annual,planned_monthly}` rows in
the sheet order above. Annual rows are ascending, unique, and have exactly:

`year`, `official_total_mw`, `operational_mw`,
`ia_financial_security_posted_mw`, `ia_no_financial_security_mw`,
`other_planned_mw`, `small_generator_mw`.

Planned-monthly rows replace `year` with canonical `month`. Years are integers
from 1900 through 2200. MW values are finite and between 0 and 10,000,000;
only `other_planned_mw` may be null, and only when that source column is absent.
`limits` is
`{max_annual_rows_per_series:100,max_planned_monthly_rows_per_series:120}`.

### Health

`source_health` has exactly two rows in order: `ercot_gis_report`, then
`ercot_resource_capacity_trend`. Each row has exactly:

`source_id`, `state`, `availability_status`, `content_version`,
`last_attempt_ts`, `last_success_ts`, `source_updated_at`, `retrieved_at`,
`cache_fresh_until`, `consecutive_failures`, `last_error`, and
`materialization`.

Health state is `healthy`, `stale`, `failed`, or `unavailable`.
`availability_status` is null, `available`, or `unavailable`. Timestamp and
version fields are nullable until a source succeeds. `consecutive_failures` is
a non-negative integer and `last_error` is a nullable bounded string.
`materialization` has exactly `state`, `last_success_ts`,
`consecutive_failures`, and `last_error`; its state is `healthy`, `failed`, or
`unavailable`.

## Bounds, retention, and caching

- GIS workbook: at most 8 MiB and 10,000 detail rows per detail sheet.
- Trend workbook: at most 2 MiB each; exactly five sheets; at most 10,000
  project rows per sheet before discard.
- Public GIS aggregates: at most 132 rows.
- Public trend: exactly five series, at most 100 annual and 120 planned-monthly
  rows per series.
- Keep 120 publication months and at most four corrections per source month,
  but never remove any immutable version less than 365 days after retirement.
- Resolver: strong ETag, `public, max-age=0, s-maxage=15, must-revalidate`.
- Immutable resource: strong ETag and
  `public, max-age=31536000, immutable`; retained bytes must remain available
  for at least that advertised lifetime.
- Ingest invalidates the resolver generation only after a successful atomic
  commit. Singleflight results use a generation guard so an older computation
  cannot repopulate cache after a correction.

## Deterministic acceptance goldens

1. Reject an unknown sheet, changed header, unknown phase/fuel, NaN/infinite or
   out-of-bound MW, oversized workbook, row overflow, and non-XLSX content.
2. Accept all ten official large-generator phase labels even when a current
   workbook has no occupied row for some labels.
3. Collapse both official small-generator model-readiness columns only into
   `small_generator`; do not relabel it as a GIM study phase.
4. Aggregate a sanitized fixture containing a negative repowering adjustment
   to exact signed count and MW without retaining any input identity or
   geography field; visibly describe the result as a source capacity sum.
5. Preserve `official_total_mw`, validate it against every present component
   column C:G within `1e-6 MW`, and prove a stack helper excludes that total.
6. Treat an absent `Other Planned` column as null and a present numeric zero as
   zero.
7. Normalize planned source dates to `YYYY-MM` without timezone or DST shifts;
   reject duplicate/non-ascending periods.
8. Reverse-order replay cannot regress current. Same-period corrected bytes
   with a later publication or retrieval clock produce a new content version
   while the old immutable bytes remain stable. Equal clocks with different
   semantic bytes fail closed as a collision.
9. Resolver MISS → HIT, strong ETag → 304, ingest generation invalidation, and
   stale singleflight generation rejection are deterministic.
10. A resource retired today remains fetchable throughout its one-year cache
    lifetime even if it exceeds the normal correction-count limit.
11. Empty state returns selected null and the three deferred sections retain
    their exact unavailable reasons; no unavailable value is rendered as zero.
12. Assert no response, database row, log fixture, or content-version input
    contains a source project row, INR, project name, POI, county, entity, or
    live GIS document identifier.
13. After both streams succeed, make the collector GIS fetch/parser reject
    before it has a publication body. It reports only a GIS source attempt;
    Resource Capacity Trend still ingests, GIS retains its last good selection
    with failed health, and the next successful GIS collection resets health.
14. Deliver equal and older failed source attempts after recovery; they return
    `unchanged` and `ignored_older` and do not regress health or increment its
    failure count.
