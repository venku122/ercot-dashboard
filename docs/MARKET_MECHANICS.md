# Market mechanics context

PR14 adds evidence for the question “what changed in the same window as the price move?” It is deliberately not a price decomposition or a causal model. Hub and load-zone Settlement Point Prices retain their existing 15-minute cadence and congestion/loss basis; the SCED measurements below are displayed as separately timed context and are never summed into a calculated SPP.

The disabled-by-default collector accepts only public CSV ZIP documents for NP6-322, NP6-323, NP6-328, and NP6-332. It validates exact headers, report IDs, public security status, the full `cdr` ConstructedName grammar, DocID, offset-bearing PublishDate, bounded ZIP/CSV sizes, America/Chicago SCED timestamps, and product row cardinality. Set `ERCOT_MARKET_MECHANICS_INGEST_ENABLED=true` with the receiver endpoint and existing API key only after reviewed activation. NP6-331 15-minute time-weighted settlement MCPC and NP6-86 binding constraints remain deferred.

NP6-322 is the sole canonical System Lambda history. NP6-323 SystemLambda is retained only for an exact-SCED parity check with a documented `0.00005 $/MWh` rounding tolerance. NP6-323 exposes six scalar price-adder resources and eleven scalar operational-input resources; it does not combine mixed units. `RTDLL` and `RTBLT` remain neutral source-field names because an authoritative expansion was not verified. NP6-328 capability combinations are overlapping MW measurements and must not be summed. NP6-332 MCPC uses `$/MW`.

`GET /api/v1/market-mechanics` is a fixed, short-cache manifest. Its `current` and `previous` values exist only where NP6-322, NP6-323, NP6-328, and all five NP6-332 services share the exact normalized SCED timestamp. Signed changes use the immediately prior coherent SCED snapshot and disclose elapsed seconds. Missing or unaligned sources stay unavailable rather than becoming zero.

Immutable history uses query-free completed UTC-day resources:

`/api/v2/market-mechanics/{series_key}/v1/{content_version}/1d/{utc_day_start}/native`

Open-day SCED updates do not mint immutable blobs. The manifest carries the bounded live snapshot; rollover seals the prior day once. Corrections to a completed day mint a new full-byte content version while the old URL remains origin-readable for its advertised 35-day lifetime. Raw publications and retired resources are pruned in bounded batches after their corresponding retention grace.

The Market view panel is collapsed and performs zero market-mechanics requests until opened. Opening performs one manifest request; only the selected scalar’s latest completed-day resource is fetched. Every displayed reading retains observation, official PublishDate/issue, DocID, source, unit, freshness, and an exact-value table.
