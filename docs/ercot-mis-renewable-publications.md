# ERCOT MIS renewable publication contract

Verified 2026-08-18, this adapter is limited to the public hourly CSV ZIP artifacts for:

- NP4-732-CD / report type `13028`: `STWPF_SYSTEM_WIDE` forecast and `SYSTEM_WIDE_HSL` outcome.
- NP4-737-CD / report type `13483`: `STPPF_SYSTEM_WIDE` forecast and `SYSTEM_WIDE_HSL` outcome.

It deliberately does not use NP4-733/NP4-738 or `SYSTEM_WIDE_GEN`. ERCOT describes the forecasts as attempts to predict HSL (uncurtailed potential), while actual generation can be curtailed and is therefore not the accepted performance outcome. The official [Hourly Wind Power Production and Forecasts](https://www.ercot.com/mp/data-products/data-product-details?id=NP4-732-CD), [Hourly Solar Power Production and Forecasts](https://www.ercot.com/mp/data-products/data-product-details?id=NP4-737-CD), and [Combined Wind and Solar](https://www.ercot.com/gridmktinfo/dashboards/combinedwindandsolar) pages are the source authority. Values are stored as MW under that reviewed first-party mapping.

## Discovery and identity

The unauthenticated IceDoc list endpoint is queried with report type `13028` or `13483`. A document is eligible only when `SecurityStatus=P`, `Extension=zip`, and `FriendlyName` ends in `_csv`; an XML ZIP sibling exists. The canonical download is `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=<DocID>`.

`DocID`, offset-bearing `PublishDate`, `ConstructedName`, and `ContentSize` are all retained. `DocID` is the immutable official publication key, and `PublishDate` independently supplies `issued_at`; filename time is not substituted. The runner ingests unseen documents oldest first and retains a per-product `(issuedAt, DocID)` high-water plus bounded DocID overlap for idempotent replay. A fresh bootstrap intentionally selects only the most recent bounded documents instead of attempting the entire seven-day public list; the result reports both bootstrap truncation and remaining backlog.

Source health is emitted separately under the manifest IDs `ercot_mis_np4_732` and `ercot_mis_np4_737`, with product-specific row/document counts, backlog, bootstrap state, and newest successfully stored official `PublishDate` for both source and data freshness; future delivery targets never make collection appear fresh. The combined high-water/overlap checkpoint is mirrored to both source records and accepted on reload only when the copies agree. Because collection is an all-or-nothing checkpoint cycle, a failure reports a bounded sanitized error code for both products without a new checkpoint, and the hourly process continues to the next cycle.

## Strict parsing and safety bounds

The exact ordered 20- and 8-column headers are frozen in the sanitized contract fixture. The parser accepts at most 512 rows and a 4 MiB uncompressed CSV. The archive must contain exactly one safe-named CSV entry, be at most 2 MiB compressed, be unencrypted, and use stored or deflate compression. The serialized list is capped at 1 MiB, nesting at 12 levels, and document objects at 500; a cycle processes 48 documents by default (hard maximum 168). Declared and downloaded byte counts must agree before parsing. Calendar dates round-trip exactly, targets must be strictly ascending and unique, and source numeric values are finite nonnegative MW no greater than the conservative 1,000,000 MW safety ceiling.

The live hourly artifacts observed on 2026-08-18 each contained 216 rows: 48 historical rows with actual HSL and generation populated, followed by 168 future rows with those actual columns blank. This is deployment evidence, not a timeless row/split requirement. Schema, widths, numeric grammar, market-day/hour/DST grammar, and all hard bounds remain enforced. `SYSTEM_WIDE_GEN` is parsed only as part of the strict source width and is never emitted.

Rows emitted to storage contain `target_ts`; normalized `delivery_date`, `hour_ending`, and boolean `dst_flag`; exact source `raw_delivery_date`, `raw_hour_ending`, and `raw_dst_flag`; `forecast_mw`; and nullable `actual_hsl_mw`. `target_ts` is the UTC interval end derived from the America/Chicago market-day sequence, including spring and repeated fall hours.

## Activation and limitations

The hourly runner is wired into `mod.ts` and both Compose variants, but remains disabled by default. It requires `ERCOT_RENEWABLE_INGEST_ENABLED=true`, `ERCOT_RENEWABLE_ENDPOINT` (default `http://receiver:8080/api/renewable-publications/ingest`), and `METRICS_API_KEY`; missing opt-in or values leave it fail-honest and disabled. List/download requests are unauthenticated, body-bounded, timeout-bounded, and never receive the receiver key. This wiring is activation-ready but is not evidence of a deployment or successful production collection.

IceDoc exposed 352 documents over seven display days at verification time. That is enough for bounded replay and operational checks, but it cannot prove the directive's multi-week qualification immediately after a fresh deployment. Sustained collection must accumulate that evidence. No live response rows, credentials, or tokens are checked in; fixture numbers and document IDs are synthetic.
