# Time Range Picker adversarial review

## Method

Six independent specialty roles reviewed the implementation and tests. Medium correctness, accessibility, URL, race, or reusability findings were treated as blocking. Findings were remediated and affected roles re-ran focused tests on the remediated implementation heads.

## Results

| Role | Specialty                                | Blocking findings and remediation                                                                                                                                                                             | Final result                                                  |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A    | Temporal, DST, and state semantics       | Strengthened paused URL validation, DST gap shifting, invalid timezone handling, exact calendar bounds, and aged-growing coverage (400 days).                                                                 | PASS                                                          |
| B    | UI, accessibility, focus, and mobile     | Closed outside-dismissal/nested-dialog, portal theming, label/error-hook, focus, and 44-by-44 target evidence gaps.                                                                                           | PASS                                                          |
| C    | Fetch, chart, and integration races      | Restored incremental live-tail reuse, generation-guarded stale results, and paired transitional data with its matching old x-domain.                                                                          | PASS                                                          |
| D    | Regression and hostile URL compatibility | Rounded fractional zoom instants; then fixed canonical fixed-range decoding so reset memory flows through constructors and configured validation. Closed-calendar and overlong-growing memories are rejected. | PASS at `eedc690` (46 focused tests)                          |
| E    | Reusable API and extraction boundary     | Validated nested reset memory in constructors and configured validation; reconstructed reset state through checked factories; proved locale-rendered second-consumer output and explicit exports.             | PASS at `9735a4c` (31 focused tests)                          |
| F    | Test quality and mutation resistance     | Added no-mouse Chromium/WebKit keyboard coverage and a material `fr-CA` rendering assertion; expanded calendar, history, mobile-size, stale-response, and alternate-zone evidence.                            | PASS at `9735a4c` (31 Vitest and 10 focused Playwright tests) |

## Nonblocking notes

- Config-specific min/max enforcement remains at `validateTimeRangeValue` and the controlled commit/codec boundary because constructors intentionally do not accept consumer config.
- The browser keyboard case programmatically focuses individual controls while proving real Tab/Shift+Tab trap edges and keyboard activation. Tabbing through every intermediate control is optional additional hardening.
- Listener cleanup asserts balanced registrations; tracking callback identity with an active-set mutation test is optional hardening.

## Verdict

GO for draft human review. This verdict authorizes neither merge nor deployment.
