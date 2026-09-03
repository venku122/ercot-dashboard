# Datadog / DRUIDS time range picker compatibility contract

Status: implemented and independently re-reviewed

Inspected: 2026-09-03

Behavior oracle: <https://docs.datadoghq.com/dashboards/guide/custom_time_frames/>

Visual and interaction oracle: <https://druids.datadoghq.com/components/time/DateRangePicker>

This contract is additive to `2026-09-01--time-range-picker-acceptance-contract.md`. The reusable semantic model, URL codec, ERCOT adapter, duration bounds, DST rules, and request-silence gates remain authoritative.

## Frozen DRUIDS surface

| ID        | Requirement                                                                                                                                  | Offline evidence                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| DD-UI-001 | One compact cluster contains a duration pill, editable range text, and previous/play-next controls.                                          | pinned manifest geometry and component test    |
| DD-UI-002 | Opening the input exposes a vertically ordered pill/label preset list, calendar action, and More action.                                     | pinned control order and component test        |
| DD-UI-003 | More expands a contiguous right-side syntax guide with Relative, Fixed, Growing, and Unix timestamp examples.                                | pinned example groups and screenshot           |
| DD-UI-004 | Calendar replaces the menu with a single month, month navigation, weekday headings, and accessible day buttons.                              | calendar interaction test                      |
| DD-UI-005 | The first calendar click starts a draft; the second commits complete local days.                                                             | parser/component/E2E tests                     |
| DD-UI-006 | Previous, play/pause, and next are available without opening the menu.                                                                       | component/E2E tests                            |
| DD-UI-007 | Menu, sidecar, calendar, pill, input, and playback geometry differs by at most 2 CSS px from the pinned reference after theme normalization. | `validate:datadog-picker`                      |
| DD-UI-008 | ERCOT colors and font family are intentional theme substitutions; type size, weight, and line height remain reference-compatible.            | pinned `themeSubstitutions` and CSS validation |
| DD-UI-009 | Mobile reflows the same interaction states into an opaque focus-contained sheet with 44px touch targets and no overflow.                     | mobile Playwright tests                        |
| DD-UI-010 | Invalid draft text stays local, is announced, and causes no URL, commit, or request.                                                         | component/E2E request trace                    |

## Frozen Custom Time Frames syntax

| ID         | Requirement                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| DD-SYN-001 | Fixed dates accept month names, `M/D`, `M-D`, optional 2/4 digit years, optional time, time-only values, Unix seconds, and Unix milliseconds. |
| DD-SYN-002 | Two fixed values form a range with a spaced hyphen or en dash. Date-only endpoints cover complete local days.                                 |
| DD-SYN-003 | Relative values accept every documented minute, hour, day, week, and month alias.                                                             |
| DD-SYN-004 | Growing ranges accept `{date} to now`, `{date} - now`, `since {date}`, and `from {date}` with relative, fixed, or Unix starts.                |
| DD-SYN-005 | Calendar phrases accept today, yesterday, week/month/year to date, this unit, last/previous unit, and `N units ago`.                          |
| DD-SYN-006 | Month/day/year/hour/minute source segments can be incremented with Arrow Up/Down before commit.                                               |
| DD-SYN-007 | Parsing is case-insensitive, whitespace tolerant, timezone-aware, bounded, and deterministic under a frozen clock.                            |
| DD-SYN-008 | Equivalent aliases normalize to the same semantic state and survive URL encode/decode.                                                        |

## Deterministic defaults and deviations

- Missing years use the current year in the selected timezone.
- Time-only values use the current local date. An end time not after its start advances one local day.
- A yearless end date before its start advances one year.
- Sliding `month` aliases equal 30 days. Calendar month phrases use civil month boundaries.
- Existing semantic calendar presets remain semantic. Calendar phrases without a corresponding preset compile to bounded fixed ranges.
- ERCOT theme variables replace Datadog colors and font family. Geometry, type metrics, icon boxes, ordering, and behavior remain conformance targets.
- The DRUIDS editable-expression interaction supersedes the form-era Apply/Cancel buttons: Enter commits a valid expression and Escape discards the draft while restoring focus.
- Canonical editable expressions intentionally use the Datadog specification's English syntax independently of the consumer display locale; all surrounding labels remain consumer-configurable.
- No Datadog source code, private data, or branded asset is copied.

## Reference refresh policy

`pnpm run reference:datadog-picker` captures the public DRUIDS example into an untracked dated artifact. Normal CI uses the reviewed manifest in `frontend/test-fixtures/datadog-date-range-picker/contract.json`. A live hash or surface change is reported as upstream drift and never replaces the manifest automatically.

## Final validation evidence

- Offline DRUIDS gate: PASS — frozen manifest structure and reference hashes, 72 focused parser/component tests, and two Chromium conformance scenarios.
- Live upstream check: PASS on 2026-09-03 — desktop 1280×960 and mobile 390×844 at DPR 1; no drift from the reviewed manifest.
- Commit gate: PASS — 61 frontend files / 429 tests, 266 receiver tests, and 20 cross-layer contract tests.
- Focused browser behavior: PASS — Chromium and WebKit keyboard navigation, paused reload endpoints, DST-later instants, foreign URL history, stale-response settlement, and four portrait/landscape mobile projects.
- Production build: PASS — main JavaScript 473.36 kB / 141.76 kB gzip; CSS 92.50 kB / 17.20 kB gzip.
- Receiver performance: PASS — 105,120-row workload, sealed-cache survival, dedupe, SQL, and raw-history checks.
- Independent regression, reuse, and test-coverage reviews: PASS after remediation.
- Exact committed head is recorded in the PR #56 acceptance-evidence comment after the same gates are rerun against that immutable revision.
