# Receiver and Cloudflare cache architecture

## Resource model

`GET /api/v2/tiles/{series_key}/{1h|1d}/{start}/{lod}` is the canonical, shared-cacheable historical
resource. Series identity and rollup semantics come from the strict queryless tile catalog. The
frontend planner emits deterministic semantic paths, so equivalent requests converge on one URL.

Fixed windows without comparison are assembled in the browser from day chunks that are beyond the
24-hour correction horizon and hour chunks inside it. Live and comparison requests retain the batch
POST path because they are mutable and benefit from one request.

The receiver stores processed tile results in the bounded in-process LRU. Entries carry the metric
and exact half-open time range they depend on. Ingest invalidates an entry only when an inserted or
corrected observation intersects that range; unrelated live ingest does not evict that tile.

Generated canonical tile bodies are not persisted to SQLite or the filesystem. SQLite observations
are authoritative. A process restart starts with an empty LRU and regenerates deterministic bytes
and ETags on demand. Historical age changes revalidation time, not correction semantics.

| Class               | Origin TTL | Browser/shared response policy                        |
| ------------------- | ---------: | ----------------------------------------------------- |
| Live tail           | 10 seconds | `max-age=5, s-maxage=15, stale-while-revalidate=30`   |
| Recent/correctable  |  5 minutes | `max-age=60, s-maxage=300, stale-while-revalidate=60` |
| Older than 24 hours |  5 minutes | `max-age=60, s-maxage=300, must-revalidate`           |

Canonical responses have deterministic JSON serialization and a strong SHA-256 ETag. A cached
`If-None-Match` request returns 304 without another SQLite query. `/api/status` exposes aggregate LRU
statistics plus historical chunk hit/miss, query count, and query-time counters. Hashed frontend
assets are immutable for one year; `index.html` always revalidates. Transient errors use `no-store`.

## Cloudflare Cache Rule

Cloudflare control-plane credentials were not available during implementation. Create this Cache
Rule ahead of the general API bypass rule:

```text
Name: ERCOT canonical historical tiles
Expression:
  (http.host eq "ercot.tarazevits.io" and
   http.request.method eq "GET" and
   starts_with(http.request.uri.path, "/api/v2/tiles/"))
Cache eligibility: Eligible for cache
Edge TTL: Use cache-control header if present
Browser TTL: Respect origin
Cache key: Standard query-string cache key; do not ignore query parameters
Respect strong ETags: Enabled
```

Retain or add a separate static-assets rule for `/assets/*` that respects the origin one-year
immutable policy. Do not cache other `/api/*` traffic by default.

After activation, use Cloudflare Trace with a canonical tile URL and confirm the rule matches. Then
request the same URL twice and verify `CF-Cache-Status: MISS` followed by `HIT` (or a validated 304
path), the strong ETag remains stable, and the receiver query counter does not increase on the edge
hit. Verify a corrected range revalidates to changed bytes while an unrelated range remains stable.
