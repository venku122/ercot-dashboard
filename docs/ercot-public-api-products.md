# ERCOT Public API product catalog

Verified on 2026-08-18. This is the PR 02 discovery record for the observatory ingestion plan. It contains product metadata and capacity-planning assumptions only. It intentionally contains no credentials, tokens, request headers, or response rows.

## Verification result

The authenticated live inventory at `GET https://api.ercot.com/api/public-reports` returned:

- 111 products, all marked active
- 240 artifacts across those products
- all five PR 01 gate products: NP3-565-CD, NP3-566-CD, NP3-763-CD, NP6-345-CD, and NP6-346-CD

The checked-in [sanitized live catalog](./ercot-public-api-catalog-2026-08-18.json) preserves all 111 product identities, activation/history metadata fields, and 240 exact artifact endpoint links. Reconciliation found 102 artifacts represented by the inspected OpenAPI, 138 live-only artifacts requiring a schema probe, and 4 specification-only paths.

The separate ESR subscription accepted a bounded request to `GET https://api.ercot.com/api/public-data/rptesr-m/4_sec_esr_charging_mw`. It returned the expected five-field schema but zero rows in every test window. That establishes access and schema shape, not publication cadence or storage cardinality. See [ERCOT API live verification](./ercot-api-live-verification.md).

## Authority and provenance

Use these sources in this order when implementing or refreshing the catalog:

1. The authenticated live [Public API inventory](https://developer.ercot.com/applications/pubapi/user-guide/using-api/) is authoritative for the products and artifacts currently offered. Preserve each artifact's exact `artifacts[*]._links.endpoint.href`; never derive a slug from a product title or EMIL ID.
2. ERCOT's [official OpenAPI repository](https://github.com/ercot/api-specs/blob/main/pubapi/pubapi-apim-api.json) is authoritative for the documented path, parameter spelling, and response schema that it contains. This review inspected the `main`-branch file with Git blob ID `e2b649f1e8e42b6d6d5f62e868eb11799a589cdf`.
3. ERCOT's [Public API release notes](https://developer.ercot.com/applications/pubapi/relnotes/) establish product activation and API release history.
4. ERCOT's [known limitations](https://developer.ercot.com/applications/pubapi/known-limits/) establish rate, geography, archive, and pre-activation-history constraints.

The live inventory can lead the checked-in OpenAPI document. In particular, the 2025-R11 release added NP3-763-CD and several Real-Time Market products that are not present in the inspected OpenAPI snapshot. A live endpoint link must therefore be captured and reviewed before adding any such adapter.

Each stored row or chunk must retain enough provenance to reconstruct its meaning: EMIL product ID, exact artifact path, query window, retrieval time, ERCOT source/posted timestamp when present, issue time for forecasts, target interval, DST/repeated-hour marker, units, and parser/schema version. Preserve raw timestamp text alongside normalized UTC until DST behavior is proven per artifact.

## Exact audited artifact paths

All paths in this table are verbatim from the inspected official OpenAPI document. They are relative to `https://api.ercot.com/api/public-reports`. Parameter names are case-sensitive. Every listed endpoint also documents the common `page`, `size`, `sort`, and `dir` parameters; the table records the exact time and identity filters appropriate for bounded ingestion.

| Product    | Exact artifact path                          | Initial bounded filters                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NP3-565-CD | `/np3-565-cd/lf_by_model_weather_zone`       | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `postedDatetimeFrom`, `postedDatetimeTo`, `model`, `inUseFlag`, `DSTFlag`                                                                                                                                                          |
| NP3-566-CD | `/np3-566-cd/lf_by_model_study_area`         | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `postedDatetimeFrom`, `postedDatetimeTo`, `model`, `DSTFlag`                                                                                                                                                                       |
| NP6-345-CD | `/np6-345-cd/act_sys_load_by_wzn`            | `operatingDayFrom`, `operatingDayTo`, `hourEnding`, `DSTFlag`                                                                                                                                                                                                                          |
| NP6-346-CD | `/np6-346-cd/act_sys_load_by_fzn`            | `operatingDayFrom`, `operatingDayTo`, `hourEnding`, `DSTFlag`                                                                                                                                                                                                                          |
| NP3-233-CD | `/np3-233-cd/hourly_res_outage_cap`          | `operatingDateFrom`, `operatingDateTo`, `hourEndingFrom`, `hourEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`                                                                                                                                                                     |
| NP4-732-CD | `/np4-732-cd/wpp_hrly_avrg_actl_fcast`       | `deliveryDateFrom`, `deliveryDateTo`, `hourEndingFrom`, `hourEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                            |
| NP4-733-CD | `/np4-733-cd/wpp_actual_5min_avg_values`     | `intervalEndingFrom`, `intervalEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                                                          |
| NP4-742-CD | `/np4-742-cd/wpp_hrly_actual_fcast_geo`      | `deliveryDateFrom`, `deliveryDateTo`, `hourEndingFrom`, `hourEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                            |
| NP4-743-CD | `/np4-743-cd/wpp_actual_5min_avg_values_geo` | `intervalEndingFrom`, `intervalEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                                                          |
| NP4-737-CD | `/np4-737-cd/spp_hrly_avrg_actl_fcast`       | `deliveryDateFrom`, `deliveryDateTo`, `hourEndingFrom`, `hourEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                            |
| NP4-738-CD | `/np4-738-cd/spp_actual_5min_avg_values`     | `intervalEndingFrom`, `intervalEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                                                          |
| NP4-745-CD | `/np4-745-cd/spp_hrly_actual_fcast_geo`      | `deliveryDateFrom`, `deliveryDateTo`, `hourEndingFrom`, `hourEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                            |
| NP4-746-CD | `/np4-746-cd/spp_actual_5min_avg_values_geo` | `intervalEndingFrom`, `intervalEndingTo`, `postedDatetimeFrom`, `postedDatetimeTo`, `DSTFlag`                                                                                                                                                                                          |
| NP6-322-CD | `/np6-322-cd/sced_system_lambda`             | `SCEDTimestampFrom`, `SCEDTimestampTo`, `repeatHourFlag`                                                                                                                                                                                                                               |
| NP6-787-CD | `/np6-787-cd/lmp_electrical_bus`             | `SCEDTimestampFrom`, `SCEDTimestampTo`, `repeatHourFlag`, `electricalBus`                                                                                                                                                                                                              |
| NP6-788-CD | `/np6-788-cd/lmp_node_zone_hub`              | `SCEDTimestampFrom`, `SCEDTimestampTo`, `repeatHourFlag`, `settlementPoint`                                                                                                                                                                                                            |
| NP6-86-CD  | `/np6-86-cd/shdw_prices_bnd_trns_const`      | `SCEDTimestampFrom`, `SCEDTimestampTo`, `repeatedHourFlag`, `fromStation`, `toStation`, `fromStationkVFrom`, `fromStationkVTo`, `toStationkVFrom`, `toStationkVTo`, `CCTStatus`, `constraintIDFrom`, `constraintIDTo`, `constraintName`, `contingencyName`                             |
| NP6-905-CD | `/np6-905-cd/spp_node_zone_hub`              | `deliveryDateFrom`, `deliveryDateTo`, `deliveryHourFrom`, `deliveryHourTo`, `deliveryIntervalFrom`, `deliveryIntervalTo`, `settlementPoint`, `settlementPointType`, `DSTFlag`                                                                                                          |
| NP6-970-CD | `/np6-970-cd/rtd_lmp_node_zone_hub`          | `RTDTimestampFrom`, `RTDTimestampTo`, `repeatHourFlag`, `intervalIdFrom`, `intervalIdTo`, `intervalEndingFrom`, `intervalEndingTo`, `intervalRepeatHourFlag`, `settlementPoint`, `settlementPointType`                                                                                 |
| NP4-183-CD | `/np4-183-cd/dam_hourly_lmp`                 | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `busName`, `DSTFlag`                                                                                                                                                                                                               |
| NP4-188-CD | `/np4-188-cd/dam_clear_price_for_cap`        | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `ancillaryType`, `DSTFlag`                                                                                                                                                                                                         |
| NP4-190-CD | `/np4-190-cd/dam_stlmnt_pnt_prices`          | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `settlementPoint`, `DSTFlag`                                                                                                                                                                                                       |
| NP4-191-CD | `/np4-191-cd/dam_shadow_prices`              | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `deliveryTimeFrom`, `deliveryTimeTo`, `constraintIdFrom`, `constraintIdTo`, `constraintName`, `contingencyName`, `fromStation`, `toStation`, `fromStationkVFrom`, `fromStationkVTo`, `toStationkVFrom`, `toStationkVTo`, `DSTFlag` |
| NP4-523-CD | `/np4-523-cd/dam_system_lambda`              | `deliveryDateFrom`, `deliveryDateTo`, `hourEnding`, `DSTFlag`                                                                                                                                                                                                                          |

The OpenAPI schema also offers numeric range filters for many measurements and prices. Those are not ingestion boundaries and must not be used to silently exclude valid extreme values. Adapter tests should use the full schema to verify response fields, while production pulls should primarily bound time and, where intentional, identity.

### ESR artifact

The ESR API uses a different subscription product and base path:

`GET https://api.ercot.com/api/public-data/rptesr-m/4_sec_esr_charging_mw`

Its exact bounded query filters are `AGCExecTimeFrom` and `AGCExecTimeTo`. The PR 01 live check established top-level `fields`, `data`, and `_meta` members with the expected five field definitions; it did not establish a non-empty row shape. Do not promote an ESR parser until a non-empty bounded response has been schema-checked without retaining response rows in documentation or logs.

## Inventory-discovered and deferred contracts

The directive also requires the following products. Their exact live `artifacts[*]._links.endpoint.href` values are preserved in the sanitized catalog; no endpoint slug is synthesized. Where the inspected OpenAPI lacks the artifact, its current filter schema still requires a bounded contract probe before ingestion.

| Domain                     | Product IDs                                                                        | Required next action                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Load, capacity, and outage | NP3-763-CD, NP3-765-CD                                                             | Use the checked-in live links; record filter/timestamp semantics for live-only artifacts before adapter work.               |
| Renewables                 | NP4-442-CD                                                                         | Use the checked-in live link and complete its bounded schema/filter probe.                                                  |
| Real-Time Market           | NP6-323-CD, NP6-324-CD, NP6-325-CD, NP6-327-CD, NP6-328-CD, NP6-331-CD, NP6-332-CD | Use every checked-in live artifact link; these newer products remain live-only where the inspected OpenAPI has no contract. |
| Day-Ahead Market           | NP4-19-CD, NP4-212-CD, NP4-532-CD, NP4-791-CD, NP3-914-EX, NP3-915-EX              | Use the checked-in product-to-artifact mappings and review each unresolved filter schema.                                   |
| Disclosure                 | NP3-965-ER, NP3-966-ER, NP3-987-EX                                                 | Preserve every checked-in artifact; contract review must select explicitly rather than choosing one by title.               |

“Required” is not equivalent to “safe to ingest.” A product remains deferred until the exact live path, activation date, timestamp semantics, pagination behavior, natural key, expected cadence, and units are recorded in an adapter contract test.

## Pagination and query rules

1. Always send a bounded source-time or delivery-time window. Use the exact timestamp spelling and format declared by the artifact; do not apply a global filter vocabulary.
2. Send `page`, a conservative `size`, and an explicit stable `sort`/`dir` when the endpoint accepts them. The inspected specification does not establish one universal maximum `size`, so discover and record the accepted value per artifact instead of assuming one.
3. Read the response `_meta` fields, including `currentPage`, `totalPages`, `pageSize`, and `totalRecords`. Continue until the metadata identifies the final page; fail closed on a missing page, a repeated page, inconsistent totals, or an unexpected empty page.
4. Deduplicate by the artifact's reviewed natural key, not by page number. Page contents can move while ERCOT publishes new or corrected rows.
5. Route every page through the shared limiter. ERCOT documents 30 requests per minute and returns HTTP 429 when the subscription limit is exceeded. Retry only under the client's bounded retry policy.
6. Record the final query window, page count, row count, and response/schema fingerprint without logging rows or authorization material.

Historical-file downloads are a separate flow. ERCOT limits a historic-file request to 1,000 files, so archive discovery must paginate or split requests by a deterministic time range and verify continuity before marking a backfill complete.

## Activation and history caveats

- Queryable API data begins on a product's Public API activation date, not at the beginning of ERCOT's underlying publication history.
- Older data is available only through historic-file downloads when ERCOT has retained it; the documented retention target is at least seven years.
- A successful recent query does not prove that the same endpoint covers a pre-activation backfill. Backfills need a separate archive manifest, checksums, and gap report.
- Product activation, artifact membership, and schemas can change. Refresh the live inventory before enabling a new adapter and fail contract tests on an unreviewed path or field change.
- Public API access is geographically restricted outside the United States. A collector's deployment location is therefore an operational dependency.
- Preserve `DSTFlag`, `repeatHourFlag`, `repeatedHourFlag`, and interval repeat markers exactly as named by each artifact. Texas fall-back hours cannot be keyed by local wall-clock time alone.

## Reproducible capacity estimates

These estimates are conservative planning scenarios, not measured ERCOT cardinality. Decimal units are used (`1 MB = 1,000,000 bytes`, `1 GB = 1,000,000,000 bytes`). Let:

- `r = intervals/day * entities` for a dense feed
- `raw bytes/day = r * serialized bytes/row`
- `stored bytes/day = raw bytes/day * index factor`
- `retention bytes = stored bytes/day * retention days`

The range below applies a 1.5x index/storage factor to the low row-size estimate and a 2.5x factor to the high estimate. It assumes no compression and excludes replicas, backups, temporary compaction space, WAL growth, HTTP envelopes, raw-object retention, and forecast corrections; those must be budgeted separately.

| Planning scenario                                                               | Assumed rows/day |            Raw/day |        Indexed/day |     Indexed/30 days |      Indexed/365 days |
| ------------------------------------------------------------------------------- | ---------------: | -----------------: | -----------------: | ------------------: | --------------------: |
| ESR, 4-second cadence, 100 resources, 160-320 B/row                             |        2,160,000 |     345.6-691.2 MB |  518.4 MB-1.728 GB |     15.552-51.84 GB |     189.216-630.72 GB |
| ESR, 4-second cadence, 300 resources, 160-320 B/row                             |        6,480,000 |   1.0368-2.0736 GB |    1.5552-5.184 GB |    46.656-155.52 GB | 567.648 GB-1.89216 TB |
| Five-minute price feed, 10,000 entities, 80-160 B/row                           |        2,880,000 |     230.4-460.8 MB |  345.6 MB-1.152 GB |     10.368-34.56 GB |     126.144-420.48 GB |
| Five-minute price feed, 20,000 entities, 80-160 B/row                           |        5,760,000 |     460.8-921.6 MB |  691.2 MB-2.304 GB |     20.736-69.12 GB |     252.288-840.96 GB |
| Forecast-vintage example, 24 issues x 9 zones x 168 target hours, 120-240 B/row |           36,288 | 4.35456-8.70912 MB | 6.53184-21.7728 MB | 195.9552-653.184 MB | 2.3841216-7.947072 GB |

For a different cardinality, substitute the measured entity count and encoded row size in the formulas; do not scale from the table by intuition. In particular, the ESR live validation observed zero rows, so neither 100 nor 300 resources is a statement about the current feed. Before PR 16 sets retention, sample non-empty bounded windows, count distinct resource identities, measure actual encoded database bytes including indexes, and compare at least a normal day, a DST transition, and a correction-heavy interval.

High-cardinality feeds should remain uncollected until their measured scenario fits the storage budget and query plan. Prefer aggregates or bounded recent retention for 4-second ESR and nodal price data; retain longer history only where the user-facing product requires it.

## Refresh gate

Before implementing any deferred adapter:

1. Refresh the sanitized inventory manifest containing product IDs, active flags, activation/history metadata, artifact names, exact endpoint links, and OpenAPI reconciliation status.
2. Compare the manifest with the official OpenAPI and release notes, recording discrepancies without inventing mappings.
3. Run a bounded, low-volume schema probe that records counts and field names but no response rows.
4. Add a credential-free fixture and contract test for pagination, empty collections, timestamp/DST handling, and natural-key deduplication.
5. Recalculate rows and encoded bytes from observed non-sensitive counts before selecting cadence or retention.
