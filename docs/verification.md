# Verification evidence

Date: 2026-07-21

## Environment

- Host shell Node: 25.2.1; pinned pnpm: 10.30.3. The standalone pnpm executable reports its
  embedded Node 20.11.1, so it prints an engine warning; the clean receiver image builds with Node 24.
- Python: 3.10.12 locally and 3.12 in the receiver image.
- Docker: 29.0.1; Compose: 2.40.3.
- Deno tests run in the collector image because Deno is not installed on the host.

## Deterministic and live source checks

- Collector: 9 fixture tests cover six success schemas, malformed JSON, zero-core data, repeated
  DST hour, revision-aware metric checkpoints, persisted restart recovery, stable event dedupe,
  and linear receiver-size chunking through a 20,000-row payload.
- One-shot live validation: fuel 2,896 points; storage 1,083; supply/demand 1,081; generation
  outages 18,020; operations messages 46 events; wind/solar 298 points.
- Receiver: 23 tests cover fresh/legacy migration, backup/restore, insert/update/unchanged ingest,
  event upsert, persisted source checkpoints, collection versus freshness health, handler-level
  query/body/cache bounds, tag queries, SQL average/minmax bucketing, full-window raw statistics,
  MW-to-MWh integration, and seasonal transforms.
- Frontend: 12 unit tests cover live/fixed time, pause/navigation/zoom, URL restoration, comparison
  alignment, derived series, exact-latest behavior, statistics, freshness, parity configuration,
  Chicago calendar/DST behavior, tail-query merging, and unit formatting.

## Browser and visual checks

Playwright covers live/pause, one-window navigation, inspect/Escape, click-to-pin shared cursor,
legend hide/solo, preset and custom-offset comparison, chart-menu actions, events, CSV, URL state,
drag zoom, shift-pan, global zoom reset, explicit failed/empty/stale states, lazy mounting, long
tasks, heap growth, responsive collapse, and keyboard navigation.

The desktop fixture has 19 configured charts and asserts that no more than four are initially
mounted. The browser budget rejects a largest observed long task of 500 ms or more and heap growth
of 64 MiB or more across lazy navigation and compare-mode churn. Shared-cursor publication is
coalesced into one animation frame and limited to currently visible subscribers.

Chart lifecycle instrumentation also verifies that each visible chart creates one Chart.js
instance, data refreshes use in-place `update("none")`, hidden/collapsed charts do not request
series, and scrolling into view performs bounded tail fetches instead of refetching a full window.

Committed visual baselines cover normal supply/demand, price spike, negative price, storage
charging, stale storage source, an operations event, the full analytical dashboard, and the mobile
dashboard. The suite contains 12 browser tests.

Pixel baselines are strict and environment-specific: local Linux baselines remain available for
developer runs, while CI uses separately inspected `ubuntu-24.04` baselines. The workflow pins that
runner version instead of depending on `ubuntu-latest` font and rasterization drift; no screenshot
threshold was loosened.

## Before and after

Current production before this branch (read-only capture, 2026-07-21):

![Current production dashboard before the feature](images/before-live-dashboard.png)

Deterministic feature dashboard after this branch:

![Analytical dashboard after the feature](../e2e/dashboard.spec.ts-snapshots/analytical-dashboard-chromium-linux.png)

## Query and growth benchmark

A synthetic 105,120-row/12-month tagged SQLite database was measured with the same script against
upstream `main` and this branch:

| Query                                      | Upstream median | Feature median | Result                    |
| ------------------------------------------ | --------------: | -------------: | ------------------------- |
| Tagged 12-month raw, 105,120 points        |        0.1297 s |       0.1105 s | no material regression    |
| SQL hourly average, 8,760 points           |        0.0752 s |       0.0725 s | no material regression    |
| SQL two-hour min/max, 8,760 extrema points |             n/a |       0.2100 s | new spike-preserving path |

The identical retry inserted zero rows, reported one unchanged row, and grew the database by zero pages.
The feature database was 86,016 bytes larger in this synthetic run due to additive schema/index
pages, not retry growth.

A repeated identical live batch request produced a cache hit. The mixed validation workload
finished with one hit and four cold misses (20% hit ratio); this is evidence that the cache path is
active, not a production hit-rate target.

The May 2026 production-copy reference (0.34-0.44 s tagged raw and about 0.04 s SQL hourly) used a
different database and environment, so it is retained as a rollout comparison target rather than
misrepresented as a directly comparable local number.

## Clean image and restart verification

Both images built with `docker compose build --no-cache`; the collector image reran all nine Deno
tests and the receiver image built the frontend under Node 24. Compose reached a healthy receiver,
and all six staggered sources completed through the authenticated receiver path. The large outage
payload was submitted in bounded batches and every receiver request returned HTTP 200.

The live Operations source initially submitted 46 unique events and persisted a 34,554-byte
checkpoint. After a collector restart, Fuel Mix and Energy Storage reported zero unchanged rows,
Operations submitted zero events, and both the metric and event tables retained equal total and
unique-key counts. This demonstrates restart-safe high-water/key checkpoints rather than replaying
the entire source history. The receiver was healthy, both containers logged normal operation, and
the temporary containers/network were then removed without deploying production. The bind-mounted
development database was retained locally and remains gitignored.

## Review remediation traceability

| Review area               | Regression evidence                                         | Implemented contract                                                                                              | Verification                            |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| A. Mutable telemetry      | Receiver revision/replay tests                              | Metric current-view upsert with `inserted`, `updated`, `unchanged`, and `invalid` accounting                      | 23 receiver tests                       |
| B. Incremental collection | Collector restart and 20k-payload fixtures                  | Actual high-water overlap, forecast key/value checkpoints, persisted receiver checkpoints, linear batching        | 9 collector tests plus live restart     |
| C. Exact KPIs/statistics  | Raw-stat and MWh receiver tests; exact-latest frontend test | Exact latest endpoints, raw-window metadata independent of decimation, trapezoidal MWh                            | Receiver/frontend suites                |
| D. Legacy parity          | Chart configuration contract                                | 19-chart parity matrix including capacity, frequency, ties, reserves, outages, weather, and duty cycle            | Unit contract and full-dashboard VRI    |
| E. Bounded reads          | Handler-level GET/batch tests                               | Shared default window and request/body limits that cannot be bypassed by omitted parameters                       | Receiver suite and Compose contract     |
| F. Health semantics       | Event-source stale-data test                                | Separate collection and freshness states, publication mode/interval, structured legacy attempts                   | Receiver and collector suites           |
| G. Chart lifecycle        | Browser instrumentation and request capture                 | Create once, `update("none")`, visibility-scoped requests, tail merging                                           | 12 Playwright scenarios                 |
| H. Interaction/time       | Browser zoom/Escape tests and Chicago DST units             | Separate pre-zoom and live origins, global Escape, Chicago calendar parsing/formatting                            | Frontend and Playwright suites          |
| I. Deployment safety      | CI Compose contract                                         | Secret-required production Compose and loopback-only standalone development Compose                               | Config validation and clean image build |
| J. Deterministic CI       | Workflow job graph                                          | Named static/unit, collector, E2E/VRI, performance, and multi-arch build gates; live checks scheduled/manual only | Local mirror of all deterministic jobs  |

## Current production proxy behavior

Read-only response-header checks on 2026-07-21 found Cloudflare in front of the live site. HTML and
API responses were `cf-cache-status: DYNAMIC`; `/api/status` preserved `Cache-Control: no-store`.
The current hashed JavaScript asset was Brotli encoded when requested with compression support and
returned `Cache-Control: max-age=14400`. This branch does not modify the external proxy.
