# Disposable local review runtime

Run from the final candidate worktree:

```sh
pnpm run build
python3 scripts/serve_review_receiver.py --port 4315 --days 7
```

Open <http://127.0.0.1:4315/>. The page has an explicit **SYNTHETIC** banner;
`/review-fixture.json` describes the seeded interval, identities and row count.
All requests go through the actual candidate receiver and its normal SQLite
queries, pairing, canonical transport, cache and static assets. There are no
mock API handlers or collectors. The server binds only to loopback, creates
its own temporary database, and deletes that database on shutdown.

The fixture provides seven days of physical series at their catalog cadence,
with signed storage, independent PRC, fuel mix, legacy collection prices,
frequency, outages and renewables. Supply/capacity headroom is calculated by
the receiver from these seeded contributors. Review 6h, 24h and 7d windows,
Inspect, cursor/pin, legends, accessible tables and CSV. A comparison extending
before the seed interval correctly has incomplete collection coverage.
`--days 31` expands the synthetic history for longer local inspection.

Optional domain publications and historical forecast vintages are not seeded:
their genuine never-collected/unavailable states remain visible. Their populated,
partial, stale and failure cases are separately exercised by deterministic
browser fixtures and captured-source rehearsals in the acceptance packet.
This runtime does not establish source availability or production acceptance.
Its banner adds vertical space; geometry and controlled cold-load acceptance
use the unmodified candidate page in the recorded browser tests.

Rebuild and restart after changing candidate code. The printed seed time is
fixed for each run; as it ages, the normal freshness states age with it.
