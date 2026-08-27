# Comparison tiles and application reuse

PR07 extends the canonical v2 tile path from selected fixed history to fixed
comparisons and adds bounded application-level reuse. It does not change the
tile wire format, aggregate algebra, or live-tail transport.

## Acceptance window

The deterministic golden window uses the production `TimeState` invariant
`rangeSeconds = end - start` and remains inclusive at both endpoints:

- selected: 2026-08-01 00:00:00 UTC through 2026-08-08 00:00:00 UTC;
- previous period: 2026-07-25 00:00:00 UTC through 2026-08-01 00:00:00 UTC.

Each side therefore uses seven aligned 15-minute daily interiors plus one
native endpoint tile. The shared August 1 timestamp intentionally appears in
two distinct canonical URLs because the selected interior and comparison edge
have different LODs. The fixture expects 16 URLs and eight observations on each
side; it does not invent an `end - 1` window to avoid the boundary.

For a cataloged physical series, both windows must use only `GET` requests to
the v2 catalog and canonical tile paths. A tile URL contains only semantic
series key, fixed `1h` or `1d` span, aligned epoch start, and fixed LOD. It has
no selected range, comparison mode, target-point count, query string, or
arbitrary resolution. A cataloged series must not send a v1 chunk or batch
request merely because comparison is enabled.

An unsupported fixed physical series may use compatibility loading, but both
selected and comparison windows must be canonical v1 chunk `GET`s. Fixed
comparison loading must not return to the historical `/api/series/batch` POST
path.

Comparison points are assembled from their own raw aggregate states, then
aligned to the selected window using the existing calendar/offset contract.
Statistics displayed for the selected series continue to come from selected
aggregate state rather than the comparison projection.

## Reuse contract

Reuse is keyed by the complete canonical URL and applies to both pending and
fulfilled tile reads:

- duplicate physical series across charts share one request;
- selected and comparison windows share any identical tile URL;
- overlapping dashboard loads share pending work and reuse fulfilled results;
- each consumer retains independent cancellation semantics.

Aborting one consumer must reject that consumer promptly, but must not cancel a
shared request that still has another subscriber. The surviving consumer must
receive the result, and a later consumer must be able to reuse the valid cached
value. An aborted or failed request must not poison the cache.

Reuse is an application optimization, not a correctness dependency. Missing,
malformed, expired, or evicted data follows the established atomic per-series
fallback behavior.

## Evidence

`frontend/src/dashboard/comparison-tile-reuse.test.ts` exercises the public
`loadSeries` boundary with an injected fetch fixture. It records method and URL
for every request and verifies:

- the directive's August 1–7 versus July 25–31 shorthand as the production-
  inclusive August 1 00:00 through August 8 00:00 and July 25 00:00 through
  August 1 00:00 windows, including both endpoint observations;
- literal UTC spring-forward and fall-back goldens for day, week,
  previous-period, and nonzero custom-offset comparisons, without using the
  production comparison helpers to construct expected windows or aligned
  timestamps;
- queryless canonical v2 GETs and no v1 request for mapped physical series;
- canonical v1 chunk GET fallback, with no POST, for an unsupported series;
- one fetch per canonical URL across duplicate charts and overlapping loads;
- one-consumer abort while a second consumer survives shared pending work;
- valid reuse after that cancellation race.

Run the focused evidence with:

```sh
pnpm exec vitest run frontend/src/dashboard/comparison-tile-reuse.test.ts
```

## Limits and PR08 handoff

The fixture is deterministic browser-runtime logic, not a production network or
Cloudflare cache measurement. It does not claim reuse across tabs, reloads,
processes, or deployments. It does not migrate live-tail requests or activate
an edge cache rule.

PR08 can use this stable comparison/history path for edge-cache rollout
preparation, cache observability, and direct cold/warm performance evidence. Its
acceptance should expose bounded application-cache metrics and cardinality,
measure cold and warm tile loads directly, and preserve semantic tile keys,
independent cancellation, and per-series compatibility fallback.
