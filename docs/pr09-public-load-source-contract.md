# PR 09 public load source contract

This document records the verified collector boundary for NP3-565-CD,
NP3-763-CD, and NP6-345-CD actual weather-zone load as of 2026-08-18. The
checked-in fixtures contain exact live field names, order, declared data types,
and sanitized envelope metadata; their numeric values are synthetic. They
contain no credentials, headers, tokens, or retained live response rows.

This subtask made no live credential read or API request. A separate authorized
bounded probe supplied the schema facts recorded below.

## Authority and remaining limits

The checked-in
[`ercot-public-api-catalog-2026-08-18.json`](./ercot-public-api-catalog-2026-08-18.json)
remains authoritative for live product membership and exact artifact hrefs. It
records 111 active products, 240 artifacts, verification date 2026-08-18, and
official OpenAPI blob `e2b649f1e8e42b6d6d5f62e868eb11799a589cdf`.

The follow-up bounded probe verified the response field definitions and
positional array widths below. Raw date, datetime, hour-ending, and
repeated-hour flags are retained alongside the UTC interval end calculated by
the explicit America/Chicago market-day converter. The wide publication
builder never emits generic metrics.

The reviewed unit mapping is MW. ERCOT's [System-Wide Demand
page](https://www.ercot.com/gridmktinfo/dashboards/systemwidedemand) identifies
NP3-565-CD and NP6-345-CD as similar actual/forecast load sources while warning
that they may not match the dashboard one-for-one; the dashboard labels demand
in MW. ERCOT's [Short-Term System Adequacy
help](https://www.ercot.com/files/docs/2021/06/10/STAR_help_description_20251205.docx)
defines the capacity fields and formulas as resource/load capacity. The mapping
is explicit provenance, not a parity claim.

The generic `ErcotApiClient.publicArtifact<T>()` protects the exact
inventory-advertised href but does not validate response rows. PR 09 adds a
separate strict parser in `ercot_public_load_sources.ts` for these three exact
contracts.

## Exact sources and observed result sizes

| Source ID                                       | Product    | Exact live artifact href                                                       | Width | Probe total at `size=1` |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------------------------ | ----: | ----------------------: |
| `ercot_public_np3_565_weather_zone_forecast`    | NP3-565-CD | `https://api.ercot.com/api/public-reports/np3-565-cd/lf_by_model_weather_zone` |    15 |                  33,600 |
| `ercot_public_np3_763_system_adequacy`          | NP3-763-CD | `https://api.ercot.com/api/public-reports/np3-763-cd/st_sys_adequacy`          |    29 |               1,032,697 |
| `ercot_public_np6_345_weather_zone_actual_load` | NP6-345-CD | `https://api.ercot.com/api/public-reports/np6-345-cd/act_sys_load_by_wzn`      |    12 |                      24 |

Those totals describe the reviewed probe responses, not rows per day or a
retention estimate. A single sampled first page is intentionally rejected as an
incomplete collection.

Every receiver publication retains `source_id`, exact `product_id`, exact
artifact href, query window, retrieval time, parser schema version, schema
fingerprint, raw posted datetime when present, and `declared_unit: MW`.

## NP3-565-CD model and weather-zone forecast

The exact ordered field contract is:

```text
postedDatetime DATETIME; deliveryDate DATE; hourEnding VARCHAR;
coast DOUBLE; east DOUBLE; farWest DOUBLE; north DOUBLE;
northCentral DOUBLE; southCentral DOUBLE; southern DOUBLE; west DOUBLE;
systemTotal DOUBLE; model VARCHAR; inUseFlag BOOLEAN; DSTFlag BOOLEAN
```

Verified request controls are `deliveryDateFrom`, `deliveryDateTo`,
`postedDatetimeFrom`, `postedDatetimeTo`, `hourEnding`, `model`, `inUseFlag`,
`DSTFlag`, `page`, `size`, `sort`, and `dir`. Numeric range filters from the
larger catalog are not ingestion boundaries.

The parser retains every model and both `inUseFlag` states. It does not silently
select A3, select only in-use rows, collapse vintages, or rewrite a forecast as
the current dashboard system forecast. The receiver child identity is
publication + target + model; `inUseFlag` remains an attribute.

A bounded fall-transition query for delivery date 2025-11-02 found both
`2:00|false` and `2:00|true`; `true` identifies the repeated second HE2 for this
product. The query reported 1,225 records across multiple pages, so tests reject
the sampled first page and preserve both repeated-hour rows.

## NP3-763-CD short-term system adequacy

The exact ordered field contract contains `postedDatetime DATETIME`,
`deliveryDate DATE`, `hourEnding DOUBLE`, the 25 capacity measures listed in the
fixture and parser constant, and `repeatHourFlag BOOLEAN`.

ERCOT metadata declares `hourEnding` as `DOUBLE`, making 26 fields declared
DOUBLE, but the verified live row value was the string `"01:00"`. The schema
fingerprint preserves `DOUBLE`; the row parser contains one narrow exception
for this exact product and field, accepts reviewed `HH:MM` text, and preserves
it. It does not accept arbitrary text or invent a thirtieth field.

The verified bounded filters are `postedDatetimeFrom`, `postedDatetimeTo`,
`deliveryDateFrom`, `deliveryDateTo`, `hourEndingFrom`, and `hourEndingTo`;
`page` and `size` are also accepted. A deliberately narrow pre-activation
window returned a schema-valid empty response. The sanitized fixture preserves
the actual `_meta.query` nesting with `parameterCount`, `parameters`, and
`sortedBy` rather than flattening the echoed filters.

These wide source values are declared MW but are not remapped to the existing
available capacity, committed capacity, reserve margin, or another dashboard
metric. Live history did not establish both repeated-hour rows for this
product, so the 565/345 live flag conclusion is not claimed for
`repeatHourFlag`; the converter follows the documented repeated-hour
convention.

## NP6-345-CD actual weather-zone load

The exact ordered field contract is:

```text
operatingDay DATE; hourEnding VARCHAR; coast DOUBLE; east DOUBLE;
farWest DOUBLE; north DOUBLE; northC DOUBLE; southern DOUBLE;
southC DOUBLE; west DOUBLE; total DOUBLE; DSTFlag BOOLEAN
```

Verified request controls are `operatingDayFrom`, `operatingDayTo`,
`hourEnding`, `DSTFlag`, `page`, `size`, `sort`, and `dir`. Numeric range
filters are not ingestion boundaries.

A fall-transition query for operating day 2025-11-02 returned 25 rows and both
`02:00|false` and `02:00|true`; `true` identifies the repeated second HE2. The
`total` field may later support parity comparison with current demand, but
similar labels do not prove equivalence or authorize replacement.

Rows have no posted timestamp and the sanitized inventory's last-post timestamp
is null. The collector therefore sends `publication_key_kind: content_hash`,
omits a caller publication key and issued/published time, and lets the receiver
derive snapshot identity from canonical metadata and rows. It does not invent a
posting identity from operating day.

## Deterministic collector and receiver contract

`ercot_public_load_sources.ts` enforces exact ordered field names and declared
types, exact positional width, finite numbers, booleans, reviewed raw time
grammar, consistent metadata, and complete ordered page sets. Unknown,
reordered, missing, mistyped, or extra source fields fail closed.

The schema fingerprint is lowercase SHA-256 hex over UTF-8 compact JSON of the
ordered `[name,dataType]` pairs, with no whitespace. Frozen values are:

| Product    | Schema fingerprint                                                 |
| ---------- | ------------------------------------------------------------------ |
| NP3-565-CD | `b5969c5ca165d78a4db53d2e549ee557bf2dc527251ca843fcd1a8ecb273c12e` |
| NP3-763-CD | `7ab50540a9d1e25999ada90fab00de34c75f0a8e3eeb2fdb1877f9d9d1ddfafc` |
| NP6-345-CD | `7102e5159262c2f02f1b5c049e3d0e7fa977785ee8461b9c5c9fcf783559e4c3` |

Forecast publications use
`publication_key_kind: official_posted_datetime` and a `publication_key`
exactly equal to the one raw `postedDatetime` in the payload. Forecast
`issued_at` is derived internally by resolving the raw posted time in
America/Chicago and raw text is always retained. Nonexistent spring times and
ambiguous fall `01:xx` times are rejected unless a future authoritative
fold/offset contract disambiguates them. NP6-345 uses the receiver-derived
content snapshot identity described above. The caller never sends
`vintage_key`; the receiver derives it.

Each row contains every exact source field plus receiver-normalized `target_ts`
and no other keys. `target_ts` is interval end. The converter derives local-day
and next-day America/Chicago midnight boundaries and validates the 23/24/25-hour
market sequence:

- normal: HE1 through HE24, repeated flag false;
- spring: HE1, then HE3 through HE24; HE2 is invalid;
- fall: HE1, HE2 false, HE2 true, then HE3 through HE24;
- HE24 always equals next local midnight.

Golden tests freeze normal, 2026-03-08 spring, 2025-11-02 fall, HE24, invalid
hour/flag combinations, exact current posted-time epochs, and ambiguous or
nonexistent posted-time rejection. Fall interval ends are 06:00Z, 07:00Z,
08:00Z, and 09:00Z for HE1, first HE2, repeated HE2, and HE3; HE24 is
2025-11-03 06:00Z. Spring HE1 is 07:00Z, HE3 is 08:00Z, and HE24 is 2026-03-09
05:00Z.

## Collector activation boundary

Fixtures use deterministic synthetic numbers but exact fields/types/shapes.
`ercot_public_load_collector.ts` implements the disabled-by-default hourly
runner. It resolves only exact artifact links advertised by the live inventory,
uses bounded product-specific filters and the shared 30-request/minute client,
fetches every page, and rejects incomplete or changing pagination. Forecast
rows are grouped into exactly one raw `postedDatetime` per immutable payload;
NP6-345 is one receiver-derived content snapshot. A valid empty response is
recorded as successful source availability and is never built or ingested as a
publication.

The 48-hour bootstrap/overlap path is hard bounded to 100 pages, 100,000 rows,
and 100 official publications per product per cycle. At the 1,000-row API page
size these limits cap retained positional records before payload construction,
rather than allowing the live catalog's million-row historical total to be
accumulated in collector memory. Advertised totals over either cap fail on the
first page and cannot ingest or advance a checkpoint. Every nonterminal page
must contain the stable advertised page size, the terminal page must contain
the exact remainder, and every returned row must fall inside the requested
posted, delivery, operating-day, and hour bounds.

Forecast delivery bounds use the union from the overlap window's first Chicago
market day through seven days after its last Chicago market day. This prevents
a cycle crossing local midnight from replaying only a subset of the prior
official publication. The local bounds are derived independently across DST
transitions.

Each nonempty publication is submitted atomically to
`POST /api/forecast-publications/ingest`. The collector and route use the same
1 MiB body ceiling: a deterministic 1,536-row NP3-565 full-day maximum-shape
fixture (8 delivery days x 24 hour endings x the 8 verified models) fits, while an
oversize publication is rejected rather than split. Source health and an
opaque versioned checkpoint are persisted only after the complete publication
set succeeds. The next hourly cycle overlaps by two hours; replay relies on the
receiver's canonical immutable identity and returns `unchanged` without
inventing a new vintage.

Forecast freshness timestamps use the newest official issued time, not the
farthest future delivery target; bounded target minimum/maximum epochs remain
available in diagnostics. NP6-345 actual freshness uses its newest observed
target epoch.

Activation requires `ERCOT_FORECAST_INGEST_ENABLED=true`, all four ERCOT
credential variables, `METRICS_API_KEY`, and the exact forecast receiver
endpoint. Missing values fail honest without logging them; disabled existing
deployments remain healthy. Deployment, secret injection, sustained live
multi-page collection, production source-health observation, and dashboard
parity remain explicitly deferred to a reviewed rollout.
