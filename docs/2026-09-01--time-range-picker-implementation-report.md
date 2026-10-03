# Time Range Picker implementation report

> Historical implementation report. PR #56's DRUIDS-conformant replacement is governed by `2026-09-03--datadog-time-range-picker-compatibility-contract.md`.

## Outcome

The ERCOT dashboard now uses a controlled semantic `TimeRangePicker` backed by a reusable TypeScript/React source module in `frontend/src/time-range/`. Semantic selections are resolved against an injected clock, encoded canonically in the URL, and converted from epoch milliseconds to the dashboard's seconds boundary only in `frontend/src/dashboard/time-range-adapter.ts`.

The work is stacked on PR #55's exact head `79d77ecfc4561bc8e1d48893add72a19337e291f` on branch `codex/time-range-picker`. It does not merge or deploy the stack.

## Implementation

- Pure core: relative, growing, calendar, paused, and fixed-origin domain values; IANA/DST wall-time resolution; validation; formatting; navigation; compare shifting; and a time-only URL codec.
- Controlled React boundary: one desktop/mobile editor with consumer presets, calendar options, zones, bounds, locale, labels, validation formatting, classes, portal theming, and commit callbacks.
- ERCOT adapter: legacy URL parsing plus canonical semantic serialization, explicit milliseconds-to-seconds conversion, and compatibility with existing query, compare, Chart.js, SWR, tile/chunk, and live-tail paths.
- Fetch safety: abort plus generation guards; captured prior data for incremental live-tail requests; old data remains visibly transitional and paired with its old domain until the matching replacement commits.
- Chart integration: drag/pan/zoom completion creates fixed `origin=zoom` state, with fractional chart-scale timestamps rounded to integer epoch milliseconds.
- No new runtime dependency and no workspace/package conversion.

## Baseline and delta

Baseline validation on the isolated PR #55 worktree passed check, frontend, receiver, contract, performance, and production-build gates. The baseline production main bundle was 441.55 kB / 132.12 kB gzip and CSS was 82.53 kB / 15.62 kB gzip.

Final production output is 460.97 kB / 137.98 kB gzip for main JS and 85.11 kB / 16.16 kB gzip for CSS. Main-JS growth is 5.86 KiB gzip, below the frozen 25 KiB blocker threshold.

## Validation

- `pnpm run validate:commit`: PASS — typecheck, lint, formatting, 60 frontend files / 367 tests, 266 receiver tests, 20 contract tests.
- `pnpm run test:performance`: PASS — 105,120 rows and all cache/dedupe/query assertions.
- `pnpm run build`: PASS.
- Full Playwright matrix: PASS — 144 tests across desktop Chromium, desktop WebKit keyboard coverage, mobile Chromium, iPhone WebKit, landscape WebKit, and iPad WebKit.
- Focused Chromium zoom/lazy regression tests: PASS.
- Keyboard-only picker path: PASS in Chromium and desktop WebKit.
- Existing and refreshed visual baselines: PASS on desktop and mobile WebKit matrices.

## Scope audit

No package was published. No production service, database, collector, Cloudflare resource, deployment, or PR merge was changed. Existing dirty worktrees were preserved; implementation occurred in an isolated worktree.
