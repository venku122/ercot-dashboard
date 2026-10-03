# PR 22 — External context: EIA / EPA / natural gas source acceptance

## Directive and truth policy

PR 22 maps original data-expansion PR 16. Its exact scope is:

- EIA-930 cross-check/national context;
- EPA emissions methodology/integration where credential permits;
- natural-gas context;
- optional credentials;
- an honest disabled state for unavailable credential-dependent features;
- no `DEMO_KEY` production credential; and
- no replacement of more authoritative or faster ERCOT operational feeds.

The public policy literal is
`external_context_not_ercot_operational_authority_or_live_emissions_measurement`.

EIA observations are delayed, preliminary external context. EPA eGRID factors
are retrospective annual regional averages. Neither may overwrite, backfill,
validate as correct, or silently substitute for an ERCOT operational series.
Coincident demand, interchange, fuel price, and emissions-factor observations
do not establish causality.

The smallest truthful implementation has three independent sections:

1. key-gated EIA-930 hourly ERCO demand and total interchange;
2. key-gated EIA Henry Hub daily spot price; and
3. credential-free EPA eGRID annual ERCT total-output emission rates.

EPA CAMD/CAMPD hourly emissions remain explicitly unavailable in this slice.
An API key alone does not solve the unreviewed ERCOT-footprint, unit coverage,
complex-unit apportionment, and missing/non-reporting-source methodology.

## Credential contract

`EIA_API_KEY` is optional. When absent, empty, whitespace-only, or exactly
`DEMO_KEY`, both EIA sections are disabled with reason
`eia_api_key_not_configured`. `DEMO_KEY` must never be sent from a production
collector. The EIA key appears only in the upstream query parameter required by
EIA; it must never enter logs, exception text, metrics, stored request URLs,
content hashes, provenance, ingest bodies, or public responses.

An eventual CAM API key is independently configured and independently gated.
Absence must not disable EIA or eGRID. A value equal to `DEMO_KEY` is rejected.
The public surface exposes only a source state and reason, never whether a
particular secret name or value was present.

Credential failure is not equivalent to an empty dataset. HTTP 401/403 becomes
`disabled` only when configuration validation already established that a key is
absent or forbidden. A rejected configured credential is `failed` with reason
`upstream_auth_rejected`, without retaining the response body or request URL.

## EIA API invariants

Official documentation and route metadata were rechecked on 2026-08-20:

- documentation: `https://www.eia.gov/opendata/documentation.php`;
- API origin: `https://api.eia.gov`;
- EIA requires a unique individual API key;
- API v2 returns data values as JSON strings;
- JSON responses are limited to 5,000 rows; and
- explicit sort, offset, length, date bounds, and facets are required here even
  when the API currently has a default order.

Only HTTPS redirects that remain on `api.eia.gov` are accepted. Response size
is limited to 2 MiB, JSON nesting to 16, strings to 1,024 UTF-8 bytes, and a
request to 30 seconds. Non-2xx, malformed JSON, a warning, an API error, a
non-decimal total, a total greater than the requested bound, an unexpected API
version major, unknown metadata, duplicate conflicting rows, or a unit mismatch
fails only that source.

The collector stores the keyless canonical route as provenance. Query order,
the secret-bearing effective URL, response headers containing request IDs, and
raw response bodies are not retained.

### EIA-930 hourly ERCO context

The exact route is:

`GET https://api.eia.gov/v2/electricity/rto/region-data/data/`

Every request fixes:

- `frequency=hourly`;
- `data[]=value`;
- `facets[respondent][]=ERCO`;
- `facets[type][]=D` and `facets[type][]=TI`;
- an explicit start and end;
- `sort[0][column]=period` and `sort[0][direction]=asc`;
- `offset=0`; and
- `length=200`.

The accepted response-level values are `frequency: "hourly"` and the route's
documented hourly date format. Each row has exactly the semantic fields
`period`, `respondent`, `respondent-name`, `type`, `type-name`, `value`, and
`value-units`; additional API envelope fields may be ignored, but an unknown row
field fails closed until reviewed. `respondent` is exactly `ERCO`.

The accepted type registry is:

| Type | Meaning                              | Unit            | Natural identity       |
| ---- | ------------------------------------ | --------------- | ---------------------- |
| `D`  | EIA-930 reported hourly demand       | `megawatthours` | (`ERCO`, `D`, period)  |
| `TI` | EIA-930 total net actual interchange | `megawatthours` | (`ERCO`, `TI`, period) |

These are one-hour energy observations, not instantaneous MW readings. The
source labels them by hour ending. The API's canonical hourly period is parsed
as UTC and materialized as half-open `[period - 1 hour, period)`. Local civil
time is display-only; no Chicago DST fold/gap logic is applied to this source.
The raw source `period` is retained alongside the two UTC bounds. A parser must
reject rather than guess if EIA route metadata ceases to identify the expected
hourly UTC basis.

Demand must be finite and nonnegative. Total interchange is finite and signed:
positive means net outflow/export and negative means net inflow/import under
EIA's interchange convention. The UI must show the sign legend. It must not
rename total net interchange as a particular DC tie, scheduled flow, or ERCOT
settlement value.

Poll hourly with a rolling 72-hour correction window. At two type rows per hour,
the maximum accepted response is 146 rows, allowing two boundary rows but not
silent pagination. Demand commonly arrives roughly an hour after hour ending;
other EIA-930 elements, including interchange, may lag one to two days. Freshness
is assessed independently by type against the latest interval end: 3 hours for
demand and 60 hours for interchange. A stale source remains `available` with
`freshness: "stale"`; it is not changed to an invented zero or an error.

EIA describes these submissions as preliminary and made available as-is. A
later different value at the same natural identity is a correction. The
collector retains the exact decimal source string and a finite parsed number;
canonical JSON uses the parsed number. Retrieval time orders corrections because
the row has no separately reviewed publication timestamp. Equal retrieval clocks
with different semantic bytes fail as a collision; older replay never regresses
current state.

### Henry Hub daily spot-price context

The exact series identity is `NG.RNGWHHD.D`, available through EIA API v2's
documented compatibility route:

`GET https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D`

The official human-readable cross-check is:

`https://www.eia.gov/dnav/ng/hist/rngwhhdd.htm`

Its exact title is `Henry Hub Natural Gas Spot Price (Dollars per Million Btu)`.
Futures series, prompt-month contracts, basis prices, delivered electric-sector
prices, and city-gate prices are not substitutes.

Accepted rows have a canonical `market_date` (`YYYY-MM-DD`), a finite price,
and exact unit `dollars per million Btu`. The public wire normalizes the unit to
`usd_per_mmbtu` while preserving the source unit in provenance. Price may be
negative; absence on a weekend or holiday is a gap, never zero or forward-fill.
The market date has no time of day or timezone and must not be converted to a
midnight UTC instant. Charts use a date axis. Joining it to hourly ERCOT data,
if a later UI chooses to do so, is display-window-only and may not interpolate,
forward-fill, or claim same-hour causality.

Poll daily and request/re-read at most the latest 35 calendar dates; accept at
most 25 observations. Freshness becomes stale after seven calendar days from
the greatest market date. Natural identity is (`NG.RNGWHHD.D`, `market_date`).
Corrections use the same retrieval-time rules as EIA-930.

The credential-free historical XLS at
`https://www.eia.gov/dnav/ng/hist_xls/RNGWHHDd.xls` is a review cross-check, not
the production collector contract. The HTML/XLS presentation layouts do not
replace the bounded, typed, key-gated JSON route.

## EPA eGRID annual methodology context

The stable discovery pages are:

- `https://www.epa.gov/egrid/summary-data`;
- `https://www.epa.gov/egrid/detailed-data`; and
- `https://www.epa.gov/egrid/known-issues-data-notes-and-revisions`.

The currently reviewed artifact is:

`https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx`

The discovery page, not the filename, decides the current release. It identifies
eGRID with 2023 data, initially released 2025-01-15, revision 1 released
2025-01-17, and revision 2 released 2025-06-12. `2023` is the data year, not the
publication year. A release date is a civil date only; no exact publication
instant may be invented.

The workbook is bounded to 2 MiB and exactly these ordered sheets:
`Contents`, `Table 1`, `Table 2`, `Table 3`, `Table 4`. This slice reads only
`Table 1`, titled `1. Subregion Output Emission Rates (eGRID2023)`. Header rows
2 through 4 must identify the total-output block in columns B:J:

- `eGRID subregion acronym`;
- `eGRID subregion name`;
- total-output `CO₂`, `CH₄`, `N₂O`, `CO₂e`, `Annual NOₓ`,
  `Ozone Season NOₓ`, and `SO₂`; and
- `lb/MWh` for that rate block.

Exactly one row must have acronym `ERCT` and name `ERCOT All`. Only its seven
total-output rate cells are retained. Non-baseload rates, grid gross loss,
resource mix, plant rows, balancing-authority rows, and live numeric workbook
rows are neither persisted as raw artifacts nor served.

The wire metric registry is ordered:

| Metric ID          | Exact source header | Unit     |
| ------------------ | ------------------- | -------- |
| `co2`              | `CO₂`               | `lb_mwh` |
| `ch4`              | `CH₄`               | `lb_mwh` |
| `n2o`              | `N₂O`               | `lb_mwh` |
| `co2e`             | `CO₂e`              | `lb_mwh` |
| `annual_nox`       | `Annual NOₓ`        | `lb_mwh` |
| `ozone_season_nox` | `Ozone Season NOₓ`  | `lb_mwh` |
| `so2`              | `SO₂`               | `lb_mwh` |

Values must be finite and nonnegative. They are source-published annual average
output emission rates. They are not current emissions, a marginal emissions
rate, a generator-specific rate, or proof of ERCOT-wide mass emissions. This
slice does not multiply them by current load or generation. In particular,
`CO₂e` is taken directly from the reviewed eGRID release and its methodology;
it is not recomputed with a locally chosen global-warming-potential vintage.

Natural identity is (`egrid`, `data_year`, `revision`, `ERCT`). Provenance has
the discovery URL, exact artifact URL, release dates, retrieval epoch, workbook
SHA-256, sheet/table identity, and the eGRID production-model/version strings if
present. Workbook bytes and the unfiltered table are discarded after strict
parsing.

Poll the discovery page weekly. A later revision for the same data year is a
correction and becomes current only by the discovery page's explicit revision
order/date, never by a lexicographic hash. An equal data-year/revision/release
identity with different bytes is a collision and fails closed. Retain the latest
five reviewed publications for ten years; the public manifest is current-only.
There is no DST transformation. Source age is shown as a data year and release
date, not as an operational freshness alarm.

EPA's revision notes are material: revisions have changed aggregated emission
rates and corrected aggregated headers. Therefore the UI must always display
data year and revision, and immutable resources must include the artifact hash.

## EPA CAMD/CAMPD deferral

EPA's official CAM API portal documents apportioned hourly, daily, monthly,
annual, and ozone-season emissions; a default limit of 1,000 requests/hour;
500 rows/page on pageable endpoints; and an api.data.gov API-key request.

The PR 22 section is nevertheless:

```json
{
  "state": "unavailable",
  "reason": "ercot_footprint_and_coverage_methodology_not_frozen"
}
```

This is not an empty zero-emissions series. CAMPD includes emissions reported
under covered federal programs and applies apportionment for complex unit
configurations; it is not, without additional reviewed joins and coverage
accounting, a complete ERCOT real-time emissions meter. A later PR must freeze
facility-to-ERCOT membership by interval, covered pollutants/units, operating
hour and DST semantics, revisions, missing reporters, complex configurations,
and aggregate coverage before enabling it. Possession of a valid key alone must
not change this state.

## Minimal public contract

A bounded queryless manifest should contain exactly:

```json
{
  "schema": 1,
  "kind": "external_context",
  "policy": "external_context_not_ercot_operational_authority_or_live_emissions_measurement",
  "generated_at": 0,
  "eia_930": {
    "state": "disabled",
    "reason": "eia_api_key_not_configured",
    "freshness": null,
    "selected": null
  },
  "natural_gas": {
    "state": "disabled",
    "reason": "eia_api_key_not_configured",
    "freshness": null,
    "selected": null
  },
  "epa_egrid": {
    "state": "available",
    "reason": null,
    "freshness": "not_applicable",
    "selected": {
      "content_version": "xc1-0000000000000000000000000000000000000000000000000000000000000000",
      "url": "/api/v2/external-context/epa_egrid/v1/xc1-0000000000000000000000000000000000000000000000000000000000000000",
      "data_year": 2023,
      "revision": 2,
      "released_on": "2025-06-12",
      "retrieved_at": 0,
      "subregion": "ERCT",
      "subregion_name": "ERCOT All",
      "source_page_url": "https://www.epa.gov/egrid/summary-data",
      "artifact_url": "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx"
    }
  },
  "epa_camd": {
    "state": "unavailable",
    "reason": "ercot_footprint_and_coverage_methodology_not_frozen"
  },
  "source_health": []
}
```

Numbers and dates above illustrate identities, not frozen live values. The
eGRID identity must come from the selected discovery page at collection time.

The other non-null selected shapes are exact:

- EIA-930: `content_version`, `url`, `retrieved_at`,
  `latest_demand_interval_end`, `latest_interchange_interval_end`, and
  `source_url`;
- Henry Hub: `content_version`, `url`, `retrieved_at`, `latest_market_date`,
  and `source_url`; and
- eGRID: the keys shown above.

All selected timestamps are integer Unix seconds except Henry Hub's canonical
date and eGRID's civil release date. A selected URL is a queryless same-origin
path. `content_version` is `xc1-` plus 64 lowercase hexadecimal digits, and the
same literal terminates its URL. `source_url` is the keyless official EIA route,
never the effective secret-bearing request URL.

Section states are `available`, `disabled`, `unavailable`, or `failed`.
`disabled` is reserved for optional credential configuration. `unavailable` is
a known contract/methodology deferral. `failed` means an enabled source attempt
failed. A successful source may be `available` with `freshness` equal to
`fresh`, `stale`, or `not_applicable`. One source's state cannot suppress or
regress another section.

The manifest embeds no observation or rate rows. Its three immutable resource
families are exactly:

- `/api/v2/external-context/eia930_demand/v1/{content_version}`;
- `/api/v2/external-context/henry_hub_daily/v1/{content_version}`; and
- `/api/v2/external-context/epa_egrid/v1/{content_version}`.

`eia930_demand` is the stable stream identity but contains both accepted
EIA-930 `D` and `TI` rows; the UI must not infer demand-only contents from the
legacy stream name.

Every immutable resource has exact leading keys `schema: 1`,
`kind: "external_context_resource"`, the same `policy`, and its exact `stream`.
The remaining exact shapes are:

```text
eia930_demand:
  publication {retrieved_at,source_url}
  interval_basis "hour_ending_utc_half_open"
  rows [{period,interval_start,interval_end,type,type_name,value_decimal,value_mwh}]

henry_hub_daily:
  publication {retrieved_at,series_id,source_url,source_page_url,source_unit}
  unit "usd_per_mmbtu"
  date_basis "source_market_date_no_timezone"
  rows [{market_date,value_decimal,price}]

epa_egrid:
  publication {data_year,revision,released_on,retrieved_at,source_page_url,
               artifact_url,workbook_sha256,table_title,production_model,
               production_version}
  subregion "ERCT"
  subregion_name "ERCOT All"
  rates [{metric_id,source_header,value,unit}]
```

EIA-930 `type` is exactly `D` or `TI`; `period` is the raw canonical source
period; the interval fields are integer Unix seconds with
`interval_end - interval_start == 3600`; and `value_decimal` is a strict finite
source decimal string. `value_mwh` is finite, demand is nonnegative, and TI is
signed. Henry Hub `price` is finite and signed. eGRID `workbook_sha256` is
`sha256:` plus 64 lowercase hexadecimal digits, and the seven rates use the
ordered registry above.

EIA-930 resources are bounded to 14 display days and 2 × 24 × 14 = 672 rows.
Henry Hub is bounded to 400 dated observations. eGRID has exactly seven rate
rows. Resources contain no credentials, raw upstream bodies, effective
secret-bearing URLs, or derived live emissions.

`source_health` has exactly three rows ordered `eia930_erco`,
`eia_henry_hub`, `epa_egrid_erct`. Each has the PR 21 health keys:
`source_id`, `state`, `availability_status`, `content_version`,
`last_attempt_ts`, `last_success_ts`, `source_updated_at`, `retrieved_at`,
`cache_fresh_until`, `consecutive_failures`, `last_error`, and
`materialization`. State is `healthy`, `stale`, `failed`, `disabled`, or
`unavailable`; availability is `available`, `disabled`, or `unavailable`.
`source_updated_at` is nullable and must not be synthesized from an eGRID civil
release date. Disabled EIA health has null clocks/version, zero failures, and
unavailable materialization.

Immutable resources use a strong ETag equal to the quoted content version,
support 304, and advertise `public, max-age=31536000, immutable`. An advertised
URL remains retrievable for at least 365 days even after correction or
deselection. The manifest has its own strong ETag, revalidation semantics,
singleflight, and generation invalidation. An identical semantic replay does not
mint a new resource merely because a later retrieval was attempted.

## Deterministic acceptance goldens

1. Missing, blank, whitespace, and `DEMO_KEY` EIA credentials perform no EIA
   request and produce independent disabled EIA-930 and natural-gas sections.
2. A real configured key is present only in the outbound EIA query. A recorded
   log, exception, stored URL, hash input, ingest body, and public response are
   proven not to contain it.
3. The EIA-930 parser accepts sanitized `ERCO` `D` and `TI` rows with exact
   hourly metadata and units; it rejects `MW`, unknown types, other respondents,
   NaN/infinity, negative demand, duplicate conflicts, warnings, and more than
   146 correction-window rows.
4. Hour-ending rows become exact one-hour UTC intervals. A DST transition does
   not duplicate, omit, or relabel a UTC interval.
5. Positive TI renders as export/outflow and negative TI as import/inflow; the
   labels reverse neither sign nor source perspective.
6. A later retrieval may correct the same EIA natural identity; identical replay
   is idempotent, older replay cannot regress current, and equal-clock different
   semantics fail as a collision.
7. Henry Hub accepts a sanitized weekday date and exact unit, preserves a
   negative finite price, and leaves weekend/holiday dates absent. It creates no
   midnight timestamp and performs no fill/interpolation.
8. eGRID accepts only the exact five-sheet registry, Table 1 header geometry,
   single `ERCT`/`ERCOT All` row, seven finite nonnegative total-output rates,
   explicit data year/revision/release identity, and a matching SHA-256.
9. eGRID rejects a renamed/reordered sheet, changed header, duplicate/missing
   ERCT row, non-baseload substitution, missing metric, bad unit, nonfinite or
   negative rate, oversized workbook, and equal-identity different bytes.
10. A newer explicit eGRID revision supersedes the prior revision; a changed
    hash alone never establishes ordering. Revision metadata remains visible.
11. EIA failure does not hide eGRID; eGRID failure does not hide cached EIA;
    Henry Hub and EIA-930 health change independently even though they use the
    same credential.
12. A configured CAM key does not enable hourly EPA emissions while the
    methodology blocker remains. No UI path calls the deferred section zero.
13. No external section is used as a fallback for an absent or stale ERCOT
    operational observation, and no same-window display makes a causal claim.

## Source sufficiency conclusion

EIA-930 ERCO demand/interchange and Henry Hub spot price are source-sufficient
only behind a real individual EIA API key. eGRID ERCT annual total-output rates
are source-sufficient without credentials when bound to the exact discovery
release, revision, table, row, units, and hash above. CAMD hourly integration is
not source-contract-sufficient for an ERCOT aggregate in PR 22. The degraded
no-key product is therefore honest and still useful: annual eGRID methodology
context is available, both EIA sections say disabled, and CAMD says unavailable.
