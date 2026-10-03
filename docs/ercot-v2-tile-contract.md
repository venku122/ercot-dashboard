# ERCOT semantic tile v2 contract

The receiver exposes a versioned semantic catalog and canonical aggregate tiles:

- `GET /api/v2/tile-catalog`
- `GET /api/v2/tiles/{series_key}/{tile_span}/{tile_start}/{lod}`

This is the storage and cache contract for the frontend planner introduced in
the next stacked change. PR05 does not switch any chart to v2.

## Canonical identity

A tile URL has exactly four path parameters and no query string. `series_key`
must be an exact key from the catalog. `tile_span` is `1h` or `1d`,
`tile_start` is a canonical non-negative decimal UTC epoch aligned to that
span, and `lod` is one of the entry's declared resolutions. Aliases, unknown
keys, unsupported resolutions, unaligned starts, leading-zero timestamps, and
query parameters fail closed with a non-cacheable response.

The public catalog and tile payloads never expose SQLite `series_id` values.
Those IDs are internal dependencies used for precise invalidation. Catalog
entries are stable within schema 2: changing a key's metric, tags, rollup,
cadence, unit, or statistic policy requires a new tile schema/API version. The
catalog itself is revalidated because new keys may be added without changing
existing identities.

The catalog is the receiver's authoritative shared definition. PR06 consumes
the served catalog instead of adding a separate frontend series map.

## Time and level-of-detail semantics

Tiles cover the half-open UTC interval `[tile_start, tile_end)`. The receiver
accepts only fixed hourly and daily tiles. Browser locale and daylight-saving
transitions do not affect alignment.

`native` preserves each observation as an instantaneous one-point aggregate;
its wrapper therefore has equal `start` and `end` timestamps and must not be
interpreted as an integration interval. Coarser LODs use aligned half-open
buckets and contain the mergeable state described in
`ercot-tile-aggregate-algebra.md`. Empty buckets are omitted.

Coarse states cannot be clipped exactly. A planner must request native tiles
for boundary portions of a selected window and may use coarse states only for
aligned interiors. It then clips native observations to the exact requested
window before merging. The catalog publishes this boundary policy.

For selector entries such as total fuel mix, the receiver first constructs the
timestamp-level semantic series using the declared `sum` rollup and only then
aggregates it into LOD buckets. It never sums constituent aggregate states.

## Aggregate state

Every non-empty bucket carries a versioned deterministic state containing:

- count and sum;
- minimum and maximum with deterministic earliest timestamps;
- first and last observations;
- the left-step `integral_value_seconds`.

Average and, for catalog-declared MW power series only, MWh are derived from
the state. They are not serialized into the generic merge state. Values must
be finite, numeric zero is normalized to positive zero, and serialization uses
stable compact key ordering. See `ercot-tile-aggregate-algebra.md` for the
bridge formula and randomized direct-versus-merged evidence.

## Cache, ETag, and singleflight

The canonical identity includes schema, semantic key, span, aligned start, and
LOD. Deterministic JSON bytes produce a strong ETag. A cold request is generated
once, a repeated request is served from the bounded receiver LRU without a
second SQLite generation, and a matching `If-None-Match` receives `304`.

Canonical tiles are not persisted. SQLite persists authoritative
source/application data. A canonical tile is generated on an origin cache miss
by querying SQLite, then retained only in bounded receiver/application memory
and the external CDN according to cache policy. A strong ETag is calculated
from deterministic response bytes; it is validation metadata, not a persistent
tile identity or permission to store the response in SQLite.

After a receiver restart the LRU is empty. The first request therefore scans
the authoritative SQLite range and regenerates the same deterministic bytes and
ETag when source rows are unchanged. There is no exact-content tile child route,
SQLite generated-tile table, filesystem tile cache, or background tile
pre-generation.

Concurrent requests for the same identity share one keyed generation; requests
for different identities remain concurrent. The leader rechecks the LRU after
election. Exceptions are propagated to waiters, are never cached, and always
remove the flight entry.

Cached exact tiles depend on a stable normalized identity hash, including while
that identity has no samples, plus its resolved internal storage series when
present. Selector tiles depend on a stable hash of the metric and required-tag
selector plus all currently matching storage series. Ingest emits only the
identity and catalog selectors matched by the old and new normalized tags, so
an unrelated identity under the same metric does not evict a tile. These
dependencies are internal and never appear in public payloads.

Every dependency also carries the inclusive sample range corresponding to the
tile's half-open interval. A correction at the tile start or inside the tile
invalidates it; a correction exactly at the tile end affects the next tile.
Corrections that move timestamp, metric, or tags report both old and new
storage identities/ranges. A generation snapshot prevents an in-flight
pre-correction result from being inserted after invalidation, and the snapshot
is part of the flight key so a post-correction request cannot join stale work.

The generation guard is deliberately conservative: any concurrent ingest may
prevent an unrelated in-flight tile from entering the LRU. The response remains
correct and a later request regenerates it.

## Cache policy and rollout boundary

Receiver and response policy remains conservative:

| Class                     |      Receiver TTL |    Browser | Shared edge |
| ------------------------- | ----------------: | ---------: | ----------: |
| live logical              | current short TTL |  5 seconds |  15 seconds |
| recent logical            |         5 minutes | 60 seconds |   5 minutes |
| completed-history logical |         5 minutes | 60 seconds |   5 minutes |

Completed-history logical tiles remain correction-aware and are never called
immutable. Receiver range invalidation makes the next logical request resolve
the correction from SQLite and emit a changed ETag when bytes change. The
canonical URL remains stable. Shared-cache staleness is bounded by the finite
revalidation policy until a separate purge or version design is approved. This
PR does not create or modify a Cloudflare rule.

Errors, invalid requests, incomplete normalized-series backfills, and writes
are `no-store`. A database with unresolved `series_id` rows receives a 503 for
the affected v2 metric instead of silently dropping legacy rows.

## Current limitations

- The LRU and singleflight registry are process-local and are empty after a
  receiver restart; canonical tiles regenerate from authoritative SQLite rows.
- The frontend still uses v1 until PR06 implements the catalog-driven planner.
- No production or edge-cache mutation is part of this draft.
- Direct-origin and local concurrency evidence is in the deterministic receiver
  suite; live Cloudflare MISS-to-HIT proof remains a post-deployment,
  human-authorized gate.
