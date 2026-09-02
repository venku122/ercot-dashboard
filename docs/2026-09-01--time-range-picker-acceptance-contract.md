# Time Range Picker acceptance contract

Status: frozen before implementation on 2026-09-01.

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
- Focused browser baseline: initially blocked because another preserved worktree owns port 3000. It must be rerun on an isolated port before implementation evidence is accepted.

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

The result column is intentionally `PENDING` until the exact final head is validated. Test names are stable planned evidence identifiers; unavoidable visual/manual evidence will be linked in the final matrix.

| ID           | Frozen criterion                                                                                                  | Planned automated evidence                        | Result  |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| TR-DOM-001   | Semantic selection remains distinct from resolved endpoints and fixed origin.                                     | `time-range/core.test.ts` semantic identity cases | PENDING |
| TR-DOM-002   | Relative resolves to `now - duration` through `now` and is live while running.                                    | core relative resolver                            | PENDING |
| TR-DOM-003   | A running relative range ticks without changing selection.                                                        | controller tick case                              | PENDING |
| TR-DOM-004   | Selecting a relative preset from historical state returns to current live time.                                   | transition test and E2E preset case               | PENDING |
| TR-DOM-005   | Pause freezes resolved endpoints and retains resumable semantics.                                                 | pause state-machine test                          | PENDING |
| TR-DOM-006   | Resume restores the same live semantic selection at the new clock.                                                | pause/resume clock test and E2E                   | PENDING |
| TR-DOM-007   | Explicit From/To produces a non-ticking fixed custom range.                                                       | core and component Apply tests                    | PENDING |
| TR-DOM-008   | Zoom produces fixed origin `zoom` and an honest fixed label.                                                      | adapter/zoom test and E2E                         | PENDING |
| TR-DOM-009   | Previous/Next preserves exact duration and stays fixed.                                                           | navigation unit and E2E                           | PENDING |
| TR-DOM-010   | Reset restores last meaningful live selection or Past 6 hours.                                                    | reset state-machine tests                         | PENDING |
| TR-DOM-011   | Growing `Since` runs, pauses, and resumes correctly.                                                              | core growing resolver tests                       | PENDING |
| TR-DOM-012   | Today, Yesterday, WTD, MTD, previous week/month, and YTD are supported.                                           | calendar resolver table                           | PENDING |
| TR-DOM-013   | Calendar boundaries are IANA-zone aware, not fixed 24-hour math.                                                  | DST calendar tests                                | PENDING |
| TR-DOM-014   | Configurable min/max duration defaults to 5 minutes/365 days for ERCOT.                                           | validation and config tests                       | PENDING |
| TR-DOM-015   | Epoch units are explicit; the ERCOT conversion is centralized.                                                    | type/API inspection and adapter tests             | PENDING |
| TR-TZ-001    | The module accepts an IANA timezone; ERCOT defaults to Chicago.                                                   | config and invalid-zone tests                     | PENDING |
| TR-TZ-002    | Resolved/query windows are absolute instants.                                                                     | resolver/adapter tests                            | PENDING |
| TR-TZ-003    | Fixed timezone change preserves instants.                                                                         | timezone transition test                          | PENDING |
| TR-TZ-004    | Relative timezone change preserves duration and instant window.                                                   | timezone transition test                          | PENDING |
| TR-TZ-005    | Calendar timezone change re-resolves its expression.                                                              | timezone transition test                          | PENDING |
| TR-TZ-006    | `2026-03-08 02:30` Chicago is rejected as nonexistent.                                                            | wall-time parser test and E2E validation          | PENDING |
| TR-TZ-007    | `2026-11-01 01:30` Chicago requires earlier/later choice.                                                         | ambiguity parser/component test                   | PENDING |
| TR-TZ-008    | Spring/fall local days resolve to 23/25 hours.                                                                    | calendar duration tests                           | PENDING |
| TR-TZ-009    | Calendar day/week shifting remains calendar-relative across DST.                                                  | shift and compare tests                           | PENDING |
| TR-TZ-010    | Leap day resolves and navigates correctly.                                                                        | 2028-02-29 tests                                  | PENDING |
| TR-UI-001    | One coherent picker replaces the preset select and custom disclosure.                                             | component DOM and E2E                             | PENDING |
| TR-UI-002    | Trigger label describes relative/calendar/fixed/growing/paused semantics honestly.                                | label unit/component table                        | PENDING |
| TR-UI-003    | Live/paused state is visible and accessible without color alone.                                                  | component semantic assertions                     | PENDING |
| TR-UI-004    | Presets are configurable and ERCOT retains 1h/6h/12h/24h/3d/7d/30d/12mo.                                          | second-consumer and ERCOT config tests            | PENDING |
| TR-UI-005    | Calendar presets are logically grouped.                                                                           | component DOM assertions                          | PENDING |
| TR-UI-006    | Custom editor exposes From, To, and active timezone.                                                              | component/E2E                                     | PENDING |
| TR-UI-007    | Draft edits do not commit or fetch before Apply.                                                                  | component commit count and request trace          | PENDING |
| TR-UI-008    | Cancel/close preserves committed value exactly.                                                                   | component/E2E                                     | PENDING |
| TR-UI-009    | Specific validation errors are associated with fields.                                                            | validation table/component assertions             | PENDING |
| TR-UI-010    | Desktop uses an accessible compact popover.                                                                       | Chromium keyboard/semantic E2E                    | PENDING |
| TR-UI-011    | Mobile uses an accessible sheet/dialog.                                                                           | mobile/WebKit E2E                                 | PENDING |
| TR-UI-012    | Desktop/mobile share model, resolver, validator, and commit behavior.                                             | import boundary and shared component tests        | PENDING |
| TR-UI-013    | Keyboard open, traversal, selection, Apply/Cancel, Escape, and focus restore work.                                | keyboard-only E2E                                 | PENDING |
| TR-UI-014    | Accessible names, states, groups, errors, and dialog semantics are correct.                                       | component semantics and browser assertions        | PENDING |
| TR-UI-015    | Applicable mobile targets are at least 44x44 CSS px.                                                              | mobile target E2E                                 | PENDING |
| TR-UI-016    | Picker creates no mobile horizontal overflow.                                                                     | responsive E2E                                    | PENDING |
| TR-UI-017    | Picker remains usable with reduced motion.                                                                        | reduced-motion E2E                                | PENDING |
| TR-UI-018    | No heavyweight date-picker dependency is added without a blocker review.                                          | lockfile/bundle inspection                        | PENDING |
| TR-URL-001   | Every supported semantic range round-trips without meaning loss.                                                  | generic codec table                               | PENDING |
| TR-URL-002   | Fixed instants round-trip exactly to millisecond precision.                                                       | codec tests                                       | PENDING |
| TR-URL-003   | Shared relative URLs remain relative when opened later.                                                           | codec/integration tests                           | PENDING |
| TR-URL-004   | Calendar URLs preserve expression and timezone.                                                                   | codec tests                                       | PENDING |
| TR-URL-005   | Paused URLs restore semantic selection and exact frozen window.                                                   | codec and reload E2E                              | PENDING |
| TR-URL-006   | Legacy range/live/from/to/paused links continue to parse.                                                         | legacy adapter table and E2E                      | PENDING |
| TR-URL-007   | Legacy links may canonicalize only after safe parsing.                                                            | integration URL test                              | PENDING |
| TR-URL-008   | Non-time parameters remain intact.                                                                                | dashboard URL composition test                    | PENDING |
| TR-URL-009   | Malformed, huge, negative, and non-finite values are bounded/rejected.                                            | malicious URL table                               | PENDING |
| TR-CHART-001 | Chart.js remains the renderer.                                                                                    | dependency/diff inspection                        | PENDING |
| TR-CHART-002 | Completed zoom/pan commits one fixed global window.                                                               | callback count and E2E                            | PENDING |
| TR-CHART-003 | Intermediate gesture activity causes no request storm.                                                            | browser request trace                             | PENDING |
| TR-CHART-004 | Chart and global reset cannot leave a stale x-domain.                                                             | chart E2E                                         | PENDING |
| TR-CMP-001   | Off, prior period/day/week, and custom offset remain functional.                                                  | compare unit/integration/E2E                      | PENDING |
| TR-CMP-002   | Compare derives from committed resolved state, never picker draft.                                                | component/request integration                     | PENDING |
| TR-CMP-003   | Previous period is the exact prior equal-duration interval.                                                       | compare unit test                                 | PENDING |
| TR-CMP-004   | Previous day/week stay calendar/DST aware in Chicago.                                                             | compare DST tests                                 | PENDING |
| TR-CMP-005   | Compare plus zoom yields aligned current/prior windows.                                                           | integration and E2E                               | PENDING |
| TR-PERF-001  | Opening/editing a draft emits zero time-driven data requests.                                                     | request-count E2E                                 | PENDING |
| TR-PERF-002  | A selection Apply emits one committed state transition.                                                           | component callback count                          | PENDING |
| TR-PERF-003  | Obsolete range work is aborted or generation guarded.                                                             | abort/race unit and E2E                           | PENDING |
| TR-PERF-004  | Old data cannot settle as final data for a newer range.                                                           | controlled deferred-response test                 | PENDING |
| TR-PERF-005  | Server max-points/LOD controls remain active.                                                                     | API planner regression tests                      | PENDING |
| TR-PERF-006  | Fixed history continues through canonical tiles/chunks.                                                           | tile planner regression                           | PENDING |
| TR-PERF-007  | Live relative windows retain incremental tail fetching.                                                           | live-tail unit/integration                        | PENDING |
| TR-PERF-008  | Hidden/offline SWR refresh policy remains disabled.                                                               | configuration regression                          | PENDING |
| TR-PERF-009  | Before/after bundle sizes are recorded; >25 KiB gzip requires justification.                                      | production build evidence                         | PENDING |
| TR-PERF-010  | Twenty rapid commits leave correct URL/data without errors or listener growth.                                    | stress E2E                                        | PENDING |
| TR-PERF-011  | Local picker interaction requires no network or data traversal.                                                   | request trace and code inspection                 | PENDING |
| TR-MOD-001   | Generic core imports no ERCOT/dashboard code.                                                                     | import-boundary test                              | PENDING |
| TR-MOD-002   | Resolver, timezone, validation, presets, and codec test without React.                                            | pure Vitest suite                                 | PENDING |
| TR-MOD-003   | Public exports are small and intentional.                                                                         | public API test/documentation                     | PENDING |
| TR-MOD-004   | Presets, calendars, zones, bounds, locale/labels, callbacks, presentation, and styling are configurable.          | second-consumer test                              | PENDING |
| TR-MOD-005   | Styles are scoped and themeable without page selectors.                                                           | CSS/import inspection and fixture                 | PENDING |
| TR-MOD-006   | Multiple instances remain independent.                                                                            | component test                                    | PENDING |
| TR-MOD-007   | React picker is controlled and emits explicit commits.                                                            | component test                                    | PENDING |
| TR-MOD-008   | Module can be extracted without rewriting core logic.                                                             | structure/design review                           | PENDING |
| TR-MOD-009   | Nothing is published.                                                                                             | execution audit                                   | PENDING |
| TR-REG-001   | Views, charts, legends, events, inspect, history, external context, sources, compare, and dialogs do not regress. | existing frontend/browser suites                  | PENDING |
| TR-REG-002   | Existing accessibility/browser gates remain green.                                                                | full relevant Playwright suite                    | PENDING |
| TR-REG-003   | Receiver and cross-layer contracts remain green.                                                                  | receiver/contracts commands                       | PENDING |
| TR-REG-004   | Existing performance gates remain green.                                                                          | performance command                               | PENDING |
| TR-REG-005   | Testing causes no production side effect.                                                                         | execution audit                                   | PENDING |

## Blocking policy

Any Critical or High adversarial finding blocks GO. A Medium finding blocks GO when it affects correctness, accessibility, URL compatibility, race safety, or reusability. Cosmetic Medium findings may defer only with explicit rationale and no acceptance violation. The final exact head must be the re-reviewed head.
