# ERP-04 delivery interval cursor repair

Independent review reproduced a real defect: the archive API returned hourly ending epochs and bounds, but the forecast cursor used preceding-point semantics. At 08:30 UTC it displayed the prior delivery hour (11 GW) instead of the active [08:00,09:00) hour (42 GW). The unchanged keyboard browser regression failed before the repair.

The loader retains validated one-hour API intervals and original ending epochs. Only archived demand forecasts use this interval cursor policy. The right query edge includes the closing epoch of a partial delivery hour while the publication cutoff remains the selected window end. Coverage counts overlapping intervals. Readouts identify delivery intervals and hour endings rather than observation ages.

Comparison intervals align the ending epoch with the selected comparison policy and preserve the original one-hour duration. A separate regression demonstrated that independently aligning both edges across the Chicago fall-back day stretched a one-hour interval to two hours; the corrected calculation preserves 3600 seconds. Missing intervals remain unavailable and exact ending boundaries select the next interval or no value.

Validation before commit: 70 frontend files / 488 tests, 287 receiver tests, 41 contract tests and static checks passed. Focused unit tests cover first/last boundaries, a missing hour, partial window edges, distinct comparison values and fall-back duration. The actual keyboard cursor browser regression plus four archive/actual source separation browser cases passed; exact committed-head replay and independent review follow in the review ledger.

## Full-range delivery edge

Independent review additionally reproduced a valid 366-day partial-hour request rejected by the shared vintage span validator. Historical demand reads now allow at most one hour of delivery-ending query padding while ordinary vintage endpoints retain their original 366-day limit. The historical endpoint rejects more than 8785 expected hourly targets before SQL and retains its separate returned-row overflow guard. The publication cutoff is unchanged.

The receiver regression failed before this repair. Real ingest/SQLite selections and actual HTTP handler responses now return all 8785 archived hourly targets for aligned and partial 366-day windows, including the closing target. Coverage and cutoff agree; excess span, target ceiling and ordinary vintage overrun remain rejected. This is a scoped historical endpoint allowance, not a generic series limit change.

Fractional-second exported-loader selections now ceil the query start and floor the publication cutoff. Integer-second selections retain their existing contract. Two genuine regressions cover 0.4-second full-range rejection and 0.6-second cutoff advancement; source ending epochs remain unchanged.
