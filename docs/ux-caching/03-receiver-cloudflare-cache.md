# Receiver and Cloudflare cache architecture

## Resource model

`GET /api/v1/series/chunk` is the canonical, shared-cacheable historical resource. It accepts a
metric, normalized repeated `tag` values, aligned `start`/`end`, `chunk_seconds` (`3600` or `86400`),
resolution, aggregation, and optional rollup. The frontend sorts and deduplicates tags and emits
defaults explicitly, so equivalent requests converge on one URL.

Fixed windows without comparison are assembled in the browser from day chunks that are beyond the
24-hour correction horizon and hour chunks inside it. Live and comparison requests retain the batch
POST path because they are mutable and benefit from one request.

The receiver stores processed chunk results in the bounded in-process LRU. Entries carry the metric
and exact half-open time range they depend on. Ingest invalidates an entry only when an inserted or
corrected observation intersects that range; unrelated live ingest does not evict sealed history.

| Class                        | Origin TTL | Browser/shared response policy                        |
| ---------------------------- | ---------: | ----------------------------------------------------- |
| Live tail                    | 10 seconds | `max-age=5, s-maxage=15, stale-while-revalidate=30`   |
| Recent/correctable           |  5 minutes | `max-age=60, s-maxage=300, stale-while-revalidate=60` |
| Sealed (older than 24 hours) |   24 hours | `max-age=3600, s-maxage=86400, immutable`             |

Canonical responses have deterministic JSON serialization and a strong SHA-256 ETag. A cached
`If-None-Match` request returns 304 without another SQLite query. `/api/status` exposes aggregate LRU
statistics plus historical chunk hit/miss, query count, and query-time counters. Hashed frontend
assets are immutable for one year; `index.html` always revalidates. Transient errors use `no-store`.

## Cloudflare Cache Rule

Cloudflare control-plane credentials were not available during implementation. Create this Cache
Rule ahead of the general API bypass rule:

```text
Name: ERCOT canonical historical chunks
Expression:
  (http.host eq "ercot.tarazevits.io" and
   http.request.method eq "GET" and
   http.request.uri.path eq "/api/v1/series/chunk")
Cache eligibility: Eligible for cache
Edge TTL: Use cache-control header if present
Browser TTL: Respect origin
Cache key: Standard query-string cache key; do not ignore query parameters
Respect strong ETags: Enabled
```

Retain or add a separate static-assets rule for `/assets/*` that respects the origin one-year
immutable policy. Do not cache other `/api/*` traffic by default.

After activation, use Cloudflare Trace with a canonical chunk URL and confirm the rule matches. Then
request the same sealed URL twice and verify `CF-Cache-Status: MISS` followed by `HIT` (or a validated
304 path), the strong ETag remains stable, and the receiver query counter does not increase on the
edge hit. Verify a recent/hour chunk honors its shorter TTL independently.
