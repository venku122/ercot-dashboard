# Mobile optimization verification

Date: 2026-07-22

The mobile directive was implemented from current main at merge commit c739400 on
feature/mobile-dashboard-ux. No production deployment was performed.

## Red-green evidence

The first populated 440 x 956 WebKit hierarchy test failed against unchanged main because the
mobile ERCOT Grid operational shell did not exist. The first viewport and the existing legacy
full-page baseline were preserved before source changes. After implementation, the populated
iPhone/WebKit suite passes hierarchy, exact KPIs, no overflow, compact legends, 44 point targets,
touch scroll policy, inspect gestures, focus restoration, source failure, active event, negative
price, empty/error distinction, section navigation, safe areas, and increased-text assertions.

Before evidence:

- [First 440 x 956 WebKit viewport](images/mobile-before-main-first-viewport.png)
- [Legacy mobile full page](images/mobile-before-main-full.png)

After evidence:

- [First viewport](../e2e/mobile.spec.ts-snapshots/mobile-after-first-viewport-iphone-pro-max-webkit-linux.png)
- [Mobile full page](../e2e/mobile.spec.ts-snapshots/mobile-after-full-iphone-pro-max-webkit-linux.png)
- [Controls sheet](../e2e/mobile.spec.ts-snapshots/mobile-controls-sheet-iphone-pro-max-webkit-linux.png)
- [Compact legend](../e2e/mobile.spec.ts-snapshots/mobile-compact-legend-iphone-pro-max-webkit-linux.png)
- [Source failure summary](../e2e/mobile.spec.ts-snapshots/mobile-source-failure-summary-iphone-pro-max-webkit-linux.png)
- [Source failure drawer](../e2e/mobile.spec.ts-snapshots/mobile-source-failure-drawer-iphone-pro-max-webkit-linux.png)
- [Stale storage card](../e2e/mobile.spec.ts-snapshots/mobile-stale-storage-card-iphone-pro-max-webkit-linux.png)
- [Active operations notice](../e2e/mobile.spec.ts-snapshots/mobile-active-operations-iphone-pro-max-webkit-linux.png)
- [Grid warning](../e2e/mobile.spec.ts-snapshots/mobile-grid-warning-iphone-pro-max-webkit-linux.png)
- [Negative settlement prices](../e2e/mobile.spec.ts-snapshots/mobile-negative-ranking-iphone-pro-max-webkit-linux.png)
- [Inspect portrait](../e2e/mobile.spec.ts-snapshots/mobile-inspect-portrait-iphone-pro-max-webkit-linux.png)
- [Inspect landscape](../e2e/mobile.spec.ts-snapshots/mobile-inspect-landscape-iphone-landscape-webkit-linux.png)
- [WebKit interaction trace](evidence/mobile-interaction-webkit-trace.zip)

Strict Ubuntu 24.04 variants of every new WebKit image are committed for CI. Baselines were
generated in the pinned mcr.microsoft.com/playwright:v1.61.1-noble image and reviewed without
loosening screenshot thresholds. The only desktop baseline updates were inspected title
antialiasing from the ChartCard lazy boundary and a regenerated full-page image with the original
desktop layout preserved.

## Objective mobile budgets

At the populated Pixel 7 Chromium fixture, the initial shell constructed zero chart instances
before a chart reached the viewport, against a maximum of two. Visiting Grid, Generation,
Reliability, and Market and returning to Overview grew JavaScript heap by 20,676,620 bytes
(19.72 MiB), below the 48 MiB gate. The largest observed initial/navigation long task was 53 ms,
below the 300 ms gate. Mobile fixture assertions keep document scroll width equal to client width.

The pre-split production JavaScript bundle was 509.31 kB (163.27 kB gzip). The implemented build
produces a 265.82 kB shell (82.58 kB gzip) and a separately requested 258.12 kB ChartCard/charting
chunk (85.16 kB gzip), so the operational shell no longer waits for the chart runtime.

## Final local validation

- Static, unit, and receiver gates: `pnpm run check`, 15 frontend tests, and 23 receiver tests.
- Browser matrix: all 48 tests passed across desktop Chromium, Pixel 7 Chromium, 440 x 956
  iPhone WebKit, 375 x 667 compact portrait, and 956 x 440 landscape WebKit.
- Stability: the complete 17-case iPhone WebKit project passed five consecutive repetitions (85
  cases) without a retry or snapshot mismatch.
- CI parity: all 19 iPhone portrait and landscape WebKit cases passed in the pinned Ubuntu 24.04
  Playwright image while regenerating the strict CI baselines.
- Collector and images: the uncached collector target ran 9 tests, and
  `METRICS_API_KEY=local-mobile-review-key docker compose build --no-cache` built both production
  images.
- Runtime smoke: the temporary development stack reported a healthy receiver, accepted collector
  ingestion, served the split production assets, and rendered successfully in WebKit with an
  iPhone device profile. The temporary containers and network were removed after verification.

## Physical iPhone gate

A physical iPhone was not attached or remotely available to this execution environment. No claim
of real-device Safari validation is made. The following release gate remains explicitly pending
for the reviewer before the draft PR is marked ready:

| Check                                                       | Status                  |
| ----------------------------------------------------------- | ----------------------- |
| Large iPhone model, iOS version, Safari version recorded    | Pending physical device |
| Portrait, landscape, browser tab, and standalone safe areas | Pending physical device |
| Vertical swipe over major chart types                       | Pending physical device |
| Inspect pinch zoom, horizontal pan, reset, and rotation     | Pending physical device |
| Software keyboard with custom Chicago range                 | Pending physical device |
| Long source error, negative price, and active notice        | Pending physical device |
| Increased Safari text size and back/forward URL state       | Pending physical device |
