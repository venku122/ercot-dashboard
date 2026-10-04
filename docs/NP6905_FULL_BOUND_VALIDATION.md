# NP6-905 full selected-window validation

`ercot-receiver/test_market_price_full_bound.py` supplies synthetic evidence for
capacity and boundary handling. It is not a captured ERCOT archive or evidence of
historical source availability. The captured October 3 display-subset tests and
fixtures remain unchanged.

The synthetic archive contains 3,361 separate normal-ingest publications and
6,722 point rows over exactly 35 elapsed days. Each publication carries official
NP6-905 delivery date/hour/interval/DST field grammar, independently recomputed
canonical ending epochs, numeric synthetic document IDs starting at 990000000,
and deliberately different North/Houston values. The real receiver HTTP handler
reads the actual SQLite database; the test does not mock the selector or response.

Assertions cover every returned epoch, price, identity, interval support, and
publication document ID. The unpadded aligned half-open API window contains 3,360
ending slots. The aligned closing-edge padding and partial/fractional 35-day
requests contain all 3,361 slots. Final ending values and strict query-end
exclusion are checked explicitly. Raw API ending-slot cardinality differs from
frontend delivery-support filtering: a left-touching interval can be filtered by
the frontend, as existing tests require.

The archive crosses November 1, 2026 fall-back. Both local 01:00 hours retain all
four quarter-hour intervals each, distinct UTC epochs one hour apart, and their
correct N/Y repeated-hour flags. This is an elapsed-day test, not an assumption
that every Chicago calendar day has 96 intervals.

An oversized query is rejected before any SQLite statement. A separate deliberate
persisted-corruption step inserts one noncanonical epoch (which normal ingest
cannot accept), proving that 3,362 returned rows trigger the post-SQL overflow
guard and HTTP 400 rather than silent truncation. The response policy remains
`latest_published_corrections_not_as_known`.

A process-local mutation that clips actual selected rows to 1,000 makes the exact
HTTP epoch-array assertion fail; no production file is modified for that check.
The unmodified selector passes. No production changes, captured-data expansion,
visual baselines, performance thresholds, or tolerance changes are included.
