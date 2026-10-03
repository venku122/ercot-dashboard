# Time Range Picker acceptance contract

Status: frozen before implementation on 2026-09-01; evaluated PASS after implementation and adversarial remediation on 2026-09-02.

## Execution target and baseline

- Repository: `venku122/ercot-dashboard`
- Integration point: draft PR #55, `ercot-observatory/23-integrated-hardening-handoff`
- Base/head before this work: `79d77ecfc4561bc8e1d48893add72a19337e291f`
- Feature branch: `codex/time-range-picker`
- Isolated worktree: `/Users/tjt/src/agents/projects/ercot-dashboard-time-range-picker`
- Primary and Observatory worktrees were already dirty and were not changed.
- Node: `v25.8.2`; pnpm: `10.30.3`
- `pnpm run check`: PASS
- `pnpm run test:frontend`: PASS, 55 files and 331 tests
- `pnpm run test:receiver`: PASS, 266 tests; pre-existing unclosed-SQLite `ResourceWarning`s remain visible
- `pnpm run test:contracts`: PASS, 20 tests
- `pnpm run test:performance`: PASS
- `pnpm run validate:commit`: PASS
- `pnpm run build`: PASS; main JS 441.55 kB / 132.12 kB gzip, CSS 82.53 kB / 15.62 kB gzip
- Focused browser validation was moved to isolated ports through `PLAYWRIGHT_PORT`; no preserved worktree or service was stopped or changed.

## Product decisions frozen by this contract

1. The generic core uses epoch milliseconds. The only milliseconds-to-ERCOT-seconds conversion is the dashboard adapter.
2. A semantic selection and its resolved window are separate values. A fixed window records `custom`, `zoom`, or `navigation` origin.
3. Pausing a live-capable selection serializes both its semantic selection and exact frozen endpoints. Resuming re-resolves the same selection at the new clock time.
4. Reset Live restores the latest relative, growing, or calendar selection; the fallback is Past 6 hours.
5. Fall-back ambiguity is explicit: the user chooses the earlier or later occurrence. Nonexistent wall times are rejected.
6. The canonical URL uses semantic time fields. Legacy `range`, `live`, `from`, `to`, and `paused` links remain readable and safely bounded.
7. Calendar expressions are resolved in the selected IANA timezone. Fixed instants do not move when the display timezone changes; calendar expressions do re-resolve.
8. The reusable module is a self-contained source module, not a new workspace package. This avoids an invasive repository conversion while retaining core, React, styles, and public entrypoint boundaries.
9. No new runtime dependency is planned. `Intl.DateTimeFormat` plus bounded candidate discovery will implement zone conversion and ambiguity detection.
10. The existing Chart.js, SWR, tile/chunk, live-tail, max-points, compare, and interaction-policy architecture remains authoritative.

## Release-gate matrix

The result column is now `PASS` after exact implementation-head validation. Test names are stable evidence identifiers; unavoidable visual/manual evidence is linked in the final matrix.

| ID           | Frozen criterion                                                                                                  | Planned automated evidence                        | Result |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ |
| TR-DOM-001   | Semantic selection remains distinct from resolved endpoints and fixed origin.                                     | `time-range/core.test.ts` semantic identity cases | PASS   |
| TR-DOM-002   | Relative resolves to `now - duration` through `now` and is live while running.                                    | core relative resolver                            | PASS   |
| TR-DOM-003   | A running relative range ticks without changing selection.                                                        | controller tick case                              | PASS   |
| TR-DOM-004   | Selecting a relative preset from historical state returns to current live time.                                   | transition test and E2E preset case               | PASS   |
| TR-DOM-005   | Pause freezes resolved endpoints and retains resumable semantics.                                                 | pause state-machine test                          | PASS   |
| TR-DOM-006   | Resume restores the same live semantic selection at the new clock.                                                | pause/resume clock test and E2E                   | PASS   |
| TR-DOM-007   | Explicit From/To produces a non-ticking fixed custom range.                                                       | core and component Apply tests                    | PASS   |
| TR-DOM-008   | Zoom produces fixed origin `zoom` and an honest fixed label.                                                      | adapter/zoom test and E2E                         | PASS   |
| TR-DOM-009   | Previous/Next preserves exact duration and stays fixed.                                                           | navigation unit and E2E                           | PASS   |
| TR-DOM-010   | Reset restores last meaningful live selection or Past 6 hours.                                                    | reset state-machine tests                         | PASS   |
| TR-DOM-011   | Growing `Since` runs, pauses, and resumes correctly.                                                              | core growing resolver tests                       | PASS   |
| TR-DOM-012   | Today, Yesterday, WTD, MTD, previous week/month, and YTD are supported.                                           | calendar resolver table                           | PASS   |
| TR-DOM-013   | Calendar boundaries are IANA-zone aware, not fixed 24-hour math.                                                  | DST calendar tests                                | PASS   |
| TR-DOM-014   | Configurable min/max duration defaults to 5 minutes/365 days for ERCOT.                                           | validation and config tests                       | PASS   |
| TR-DOM-015   | Epoch units are explicit; the ERCOT conversion is centralized.                                                    | type/API inspection and adapter tests             | PASS   |
| TR-TZ-001    | The module accepts an IANA timezone; ERCOT defaults to Chicago.                                                   | config and invalid-zone tests                     | PASS   |
| TR-TZ-002    | Resolved/query windows are absolute instants.                                                                     | resolver/adapter tests                            | PASS   |
| TR-TZ-003    | Fixed timezone change preserves instants.                                                                         | timezone transition test                          | PASS   |
| TR-TZ-004    | Relative timezone change preserves duration and instant window.                                                   | timezone transition test                          | PASS   |
| TR-TZ-005    | Calendar timezone change re-resolves its expression.                                                              | timezone transition test                          | PASS   |
| TR-TZ-006    | `2026-03-08 02:30` Chicago is rejected as nonexistent.                                                            | wall-time parser test and E2E validation          | PASS   |
| TR-TZ-007    | `2026-11-01 01:30` Chicago requires earlier/later choice.                                                         | ambiguity parser/component test                   | PASS   |
| TR-TZ-008    | Spring/fall local days resolve to 23/25 hours.                                                                    | calendar duration tests                           | PASS   |
| TR-TZ-009    | Calendar day/week shifting remains calendar-relative across DST.                                                  | shift and compare tests                           | PASS   |
| TR-TZ-010    | Leap day resolves and navigates correctly.                                                                        | 2028-02-29 tests                                  | PASS   |
| TR-UI-001    | One coherent picker replaces the preset select and custom disclosure.                                             | component DOM and E2E                             | PASS   |
| TR-UI-002    | Trigger label describes relative/calendar/fixed/growing/paused semantics honestly.                                | label unit/component table                        | PASS   |
| TR-UI-003    | Live/paused state is visible and accessible without color alone.                                                  | component semantic assertions                     | PASS   |
| TR-UI-004    | Presets are configurable and ERCOT retains 1h/6h/12h/24h/3d/7d/30d/12mo.                                          | second-consumer and ERCOT config tests            | PASS   |
| TR-UI-005    | Calendar presets are logically grouped.                                                                           | component DOM assertions                          | PASS   |
| TR-UI-006    | Custom editor exposes From, To, and active timezone.                                                              | component/E2E                                     | PASS   |
| TR-UI-007    | Draft edits do not commit or fetch before Apply.                                                                  | component commit count and request trace          | PASS   |
| TR-UI-008    | Cancel/close preserves committed value exactly.                                                                   | component/E2E                                     | PASS   |
| TR-UI-009    | Specific validation errors are associated with fields.                                                            | validation table/component assertions             | PASS   |
| TR-UI-010    | Desktop uses an accessible compact popover.                                                                       | Chromium keyboard/semantic E2E                    | PASS   |
| TR-UI-011    | Mobile uses an accessible sheet/dialog.                                                                           | mobile/WebKit E2E                                 | PASS   |
| TR-UI-012    | Desktop/mobile share model, resolver, validator, and commit behavior.                                             | import boundary and shared component tests        | PASS   |
| TR-UI-013    | Keyboard open, traversal, selection, Apply/Cancel, Escape, and focus restore work.                                | keyboard-only E2E                                 | PASS   |
| TR-UI-014    | Accessible names, states, groups, errors, and dialog semantics are correct.                                       | component semantics and browser assertions        | PASS   |
| TR-UI-015    | Applicable mobile targets are at least 44x44 CSS px.                                                              | mobile target E2E                                 | PASS   |
| TR-UI-016    | Picker creates no mobile horizontal overflow.                                                                     | responsive E2E                                    | PASS   |
| TR-UI-017    | Picker remains usable with reduced motion.                                                                        | reduced-motion E2E                                | PASS   |
| TR-UI-018    | No heavyweight date-picker dependency is added without a blocker review.                                          | lockfile/bundle inspection                        | PASS   |
| TR-URL-001   | Every supported semantic range round-trips without meaning loss.                                                  | generic codec table                               | PASS   |
| TR-URL-002   | Fixed instants round-trip exactly to millisecond precision.                                                       | codec tests                                       | PASS   |
| TR-URL-003   | Shared relative URLs remain relative when opened later.                                                           | codec/integration tests                           | PASS   |
| TR-URL-004   | Calendar URLs preserve expression and timezone.                                                                   | codec tests                                       | PASS   |
| TR-URL-005   | Paused URLs restore semantic selection and exact frozen window.                                                   | codec and reload E2E                              | PASS   |
| TR-URL-006   | Legacy range/live/from/to/paused links continue to parse.                                                         | legacy adapter table and E2E                      | PASS   |
| TR-URL-007   | Legacy links may canonicalize only after safe parsing.                                                            | integration URL test                              | PASS   |
| TR-URL-008   | Non-time parameters remain intact.                                                                                | dashboard URL composition test                    | PASS   |
| TR-URL-009   | Malformed, huge, negative, and non-finite values are bounded/rejected.                                            | malicious URL table                               | PASS   |
| TR-CHART-001 | Chart.js remains the renderer.                                                                                    | dependency/diff inspection                        | PASS   |
| TR-CHART-002 | Completed zoom/pan commits one fixed global window.                                                               | callback count and E2E                            | PASS   |
| TR-CHART-003 | Intermediate gesture activity causes no request storm.                                                            | browser request trace                             | PASS   |
| TR-CHART-004 | Chart and global reset cannot leave a stale x-domain.                                                             | chart E2E                                         | PASS   |
| TR-CMP-001   | Off, prior period/day/week, and custom offset remain functional.                                                  | compare unit/integration/E2E                      | PASS   |
| TR-CMP-002   | Compare derives from committed resolved state, never picker draft.                                                | component/request integration                     | PASS   |
| TR-CMP-003   | Previous period is the exact prior equal-duration interval.                                                       | compare unit test                                 | PASS   |
| TR-CMP-004   | Previous day/week stay calendar/DST aware in Chicago.                                                             | compare DST tests                                 | PASS   |
| TR-CMP-005   | Compare plus zoom yields aligned current/prior windows.                                                           | integration and E2E                               | PASS   |
| TR-PERF-001  | Opening/editing a draft emits zero time-driven data requests.                                                     | request-count E2E                                 | PASS   |
| TR-PERF-002  | A selection Apply emits one committed state transition.                                                           | component callback count                          | PASS   |
| TR-PERF-003  | Obsolete range work is aborted or generation guarded.                                                             | abort/race unit and E2E                           | PASS   |
| TR-PERF-004  | Old data cannot settle as final data for a newer range.                                                           | controlled deferred-response test                 | PASS   |
| TR-PERF-005  | Server max-points/LOD controls remain active.                                                                     | API planner regression tests                      | PASS   |
| TR-PERF-006  | Fixed history continues through canonical tiles/chunks.                                                           | tile planner regression                           | PASS   |
| TR-PERF-007  | Live relative windows retain incremental tail fetching.                                                           | live-tail unit/integration                        | PASS   |
| TR-PERF-008  | Hidden/offline SWR refresh policy remains disabled.                                                               | configuration regression                          | PASS   |
| TR-PERF-009  | Before/after bundle sizes are recorded; >25 KiB gzip requires justification.                                      | production build evidence                         | PASS   |
| TR-PERF-010  | Twenty rapid commits leave correct URL/data without errors or listener growth.                                    | stress E2E                                        | PASS   |
| TR-PERF-011  | Local picker interaction requires no network or data traversal.                                                   | request trace and code inspection                 | PASS   |
| TR-MOD-001   | Generic core imports no ERCOT/dashboard code.                                                                     | import-boundary test                              | PASS   |
| TR-MOD-002   | Resolver, timezone, validation, presets, and codec test without React.                                            | pure Vitest suite                                 | PASS   |
| TR-MOD-003   | Public exports are small and intentional.                                                                         | public API test/documentation                     | PASS   |
| TR-MOD-004   | Presets, calendars, zones, bounds, locale/labels, callbacks, presentation, and styling are configurable.          | second-consumer test                              | PASS   |
| TR-MOD-005   | Styles are scoped and themeable without page selectors.                                                           | CSS/import inspection and fixture                 | PASS   |
| TR-MOD-006   | Multiple instances remain independent.                                                                            | component test                                    | PASS   |
| TR-MOD-007   | React picker is controlled and emits explicit commits.                                                            | component test                                    | PASS   |
| TR-MOD-008   | Module can be extracted without rewriting core logic.                                                             | structure/design review                           | PASS   |
| TR-MOD-009   | Nothing is published.                                                                                             | execution audit                                   | PASS   |
| TR-REG-001   | Views, charts, legends, events, inspect, history, external context, sources, compare, and dialogs do not regress. | existing frontend/browser suites                  | PASS   |
| TR-REG-002   | Existing accessibility/browser gates remain green.                                                                | full relevant Playwright suite                    | PASS   |
| TR-REG-003   | Receiver and cross-layer contracts remain green.                                                                  | receiver/contracts commands                       | PASS   |
| TR-REG-004   | Existing performance gates remain green.                                                                          | performance command                               | PASS   |
| TR-REG-005   | Testing causes no production side effect.                                                                         | execution audit                                   | PASS   |

## Blocking policy

Any Critical or High adversarial finding blocks GO. A Medium finding blocks GO when it affects correctness, accessibility, URL compatibility, race safety, or reusability. Cosmetic Medium findings may defer only with explicit rationale and no acceptance violation. The final exact head must be the re-reviewed head.

## Final evidence

> Superseded for PR #56 by the DRUIDS-conformance evidence in `2026-09-03--datadog-time-range-picker-compatibility-contract.md`. The results below describe the earlier picker head and are retained only as historical evidence.

- Reviewed implementation head: `eedc690` (stacked on `79d77ecfc4561bc8e1d48893add72a19337e291f`).
- Commit gate: PASS — 60 frontend files / 367 tests, 266 receiver tests, and 20 contract tests.
- Production build: PASS — main JS 460.97 kB / 137.98 kB gzip; CSS 85.11 kB / 16.16 kB gzip. Main-JS growth from baseline is 5.86 KiB gzip, below the 25 KiB blocker threshold.
- Receiver performance benchmark: PASS — 105,120-row workload, sealed-cache survival, dedupe, SQL, and raw-history checks completed.
- Full Playwright matrix: PASS — 144 tests across desktop Chromium, desktop WebKit keyboard coverage, mobile Chromium, iPhone WebKit, landscape WebKit, and iPad WebKit.
- Independent adversarial roles A–F: PASS after remediation. See `2026-09-01--time-range-picker-adversarial-review.md`.
- Execution audit: no merge, deployment, package publication, collector activation, database mutation, Cloudflare change, or production mutation occurred.
