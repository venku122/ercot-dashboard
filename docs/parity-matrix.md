# Legacy dashboard parity matrix

This matrix is the checked-in contract for the legacy JavaScript dashboard behaviors reviewed for
PR #9. Every item is restored in the React dashboard; no disposition requires an out-of-scope
service or production deployment.

| Legacy capability               | React disposition                                                                 | Contract evidence                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Unused capacity/headroom        | Restored as capacity minus demand with PRC context                                | `capacity-headroom` config and derived-series unit test                           |
| Time error and delta            | Restored as raw time error plus consecutive delta                                 | `time-error` config and derived-series unit test                                  |
| Inertia                         | Restored                                                                          | `inertia` chart and exact overview KPI                                            |
| All DC ties plus net/total      | Restored for DC_E, DC_N, DC_L, DC_R, DC_S plus signed net and total absolute flow | `dc-ties` config contract and derived-series test                                 |
| EEA                             | Restored                                                                          | `eea` chart                                                                       |
| Ancillary-service views         | Restored regulation, PRC, online/offline reserves, non-spin, and ECRS             | `reserves`, `ancillary-regulation`, and `ancillary-reserves` charts               |
| Settlement-price ranking        | Restored as latest price ranking table                                            | `/api/v1/ranking` and Playwright assertion                                        |
| PowerOutage.us customer outages | Restored as a per-timestamp statewide sum                                         | `customer-outages` with `rollup=sum`                                              |
| METAR weather                   | Restored temperature and wind across DFW, Austin, Houston, and San Antonio        | `weather-temperature` and `weather-wind` charts                                   |
| Collector duty cycle            | Restored for grid, ancillary, pricing, weather, outages, and EEA loops            | `collector-duty-cycle` chart and structured legacy attempts                       |
| Equivalent overview KPIs        | Restored using exact latest reads                                                 | demand, capacity, unused capacity, frequency, storage, and inertia overview cards |

The browser suite asserts these views remain present, avoids requests for inactive/collapsed
groups, and protects the intended desktop/mobile visual states.
