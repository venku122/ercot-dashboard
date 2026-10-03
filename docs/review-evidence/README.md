# Review evidence index

Date: 2026-08-27  
Scope: PR #33 through PR #55  
Fixture policy: deterministic synthetic evidence only

## Primary review artifacts

- `../2026-08-27--ercot-observatory-technical-human-review.md` - source technical report
- `../../output/pdf/2026-08-27--ercot-observatory-technical-human-review.pdf` - 26-page rendered packet
- `../2026-08-27--ercot-observatory-review-remediation-handoff.txt` - deployment and rollback handoff
- `2026-08-27--performance-matrix.md` - human-readable 300-window benchmark
- `2026-08-27--tile-reuse-benchmark.json` - machine-readable benchmark
- `2026-08-27--tile-reuse-benchmark.csv` - flat range metrics
- `2026-08-27--stack-range-diff.txt` - old persisted-tile stack versus remediated stack
- `2026-08-27--pr-topology.json` and `.txt` - live GitHub base/head snapshot for PR #33-#55

The topology snapshot was captured before the evidence commits were pushed, so the PR #55 row is the
remote pre-packet head. Embedding the commit that contains its own SHA is self-referential; reviewers
must compare the live PR #55 `headRefOid` with the exact head reported in the final handoff/CI run.

## Architecture diagrams

Each diagram is committed as DOT source plus PNG and SVG renderings.

1. `diagrams/01-system-context.*`
2. `diagrams/02-canonical-tile-request-paths.*`
3. `diagrams/03-restart-and-correction.*`
4. `diagrams/04-frontend-tile-planner.*`
5. `diagrams/05-data-provenance-and-semantics.*`
6. `diagrams/06-deployment-and-rollback.*`

## Visual evidence

`visuals/` contains 28 curated images: desktop Chromium and iPhone Pro Max WebKit for each of 14
populated surfaces. Every image is deterministic synthetic fixture evidence. Forecast Quality and
Net Load carry an explicit in-image synthetic banner; the other fixtures are labeled in their
Playwright sources and in the technical packet.

## Executable evidence

- `scripts/test_tile_restart_no_persistence.py` - separate-process restart, identical bytes/ETag,
  no `tile_resources`, and no artifact file.
- `scripts/benchmark_tile_reuse.py` and `scripts/test_benchmark_tile_reuse.py` - production planner,
  300 windows, cold/warm receiver, concurrency, correction, navigation traces, JSON/CSV outputs.
- `e2e/review-evidence.spec.ts` and `e2e/mobile-review-evidence.spec.ts` - populated desktop/mobile
  evidence with strict production parsers and exact-table checks.

## Final local validation

- `pnpm run check`: PASS, zero lint warnings.
- Frontend Vitest: 55 files, 331 tests PASS.
- Receiver: 266 tests PASS (known test-only SQLite `ResourceWarning`s remain).
- Script contracts: 20 tests PASS.
- Collector Docker test target: PASS.
- Production frontend build: PASS, 419 modules.
- Receiver Docker image build: PASS.
- Desktop Chromium: 50 tests PASS.
- iPhone Pro Max WebKit: 44 tests PASS.
- Production and development Compose expansion: PASS with a non-secret review placeholder for the
  required production ingest key.
- Secret scan: `gitleaks` unavailable; bounded tracked-file pattern scan found only named fields and
  synthetic fixture values, no candidate credential.
- PDF QA: 26 pages, rendered through Poppler, contact-sheet and representative-page visual review,
  text extraction confirms status, scope limit, performance, and non-deployment statements.

No merge, deployment, Portainer update, production SQLite mutation, collector enablement,
Cloudflare change, or DNS change was performed.
