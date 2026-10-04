# Campaign execution ledger

Plan: implementation-plan.md. Spec: approved supplied AGENT_DIRECTIVE.md.
Baseline 1dc9906ee73a97805d38561de7d79bf424592234, fetched 2026-10-03 America/Chicago.
Baseline validate:commit PASS: 444 frontend, 267 receiver, 27 contract tests; all static/format checks pass.
Original dirty checkout untouched. Native isolated worktree registered with chat.
Task 1 ERP-12: all 13 actual issues created/reused and read back; legacy review pending.
Ruling: approved directive is execution specification; retain its branch names and one final human review rather than repeat design approvals.
Preflight interfaces: ERP-02 metadata feeds ERP-03/04/05 cursor/rendering; ERP-08 source inventory feeds ERP-04/05; ERP-10 UI primitives feeds ERP-07; ERP-06 measures completed ERP-07; ERP-09 refreshes all final evidence. No changed meaning under legacy identity allowed.

Task 2 ERP-11: current-status entry and historical pointers committed 5560c81; pre-commit complete suites PASS. Draft PR #74.
Task 3 ERP-01: read-path safety 4 regressions PASS; build-identity browser regression observed RED (absent metadata), then 27 Chromium smoke/homepage/lifecycle/geometry cases PASS. Current controlled baseline cold median 3018 ms, pointer proxy p95 34 ms; numeric cold gate not yet met (ERP-06). Public Chrome showed actual populated values; direct urllib API transport blocked HTTP403/Cloudflare1010. Screenshot identifies observation scope, not deployed SHA.

Task 4 ERP-02: implementation f21f9c5 integrated as 55b20f2. Model/policy source inventories and regressions: 453 frontend tests, 267 receiver/27 contracts and 10 focused browser tests in isolated worktree. Exact integrated validation rerun follows ledger formatting. Current/compare gaps, cursor age, aggregate resolution, unknown cadence and immutable-array copies are independently covered.
