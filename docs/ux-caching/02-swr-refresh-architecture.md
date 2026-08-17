# SWR refresh architecture

The dashboard overview no longer reloads because the display clock advances. `App` still advances a
live chart window every 30 seconds, but overview resources are owned by `useOverviewData` and refresh
on source-aware cadences.

| Resource                                                                |    Cadence | Rationale                                              |
| ----------------------------------------------------------------------- | ---------: | ------------------------------------------------------ |
| Grid frequency and EEA state                                            | 30 seconds | Fast operational signals                               |
| Source health                                                           | 60 seconds | Prompt diagnostics without coupling to chart animation |
| Operations events                                                       |  3 minutes | Event feed publication cadence                         |
| Demand, capacity, pricing, fuel, storage, rankings, and derived context |  5 minutes | ERCOT five-minute products                             |

All resources use canonical SWR keys, a two-second deduplication window, focus and reconnect
revalidation, and no hidden-tab or offline polling. Previous data remains rendered during background
validation; `isLoading` is reserved for first load. The data loaders return `Map` instances, so the
shared policy uses identity comparison to ensure a completed replacement is not mistaken for an
unchanged structurally opaque value.

Selected fixed event windows use their exact boundaries. Live event windows are quantized to the
event cadence so the cosmetic clock cannot manufacture cache misses. A selected 24-hour live window
shares the status-event key and request.

Verification covers canonical key equivalence, the explicit cadence contract, and a deferred refresh
sequence that proves the old snapshot remains visible while `isValidating` is true and is replaced
only after the new response resolves.
