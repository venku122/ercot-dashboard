# Series temporal policy inventory (ERP-02)

The frontend contract owns displayed source semantics, independently of collection,
publication refresh, line connection, cursor expiration and aggregation. It changes no
stored observations or API schemas. `SeriesDefinition.temporal` can override a family
contract; missing/invalid policy fails closed. Current and comparison lines use the same
contract. Canonical transport arrays remain unchanged: a cached display copy sorts
finite timestamps, keeps the last duplicate, and retains non-finite values as gaps.

| Family                                                                   | Native source resolution                                     | Line allowance        | Cursor validity      | Evidence                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply/demand observed, fuel mix, storage, derived Overview headroom     | 300 s                                                        | 600 s                 | preceding <=600 s    | Collector `_lib.ts` metricSeries default and source rows; legacy source contracts                                                                                                  |
| Supply/demand forecast                                                   | 3600 s                                                       | 5400 s                | preceding <=5400 s   | Verified historical hourly chart fixtures; publication/vintage policy is separate ERP-04 work                                                                                      |
| Renewable actual/forecast/HSL                                            | 3600 s                                                       | 5400 s                | preceding <=5400 s   | `ercot-collector/wind_solar.ts` declares interval 3600 for all row series                                                                                                          |
| Legacy price observations                                                | 900 s collection resolution; settlement semantics unverified | 1350 s                | preceding <=1800 s   | `ercot-collector/prices.ts` emits no delivery timestamp, interval 900. These are instant collected observations, never invented settlement intervals. ERP-05 adds verified bounds. |
| Frequency                                                                | 60 s captured observations                                   | 60 s                  | preceding <=60 s     | `ercot-collector/grid.ts` captures once per minute. One-second underlying frequency is not proven by that collector.                                                               |
| DC ties, realtime capacity/demand/headroom, time error/recovery, inertia | 60 s captured observations                                   | 600 s                 | preceding <=60 s     | `ercot-collector/grid.ts` uses capturedAt and interval 60                                                                                                                          |
| Reserves, ancillary regulation/reserves                                  | 60 s captured observations                                   | 600 s                 | preceding <=600 s    | `ercot-collector/ancillary.ts` interval 60                                                                                                                                         |
| Generation outages                                                       | unknown                                                      | isolated observations | exact timestamp only | `generation_outages.ts` preserves dashboard epochs but does not establish publication cadence                                                                                      |
| EEA discrete state                                                       | unknown                                                      | isolated observations | exact timestamp only | Event-state persistence not proven                                                                                                                                                 |
| METAR temperature/wind                                                   | irregular/unknown                                            | 5400 s                | preceding <=5400 s   | `metar.ts` obsTime; 30 minute polling does not prove hourly publications                                                                                                           |
| Collector duty cycle                                                     | task-specific/unknown                                        | isolated observations | exact timestamp only | `runMetricsLoop` per-task collection instrumentation                                                                                                                               |

The native-resolution label describes the source observations represented by the
transport. Coarse buckets are aggregate, with unknown coverage unless explicitly
provided. Unknown cadence/metadata is labeled unknown. Aggregate lines are dashed and
readouts carry resolution/coverage evidence. Bucket width can expand aggregate plot
spacing, but cannot extend cursor persistence or certify complete native coverage.
No-policy/exact-observation contracts do not connect coarse buckets.

Proven interval metadata uses half-open containment `[start,end)`, independent of
whether the source labels interval start or interval ending. Missing, invalid, or
ambiguous interval bounds fail closed. Instantaneous lookup never selects a future
sample. A whole missing renewable/forecast interval breaks at 7200 s; exactly 5400 s
remains allowed. Legacy Houston points 900 s apart connect, a 3600 s hole breaks.

## Shared consumers

`ChartCard` current/comparison datasets, Overview generation alignment, Overview
readings/evidence, cursor legend and keyboard cadence all resolve declared policy.
Inspect accessible data discloses displayed resolution/coverage. The legacy exported
`precedingObservation` adapter remains readable for existing callers/tests, while
production consumers use `observationAt` directly. No hover or legend changes initiate
requests, and no chart geometry/CSS was changed.

## Specialist products retained

Outlook/forecast quality, predictive weather, Net Load, regional renewables, market
geography/mechanics, historical context, Texas Grid, external context, storage replay
and grid event timelines use domain-specific publication/interval/date/event contracts
rather than this generic `LoadedSeries` renderer. Keep those contracts (including HSL
basis, delivery dates, target timestamps, vintage IDs and event bounds) in their
validated domain modules. They must not borrow a generic 300 s cadence. Outlook's
index-spaced missing-hour plot and Next-24 versus seven-day summary scope are separate
ERP-07 findings. Forecast vintage and settlement delivery work are ERP-04/05.
