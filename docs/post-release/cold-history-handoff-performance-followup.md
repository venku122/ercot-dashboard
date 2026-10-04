# Cold history handoff and request-cohort errors

Owning directive slot: ERP-11, with source lifecycle preservation. Base: root slot 11 `649a` (the previously measured Linux median remains **2785.877935 ms, FAIL**). This followup is an unmeasured optimization until the integrated strict harness runs; thresholds, observers and source fixtures are unchanged.

## Change

Only the first cold Overview priority cohort reserves its existing history controller through two animation-frame callbacks before releasing the serialized deferred queue. Deferred chart keys remain unmarked. The browser can commit and paint the completed core plots before frequency parsing/rendering starts. Warm selections release immediately and retain the existing combined batch. There are no DOM queries in the scheduling implementation.

An abort, unmount, new request generation, or changed dashboard view cancels the hold. The callback and abort listener are cleaned up once. A one-second timer provides a bounded fallback when a hidden page does not receive animation frames; it cannot commit an aborted request. A failed core request also releases the deferred queue, allowing healthy frequency to load.

Request failures are now retained by actual requested chart and series. Successful unrelated frequency history cannot clear a failed core cohort or label it “Waiting for first sample.” Healthy frequency receives no unrelated core error. A successful explicit core retry clears only its own errors. The legacy collection-price display alias checks its actual series identity, so it cannot substitute an error or data basis for selected native settlement pricing. Canonical observations, source metadata, completed selection bounds, comparisons, cursor lookup, full table and CSV remain unchanged.

## Regression evidence

The primary browser observer wraps actual fetch calls in an init script, records the animation-frame counter and populated core canvas state synchronously at the frequency POST, and adds no fixture latency. Before the change, the cold successful request started frequency with no recorded core-ready frame. The second genuine regression returns explicit core/archive HTTP 503 while frequency remains healthy: the old global error reset incorrectly changed the core to “Waiting for first sample.” Both now pass; the latter also proves actual explicit Retry recovery.

A separate gated real core batch proves changing to the Generation view cancels the old deferred frequency cohort while generation populates. The first drafts of this additional test used the wrong transport and accessible button name; those were harness errors, not product regressions. The final test uses the actual v1 batch and “Generation view” control.

Eight model cases cover two-frame scheduling, hidden-page fallback, abort after zero/one frames, explicit cancellation, already-aborted input, unrelated cohort retention, partial-series recovery, and collection/native error identity. Browser verification and exact normal-hook counts are recorded in the campaign report. No numeric performance improvement is claimed by these correctness checks.

## Focused verification

- Chromium: six cold queue/source identity/rapid-20/obsolete-generation cases PASS (8.6 s); 18 warm/source/cursor/interval/table/CSV/pricing cases PASS (21.0 s); one constructor/later-update case PASS (4.5 s).
- WebKit: seven cold and retained-context cases PASS (10.4 s). The successful cold frequency fetch observed frame 10 after the core-ready frame 9; the explicit core-error case remained correctly unready while frequency advanced.
- Eight pure scheduling/cohort model cases PASS; typecheck PASS. The normal commit hook runs the complete project validation before commit.

Evidence is preserved under `/tmp/ercot-post-release-2026-10/cold-history-handoff-*.log`, with original RED artifacts in `cold-history-handoff-red/` and WebKit report plus raw fetch observations in `cold-history-handoff-webkit-report/` and `cold-history-handoff-webkit-fetch-proof.json`. These checks prove queue/source semantics, not a Linux or native startup budget result.
