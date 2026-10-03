# Canonical tile reuse and receiver performance matrix

Date: 2026-08-27  
Seed: `20260827`  
Fixture: deterministic synthetic SQLite, 430 days, 247,680 observations, two physical series  
Planner: production `frontend/src/dashboard/tile-planner.ts`  
Mutation boundary: no production system, database, cache, DNS, or Cloudflare change

## 300-window planner and receiver benchmark

Each row contains 50 overlapping windows. Cold means an explicitly empty receiver LRU; warm means
the same process after all unique canonical URLs for that range were loaded. OS page-cache state was
not controlled. Latencies include the in-process handler path and deterministic JSON generation; they
are not WAN measurements.

| Range | v2 refs | Unique URLs | App cache hit | Reuse factor |   Cold p50/p95/p99 ms |   Warm p50/p95/p99 ms | Cold SQL statements | Warm SQL statements |     Bytes |
| ----- | ------: | ----------: | ------------: | -----------: | --------------------: | --------------------: | ------------------: | ------------------: | --------: |
| 6h    |     105 |          30 |         71.4% |        3.50x | 1.292 / 6.635 / 7.137 | 0.266 / 1.157 / 1.175 |                  90 |                   0 |   754,888 |
| 24h   |     238 |          81 |         66.0% |        2.94x | 1.038 / 5.630 / 5.737 | 0.277 / 1.088 / 1.130 |                 243 |                   0 |   769,168 |
| 7d    |     676 |         100 |         85.2% |        6.76x | 1.039 / 5.646 / 5.832 | 0.281 / 1.082 / 1.107 |                 300 |                   0 | 1,407,046 |
| 30d   |   1,826 |         123 |         93.3% |       14.85x | 1.054 / 5.469 / 5.611 | 0.281 / 1.077 / 1.087 |                 369 |                   0 | 1,263,669 |
| 90d   |   4,826 |         183 |         96.2% |       26.37x | 1.801 / 5.434 / 5.664 | 0.353 / 1.108 / 1.195 |                 549 |                   0 | 1,761,129 |
| 1y    |  18,576 |         459 |         97.5% |       40.47x | 1.857 / 2.259 / 5.583 | 0.371 / 0.415 / 1.102 |               1,377 |                   0 | 4,134,745 |

## Interpretation

- Across all 300 windows, v2 issued 26,247 URL references to 623 unique canonical URLs, a 42.13x
  same-navigation reuse factor.
- The old v1 comparison produced 554 unique URLs. v2 therefore has 69 more unique URLs in this
  workload, not fewer. This is expected from exact native edge tiles around unaligned windows and is
  reported rather than hidden.
- The relevant reuse gain is application-level canonical URL coalescing: 66.0% to 97.5% across the
  six ranges, with the largest gains in long overlapping windows.
- Every warm run performed zero SQLite statements and zero tile generations.
- Ten simultaneous requests for the same key produced one leader, nine waiters, and one SQLite
  generation. Two simultaneous different keys produced two leaders, no waiters, and two generations.
- Restart proof: a fresh process reported MISS and one SQLite generation, returned byte-identical
  content and the same strong ETag, and created neither a `tile_resources` table nor tile files.
- Correction proof: the intersecting tile missed and changed bytes/ETag; an unrelated tile stayed a
  byte-identical HIT with the same ETag.

## Navigation traces

| Trace                        | Steps | Total refs | Unique URLs | Reused refs | Reuse factor |
| ---------------------------- | ----: | ---------: | ----------: | ----------: | -----------: |
| A: short-window pan/zoom     |     6 |         53 |          39 |          14 |       1.359x |
| B: repeated adjacent windows |     4 |         32 |          19 |          13 |       1.684x |
| C: long-window overlap       |     4 |        519 |         366 |         153 |       1.418x |
| D: cross-series selection    |     4 |         14 |           9 |           5 |       1.556x |

Machine-readable evidence:

- `2026-08-27--tile-reuse-benchmark.json`
- `2026-08-27--tile-reuse-benchmark.csv`
