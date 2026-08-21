# Congestion and price geography

PR15 adds a non-geographic price matrix and coincident constraint evidence to the Market view. It does not claim that a constraint caused, contributed to, or decomposes a displayed point price. NP6-86 does not publish settlement-point shift factors, so the strongest supported statement is that a constraint was reported in the exact same SCED run as the displayed NP6-788 LMP snapshot. NP6-905 settlement prices are a separate 15-minute product and are not joined to per-SCED LMPs or constraints as components.

The disabled-by-default collector accepts only public CSV ZIP documents for NP6-788, NP6-905, and NP6-86. It validates the exact product/report mapping, ordered header fingerprint, Public security status, full `cdr` ConstructedName grammar, bounded DocID and PublishDate, ZIP/CSV sizes, row counts, America/Chicago market-time conversion, repeated-hour flag, natural-key uniqueness, and finite numeric fields. Set `ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED=true` only after reviewed activation with the receiver endpoint and existing API key. The established pricing chart remains on its existing collector contract; this new pipeline uses separate receiver tables and public identities.

The current matrix contains exactly five `HU` hubs and eight `LZ` load zones from one coherent NP6-905 interval. `LZEW` rows remain a distinct official product identity and never overwrite `LZ`; `HB_BUSAVG` (`SH`) and `HB_HUBAVG` (`AH`) are shown only as reference prices. NP6-788 point identifiers outside the reviewed allowlist remain opaque. No reviewed point coordinates, constraint-line geometry, or settlement-zone polygons are available, so the UI is explicitly a matrix rather than a Texas map.

`GET /api/v1/market-geography` is fixed and query-free. It exposes independent current blocks for the coherent settlement interval, an exact allowlisted LMP snapshot, and at most 20 NP6-86 constraint rows whose normalized timestamp exactly equals that LMP snapshot. Partial point membership, valid-empty constraints, source failure, source delay, durable official-document gaps, and materialization failure remain distinct states. Each block carries raw source time, normalized target, official issue time, DocID, retrieval provenance, and freshness.

Completed UTC-day history uses query-free, content-versioned native resources:

`/api/v2/market-geography/{kind}/{identity}/v1/{content_version}/1d/{utc_day_start}/native`

Open-day ingestion updates only the bounded live manifest and creates no immutable daily blobs. UTC rollover seals completed-day scalar resources once. A completed-day correction creates a new full-byte content version while the old URL and ETag remain readable for the advertised 35-day lifetime. Resource generation uses keyed singleflight and generation-aware manifest invalidation; pruning is bounded and cannot delete a still-advertised URL early.

The Market panel is collapsed by default and performs no geography request until opened. Opening loads one manifest, and only the selected point or constraint history is fetched. Selection state is restored through the URL and Back/Forward navigation. Matrix controls support roving keyboard focus, exact tables remain the complete accessible fallback, missing intervals split chart paths rather than being interpolated, and narrow layouts keep controls inside the viewport while tables scroll internally.

Deferred work includes full nodal lookup/ranking, licensed or authoritative geometry, settlement-point shift factors, archive backfill beyond collection start, and coarse historical LODs. None of those may be inferred from the current products.
