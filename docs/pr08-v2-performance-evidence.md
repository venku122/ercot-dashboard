# PR08 reproducible v2 tile performance evidence

Date: 2026-08-18

This is isolated local evidence, not a production, browser, or Cloudflare
measurement. `scripts/benchmark_v2_tiles.py` creates a temporary SQLite
database, starts the real receiver `Server` and `Handler.do_GET` on loopback,
requests canonical v2 URLs over HTTP, shuts the server down, and deletes the
fixture. It neither reads nor mutates production data.

## Reproduce

```sh
python3 -B scripts/benchmark_v2_tiles.py > /tmp/pr08-v2-evidence.json
python3 -B -m unittest scripts.test_benchmark_v2_tiles -v
```

The fixture contains 105,696 five-minute observations for the cataloged
`supply-demand.demand` identity in a 22,827,008-byte SQLite database. The six
windows end at the same aligned UTC instant and use the frontend contract's
inclusive endpoint and 1,200-point LOD target. The benchmark invokes Node with
type stripping to import the actual
`frontend/src/dashboard/tile-planner.ts`, parses the receiver's actual v2
catalog, and plans with the production default 86,400-second correction
horizon. It produces one plan with the argument omitted and a second with an
explicit 86,400-second horizon, then requires their complete URL maps to be
equal. The tested catalog entry supports `native`, `5m`, `15m`, and `1h`. This
makes planner URL, production-default horizon, catalog LOD, and
correction-horizon drift fail the benchmark instead of silently changing a
benchmark-only Python approximation.

## Direct receiver results

The table reports complete sequential fanout time. Per-request p50/p95 values
and exact URLs remain in the JSON output. TTFB includes receiver lookup,
SQLite, aggregation, deterministic JSON serialization, and response headers;
total additionally includes reading the body over loopback.

| Window | v2 GETs |     Bytes | Cold TTFB | Warm TTFB | Cold total | Warm total | SQLite execute+fetch count/time | Buckets | JSON parse proxy | Merge proxy |
| ------ | ------: | --------: | --------: | --------: | ---------: | ---------: | ------------------------------: | ------: | ---------------: | ----------: |
| 6h     |       2 |    93,871 |  0.0084 s |  0.0016 s |   0.0084 s |   0.0016 s |                    6 / 0.0002 s |     288 |         0.0007 s |    0.0001 s |
| 24h    |       2 |    93,871 |  0.0063 s |  0.0014 s |   0.0063 s |   0.0015 s |                    6 / 0.0002 s |     288 |         0.0006 s |    0.0001 s |
| 7d     |       8 |   225,316 |  0.0214 s |  0.0042 s |   0.0214 s |   0.0043 s |                   24 / 0.0010 s |     672 |         0.0016 s |    0.0002 s |
| 30d    |      31 |   249,010 |  0.0502 s |  0.0091 s |   0.0505 s |   0.0095 s |                   93 / 0.0042 s |     720 |         0.0018 s |    0.0002 s |
| 90d    |      91 |   746,470 |  0.1480 s |  0.0273 s |   0.1489 s |   0.0281 s |                  273 / 0.0123 s |   2,160 |         0.0054 s |    0.0005 s |
| 1y     |     366 | 3,026,495 |  0.6089 s |  0.1274 s |   0.6125 s |   0.1318 s |                1,098 / 0.0509 s |   8,760 |         0.0272 s |    0.0028 s |

The SQLite column is not whole-helper timing. A benchmark-only connection and
cursor proxy is installed only while `_tile_storage_points` runs. It counts a
statement after its `execute` plus `fetchone`/`fetchall` pair completes and
records their combined wall time. For this exact series, each cold tile makes
three such statement/fetch pairs: incomplete-backfill check, series identity
lookup, and point fetch. Warm receiver-LRU hits make none.

Per-request latency percentiles from the same run are transcribed below as
`p50 / p95`; the full-precision samples remain in the JSON output.

| Window |             Cold TTFB |             Warm TTFB |            Cold total |            Warm total |
| ------ | --------------------: | --------------------: | --------------------: | --------------------: |
| 6h     | 0.004198 / 0.006732 s | 0.000807 / 0.001243 s | 0.004224 / 0.006773 s | 0.000820 / 0.001261 s |
| 24h    | 0.003158 / 0.005379 s | 0.000712 / 0.001130 s | 0.003170 / 0.005392 s | 0.000727 / 0.001152 s |
| 7d     | 0.002748 / 0.003567 s | 0.000562 / 0.000607 s | 0.002759 / 0.003580 s | 0.000570 / 0.000629 s |
| 30d    | 0.001632 / 0.001756 s | 0.000290 / 0.000335 s | 0.001641 / 0.001767 s | 0.000307 / 0.000342 s |
| 90d    | 0.001615 / 0.001781 s | 0.000296 / 0.000355 s | 0.001624 / 0.001793 s | 0.000304 / 0.000361 s |
| 1y     | 0.001638 / 0.001846 s | 0.000345 / 0.000420 s | 0.001648 / 0.001859 s | 0.000358 / 0.000435 s |

Every cold fanout reported only `X-ERCOT-Cache: MISS`; the authoritative
`tile_origin_requests_total`, `tile_receiver_lru_misses_total`,
`tile_sqlite_generation_attempts_total`, `tile_sqlite_generations_total`, and
`tile_generation_latency_seconds_count` each equaled its request count. Every
immediately repeated fanout reported only `HIT`;
`tile_receiver_lru_hits_total` equaled its request count and it added zero
generation attempts, completed generations, generation latency observations,
or benchmark-timed SQLite execute/fetch pairs. The benchmark asserts every
cold raw response body is byte-for-byte equal to the corresponding warm body;
response byte counts and merge checksums were also equal.

The authoritative generation-latency count/sum/max triples for 6h, 24h, 7d,
30d, 90d, and 1y were respectively `2 / 0.0056 / 0.0045`,
`2 / 0.0046 / 0.0041`, `8 / 0.0159 / 0.0028`,
`31 / 0.0367 / 0.0014`, `91 / 0.1095 / 0.0016`, and
`366 / 0.4497 / 0.0029` seconds. Warm triples were all zero.

The JSON parse and merge columns are explicitly Python proxies: `json.loads`,
followed by deterministic bucket sorting and a `value_sum` walk. They make
relative payload work reproducible but are not claimed as frontend JavaScript,
render, or user-visible latency.

## Singleflight

Ten loopback clients requested one cold canonical URL concurrently. The
benchmark-only wrapper held the real generation path until nine waiter
elections were observed, with a two-second safety bound. The receiver performed
one tile generation and one generation attempt. One response was the leader,
nine were recorded by the authoritative `tile_singleflight_waits_total`, all
ten incremented `tile_origin_requests_total`, and all returned HTTP 200. The
deterministic test requires exactly ten clients, one leader, nine shared
responses, one completed generation, and one generation attempt.

## URL cardinality

Across 6h, 24h, 7d, 30d, 90d, and 1y windows:

| Contract                                        | Total planned requests | Unique URLs |
| ----------------------------------------------- | ---------------------: | ----------: |
| v1 faithful independently frozen chunk baseline |                    494 |         494 |
| v2 URLs emitted by the production tile planner  |                    500 |         374 |

V2 reduced unique identities by 120, or 24.291%. Its total plan has six more
requests because the established inclusive endpoint contract requires native
edge tiles. Reuse still improves because overlapping 30d, 90d, and 1y windows
share identical fixed-LOD URLs, while v1 embeds different range-derived
resolutions in otherwise overlapping days.

The v1 calculation faithfully freezes the established canonical chunk formula
independently in Python; it is not claimed to execute the frontend's
non-exported `historicalChunkWindows` helper or to provide a TypeScript drift
gate. The v2 calculation does execute the production planner as described
above.

These are planner identities for one physical series and one aligned end, not
a forecast of production cache hit ratio or global traffic. Production edge
MISS-to-HIT evidence remains a separate human-authorized deployment gate.
