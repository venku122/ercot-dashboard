# Regional geography contract

PR13 adds a lazy Generation-view regional diagnostic. The UI deliberately calls its controls
an **ERCOT region schematic — not geographic boundaries**. No polygon geometry or cross-source
region equivalence is claimed.

- Load uses the eight NP3-565/NP6-345 weather zones. Its error is the diagnostic actual minus
  forecast; positive means underforecast. Historical forecast curves use one coherent publication
  selected by the `latest-capped-1h-before-utc-day` policy, not a per-target one-hour forecast.
- Wind uses the five NP4-742 regions. Solar uses the six NP4-745 regions. GEN is current output;
  STWPF/STPPF is an HSL-potential forecast. COP_HSL and WGRPP/PVGRPP are context only. A renewable
  forecast error is unavailable because generation is curtailment-affected while the forecast
  targets HSL potential.
- NP4-743/746 five-minute collection is explicitly deferred. PR13's current/change cadence is
  hourly, and exact change requires a sample exactly 3,600 seconds earlier.

The collector runner is wired but disabled by default with
`ERCOT_REGIONAL_RENEWABLE_INGEST_ENABLED=false`. Enabling it requires the reviewed receiver URL and
API key; this change does not claim deployment or activation.

Raw wide publications are retained for 35 days. A bounded ingest-time prune removes old raw
publications only after derived pointers exist and removes unadvertised derived versions. Regional
immutable responses therefore advertise a matching 35-day HTTP lifetime, rather than a one-year
guarantee. Current pointers select official `issued_at` and stable document identity, never late
retrieval order.
