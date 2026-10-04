# ERP-04 historical forecast policy

The retrospective demand plot uses NP3-565-CD systemTotal, declared MW, in-use rows.
Each target is an ERCOT hour ending; delivery start is exactly 3,600 seconds before
that epoch, including DST days. Choose the latest official issue at or before
both delivery start and the selected historical cutoff. Equal issue-time
corrections retain the earliest ingested version with a stable content-key tie
break. Later issue times cannot enter a pre-delivery interval.

| Clock                         | Meaning                 | Selection role                         |
| ----------------------------- | ----------------------- | -------------------------------------- |
| issued_at                     | Official postedDatetime | Must precede delivery start and cutoff |
| interval_start / interval_end | Hour delivery bounds    | Original UTC target is preserved       |
| retrieved_at                  | Collector retrieval     | Separate provenance                    |
| first_seen_at                 | Receiver ingestion      | Separate system knowledge evidence     |
| as_of                         | Selected window end     | Never moved by future outlook refresh  |

`/api/v1/historical-forecast?start=…&end=…&as_of=…&policy=issued_before_delivery`
is bounded to 366 days / 5,000 selected rows. Response metadata includes the
policy and all four source clocks. It is no-store; frontend request identity
contains window, cutoff, and policy. Missing unit/issue metadata is ineligible.
There is no fallback to legacy latest/future forecasts or actual demand.

`policy=system_known` additionally bounds retrieval and first ingestion at the
cutoff. This is distinct from official issued-before-delivery history. The
visible plot does not claim system knowledge. Archives collected later can
support the first policy while failing the second. Empty or unavailable archives
produce explicit plot notes. Current future outlook retains its independent
publication/domain. This additive query does not change checkpoint ingestion,
forecast-quality scoring, legacy series APIs, or persisted publication rows.

A source-disabled installation may have no eligible archived vintages; local
fixture tests establish behavior without claiming historical data was collected.
Production rollout and real publication coverage remain separate review gates.
