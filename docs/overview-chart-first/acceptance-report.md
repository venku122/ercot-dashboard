# Chart-first Overview — draft review packet

## Stack and release boundaries

Target: PR #55 (`ercot-observatory/23-integrated-hardening-handoff`) at `5ba7a130a221ab6b8707c2da2502976acc601ba8`. PR #56 is merged there, not into main. Inspected remote main: `4d77d4de7e7c06eee3a7a7a5b8e1c78a0540e71c`.

Candidate: `codex/overview-chart-first`. Baseline `6bea6d5` separately carries forward the user's reviewed local cleanup. The original dirty checkout is untouched. Production revision is **DEPLOYED_REVISION_UNKNOWN**. No merge, deployment, collector activation, credential change, or production mutation occurred. This packet is **draft review evidence**, not a claim of complete acceptance.

The supplied directive and three reference images were inspected alongside the live Datadog dashboard. The directive's standalone and bundled copies matched SHA-256 `c88f7eab20185aabe341cdb14899e2ae68af80886fedd7be64c330b0559cc93f`. Original reference images include browser chrome and were not committed.

## Implementation

Overview has compact readings and a 12-column grid: supply/demand beside headroom/PRC; selected-fuel composition beside storage; price snapshots beside selected-point history; shallow frequency. The same charts remain on the phone page. Grid Health, engineering details, historical context and calculated insights are disclosures rather than a first-screen score/hero.

Existing ChartCard, canonical history, semantic time picker, source states, tables, CSV and specialist routes remain. New sessions default to 24 hours and compact legends; explicit six-hour URLs and expanded legends win. Inspect expands the existing instance instead of mounting a competing duplicate.

The coordinator updates a lightweight cursor overlay and isolated readout components. Each series uses its own preceding timestamp and age limit. Pins pause the semantic window; clearing does not resume live. Evidence includes actual sample timestamps, ages and aggregate resolution. No hover history requests or invented raw pin samples are introduced.

History visibility batches are serialized and completed data is reused across views within the same time/comparison generation. Changed windows cancel obsolete work. The existing tile-loader concurrency limit is unchanged. Failed generations wait for explicit retry/a changed window, avoiding a visibility-driven retry loop.

## Source / capability matrix

| Surface                    | Source identity                                                | Meaning and limitations                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance                    | Existing `supply-demand` canonical series; `supply_demand.ts`  | Observed demand and capacity use the same source `data` rows. Forecasts use a separate source array and remain distinct.                                                                                                  |
| Headroom                   | Exact timestamp intersection of observed capacity minus demand | Display-only derivation. Requires matching, error-free resolutions ≤300 seconds. Coarse/incompatible aggregates are withheld, not subtracted as independent envelopes.                                                    |
| PRC                        | Existing `capacity-headroom:prc`, `ercot_ancillary.prc`        | Separate reported series, never added to/substituted for headroom. Overview requests only this contributor from that definition.                                                                                          |
| Generation                 | Five existing `ercot.fuel_mix.generation_mw` categories        | Absolute selected-subset MW stack, not total system generation or 100% mix. Common timestamp domain; missing/negative members create gaps. Signed storage excluded.                                                       |
| Storage                    | Existing charging, discharging and source-published net        | Negative charging, positive discharge, separate net line, zero reference. No SOC, duration, dispatch intent or revenue claims.                                                                                            |
| Price ranking              | Existing `/api/v1/ranking`, `ercot.pricing`                    | Same-collection-time snapshot subset. The legacy collector does not retain the official settlement interval; verified interval coherence is **not claimed**. Stale collections and omitted selected points are disclosed. |
| Price history              | Existing Houston, North and West series                        | Selection coordinates history/readout. Unsupported points explicitly lack history; no substitute hub. `overviewPoint` preserves Market Geography's separate typed URL field.                                              |
| Frequency                  | Existing `ercot.Frequency.Current_Frequency`                   | 60 Hz reference, initial 59.95–60.05 scale expanding for excursions, existing severity colors, no smoothing.                                                                                                              |
| Events / optional products | Existing operations, Outlook and specialist products           | Existing provenance and source gating retained. No new activation. Overview links to Outlook; an inline future plot is not included.                                                                                      |

The shared interpretation resolver no longer draws historical ratio bands from the last capacity sample. EEA lines are stepped. Display gap markers do not mutate canonical arrays. CSV/statistics retain the loaded resolution rather than claiming reconstructed native data.

## Evidence

- `before-1440.png` / `after-1440.png` and `before-390.png` / `after-390.png`: same frozen clock, explicit live 24-hour window, compact legend, viewport and original 64-point fixture. This coarse fixture correctly withholds native headroom. A storage-fixture substring bug was separately corrected (charging had matched discharging); first-screen balance samples are unchanged.
- `performance.json` and `performance-baseline.json`: production builds, five cold runs, browser version, throttling, 200 cursor samples, hover request count. API fixtures are route-fulfilled: this measures frontend work, not production API latency. Two-animation-frame cursor timing is a conservative proxy, not a compositor paint timestamp.
- Geometry tests require first balance canvas y≤240 desktop / y≤280 phone, height≥280 / ≥220, and no document-level horizontal overflow.
- Live local receiver-backed preview was inspected with populated demand, matched headroom, PRC, generation, storage, frequency and price snapshots. This demonstrates local support, not production deployment health.
- Exact-head results are recorded in the companion verification summary. Visual baselines are platform-specific: macOS Chromium evidence does not certify Linux or WebKit screenshots.

## Acceptance matrix

| IDs                    | Status / evidence                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HOME-01, HOME-02       | Implemented and locally tested: cross-category page, compact first-screen geometry and phone containment.                                                                                                   |
| HOME-03                | Specialist navigation, legacy deep links, single-instance Inspect and repeated lifecycle traversal tested.                                                                                                  |
| DATA-01, DATA-03       | Native matched contributor derivation and independent PRC tested. Seven-day coarse headroom remains unavailable pending source-paired aggregation.                                                          |
| DATA-02                | Unit regression proves changed last capacity cannot classify past demand.                                                                                                                                   |
| DATA-04, DATA-05       | Absolute subset stack, aligned gaps, zero/negative/missing cases; comparison stacks separate. No percentage denominator. Wider adversarial visual coverage remains useful.                                  |
| DATA-06                | Signed storage/source net and existing Storage Operations/replay contracts retained and tested.                                                                                                             |
| DATA-07                | Source-limited: honest collection snapshots, not verified settlement-interval ranking.                                                                                                                      |
| DATA-08                | Existing projections retained; gaps, negative/spike points, frequency reference and stepped EEA hardened. Full new seven-day adversarial image matrix remains incomplete.                                   |
| TIME-01, TIME-02       | Explicit six-hour URL/default 24-hour behavior, semantic picker contracts and Chicago repeated-DST-hour labels tested.                                                                                      |
| TIME-03, CURSOR-01..03 | Actual temporal scope, independent preceding lookup, age limits and aggregate evidence implemented. Native pin enrichment is not added; aggregate pins remain labeled aggregates.                           |
| TIME-04                | Keyboard pin freezes endpoints; clear preserves pause. Existing reset, navigation and reload contracts tested.                                                                                              |
| UI-01, UI-02           | Atomic supported price selection, unsupported-history state and explicit expanded legends tested.                                                                                                           |
| UI-03, UI-04           | Existing event provenance/lifecycle behavior retained; optional failures not fabricated as success. Inline future Outlook is follow-up work.                                                                |
| A11Y-01                | Keyboard, tables, focus and 44px primary mobile targets tested. No manual screen-reader certification claimed.                                                                                              |
| PERF-01                | Measured, with targets reported separately. A successful benchmark harness is not proof that numeric targets passed.                                                                                        |
| PERF-02                | No hover history fetches, cross-view storage reuse, serialized history batches and no surviving ChartCard instances after repeated traversal tested. Exhaustive timer/observer instrumentation not claimed. |
| RELEASE-01             | Draft only; see exact-head verification. No independent reviewer or production approval implied.                                                                                                            |

## Review / rollback

Review at 1440×900 and 390×844. Select supported and unsupported price points, inspect a chart, pin, clear, then explicitly resume live. Check a seven-day window: headroom must disclose its coarse-resolution limitation rather than synthesize a native result. Review snapshot pricing terminology and performance measurements before promoting the draft. Remaining implementation work is not an accepted deferral or an external outage merely because it is documented here.

Merge/promotion/deployment still require human approval and PR #55's release gates. Before merge, rollback is simply using the unchanged prior preview/closing this draft. If later merged, revert the homepage implementation commit(s), retaining the separate carried-forward cleanup as appropriate. No database migration or collector rollback is needed.
