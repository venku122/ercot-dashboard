# Release smoke modes and bounded production observation

Three modes remain separate: deterministic fixture-backed candidate; local receiver-backed candidate with bounded source/fixture provenance; actual read-only public deployment.

Reproduce local fixture acceptance: `PLAYWRIGHT_PORT=4303 pnpm exec playwright test e2e/post-release-smoke.spec.ts e2e/homepage.spec.ts e2e/homepage-responsive.spec.ts e2e/chart-live-interaction.spec.ts --project=chromium`. Loopback-only production preview; no attachment to existing services. New revision metadata is a non-secret Git head in HTML; dirty-tree changes are separately recorded and the final build must follow final commit.

Public API observation requires explicit opt-in: `python3 scripts/release_smoke.py --origin https://ercot.tarazevits.io --production-read-only --output artifacts/post-release/production-api.json`. Fixed public host, GET-only positive path allowlist, no redirects, six requests maximum, 60 seconds total, ten seconds per request, two MB per response, 6h/100-point pricing sample. Unknown hosts/credentials/ambiguous paths/query fields and unbounded history are rejected before networking. An externally supplied URL cannot redirect destructive tests to production.

October 3 baseline: actual Chrome public Overview at 24h/expanded rendered demand 57.9 GW, derived headroom 17.9 GW, PRC 12.6 GW, Houston $43.10/MWh and frequency 60.015 Hz. Main plot had 598 observations, price 93; loaded frontend asset `index-BgBqD5J8.js`. This is an asset identity, not a proven Git revision. Frontend/receiver/collector deployment revisions remain unknown. The urllib API probe returned HTTP 403 / Cloudflare 1010; this transport is blocked, not a reproduced application data outage. Browser data was not substituted with fixtures. No cache/infrastructure changes warranted from this observation.

Baseline browser screenshot is in `evidence/production-overview-baseline.png`; raw sanitized DOM retained locally. Final local/new code and unchanged production are reported separately. Production polling ends when observation tab closes.
