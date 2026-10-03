# Fleet storage operations

PR16 adds a coherent operating summary to the existing Energy Storage Resources chart. It reuses the same three system-wide five-minute dashboard series, generic metric storage, v2 tile catalog, fixed-range planner, source health, exact table, and CSV path. It does not add another API, duplicate historical blobs, or create a second request lifecycle.

The current source is ERCOT's anonymous `energy-storage-resources.json` dashboard payload. The collector requires the reviewed exact top-level, day, and row field sets and bounds the two-day payload to 600 rows. Every accepted row must contain a 13-digit epoch in milliseconds aligned to five minutes, an offset-bearing timestamp resolving to that epoch, the raw DST and local-tag timestamps, charging MW, discharging MW, and source-published net output. Charging is non-positive consumption and discharging is non-negative injection. The source net value is retained rather than recomputed; the three independently rounded values must balance within `0.01 MW`. Duplicate epochs, partial rows, timestamp disagreement, invalid signs, or non-finite numbers fail closed. The collector reports newest-observation freshness separately from the newer payload-envelope timestamp and rechecks the complete two-market-day payload with a conservative 50-hour correction overlap.

The UI chooses only the newest epoch present in all three series. It never combines independently latest values or fills a missing value with zero. `Charging`, `Near idle`, and `Discharging` are application display labels using a strict ±50 MW deadband; they are not ERCOT operating-state classifications. Fixed historical windows retain the chart and exact table but do not masquerade an aggregate bucket as a live operating snapshot.

The summary is system-wide observational evidence only. It does not report state of charge, stored MWh, remaining duration, capacity utilization, efficiency, cycles, individual resources, dispatch intent, market participation, revenue, or a causal response to a nearby price, demand, frequency, outage, reserve, or net-load movement. ERCOT's published system-load basis excludes ESR charging, and PR16 does not alter any load or net-load formula.

ERCOT staff confirmed that the separate four-second ESR charging API contains data only before RTC+B began on December 5, 2025 and has no current API or ICCP replacement. PR16 therefore treats it as `historical_only_discontinued`, not live, stale, valid-empty, or zero. No scheduled four-second collector, current retention policy, resource-level identity, or UI claim is added. A later opt-in historical backfill would first need a bounded pre-cutoff schema/DST/correction/cardinality probe; the stale checked fixture with resource-level fields is not an accepted wire contract.

References:

- [ERCOT Energy Storage Resources dashboard](https://www.ercot.com/gridmktinfo/dashboards/energystorageresources)
- [ERCOT staff confirmation that four-second ESR data ended with RTC+B](https://github.com/ercot/api-specs/discussions/129)
- [ERCOT Ancillary Services Capacity Monitor](https://www.ercot.com/gridmktinfo/dashboards/ancillaryservicecapacitymonitor) (capability and awards only; not dispatch or energy)
