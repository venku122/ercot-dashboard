# Current ERCOT Dashboard status

Observed October 3, 2026, America/Chicago. This entry separates repository state, local validation, source capability, and production observation.

- Observed main: `1dc9906ee73a97805d38561de7d79bf424592234` (fresh fetch).
- Candidate: [post-release stack](post-release/stack.json); each row records its tested head and draft PR.
- Campaign: [ERP-00](https://github.com/venku122/ercot-dashboard/issues/60), [all 12 child issues](post-release/issue-map.json).
- Local baseline: static checks, 444 frontend / 267 receiver / 27 contract tests PASS on main in macOS arm64, Node 25.8.2, pnpm 10.30.3, Python 3.14.3. [Baseline metadata](post-release/baseline.json).
- Deployed frontend revision: **DEPLOYED_REVISION_UNKNOWN**. Receiver and collector revisions, image digests, configured optional feed flags and production schema: **unknown** pending observed evidence. Public page access alone does not identify deployment.
- Implementation acceptance: **IN_PROGRESS**. Draft creation never closes an implementation issue or proves production readiness.
- Source support and health: [source/panel matrix](post-release/source-panel-matrix.md) when generated; code capability does not prove configured enablement or live delivery.
- Performance: old 2,948 ms cold median / 35 ms pointer p95 are historical fixture measurements, not current acceptance. Current campaign measurements must identify build/environment/readiness and enforce 2,500/50 ms budgets.
- Manual acceptance: screen-reader sessions and physical iPhone Safari remain **NOT_RUN** until real device/reviewer evidence is recorded.
- Promotion: **DEFERRED_PROMOTION**; no merge/deploy/production feed activation/database change is authorized in this campaign.

## Architecture authority

SQLite observations are authoritative. Generic canonical chart tiles are generated into a bounded receiver LRU and downstream HTTP/browser caches, with deterministic regeneration and correction-aware invalidation. No generic persisted tile bodies, tile_resources store, exact-version child routes or Content-Location pointers. [August 27 correction](2026-08-27--ercot-observatory-review-remediation-handoff.txt) supersedes August 26 generic persistence guidance. Immutable forecast vintages and reviewed domain publications preserve their distinct contracts.

## Validation and next decision

Current commands: `pnpm install --frozen-lockfile`, `pnpm run validate:commit`, `pnpm run build`, `pnpm run test:collector`, `pnpm run test:performance`, browser projects in `playwright.config.ts`. Validate test discovery with `--list`. Receiver performance is distinct from homepage numeric acceptance. Live checks require explicit opt-in and positive read-path allowlisting.

Next human decision: inspect the completed local candidate and final acceptance packet once all unblocked work finishes. Review/merge and later production promotion remain separate decisions.

[Campaign progress](post-release/progress.md) · [Historical report](overview-chart-first/verification-summary.md)
