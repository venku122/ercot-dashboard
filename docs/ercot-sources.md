# ERCOT scraper sources

Live schemas were verified against official ERCOT resources on 2026-07-21. Success fixtures are
small immutable excerpts of those payloads under `ercot-collector/fixtures/`; an invalid JSON
fixture, a zero-core fixture, and a repeated-hour storage fixture cover failures and DST.

| Source                          | Content                                                                                      |  Poll | Source timestamp                          | Normalized output                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ----: | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `fuel-mix.json`                 | JSON: `lastUpdated`, `types`, `monthlyCapacity`, day/time/fuel maps                          | 5 min | `lastUpdated` includes numeric UTC offset | `ercot.fuel_mix.generation_mw`, `ercot.fuel_mix.seasonal_capacity_mw`; `fuel:*` |
| `energy-storage-resources.json` | JSON: current/previous arrays with `epoch`, `timestamp`, `dstFlag`, charging/discharging/net | 5 min | `lastUpdated`; points use `epoch`         | charging, discharging, and net-output MW                                        |
| `supply-demand.json`            | JSON: actual five-minute rows and hourly forecast rows                                       | 5 min | `lastUpdated`; points use `epoch`         | demand, committed/available capacity, forecast demand/capacity                  |
| `generation-outages.json`       | JSON: current/previous epoch maps                                                            | 5 min | `lastUpdated`; map key is point epoch     | bounded Combined/Dispatchable/Renewable and planned/unplanned/total series      |
| Operations Messages             | HTML table with datetime, summary, type, priority                                            | 3 min | newest message timestamp                  | structured deduped `events` rows                                                |
| `combine-wind-solar.json`       | JSON: current/next-day epoch maps                                                            | 5 min | `lastUpdated`; points use `epoch`         | wind/solar actual, short-term forecast, HSL, and day-ahead variants             |

Official resource URLs are defined beside each adapter. The dashboard links users to the matching
ERCOT context page.

## Schema decisions

- Fuel mix currently publishes generation and monthly seasonal capacity. It does **not** expose a
  per-fuel HSL field, so the collector does not fabricate one. Wind/solar HSL is collected from the
  combined renewable resource, where the live schema does publish `copHslWind` and `copHslSolar`.
- Storage, supply/demand, outages, and combined wind/solar publish an epoch plus a DST flag. Epoch is
  authoritative, so repeated local hours remain distinct. Actuals retain a bounded overlap for
  corrections; mutable forecast identities are value-diffed from a receiver-persisted checkpoint.
- Generation-outage categories were verified as Combined, Dispatchable, and Renewable, each with
  planned, unplanned, and total values. No timestamp or transient category becomes a tag.
- `combine-wind-solar.json` remains current and useful; it is enabled.
- The ancillary JSON currently contains responsive reserve, ECRS, non-spin, regulation,
  system-capacity, PRC, real-time operating-reserve, and telemetered HSL fields. The existing adapter
  already emits every numeric key, including deployed/undeployed and capacity-to-base-point fields.
- The real-time system-conditions page does not document a machine-readable DC-tie sign convention
  in the scraped payload. Values are stored and labeled without inversion; authoritative sign
  wording remains a follow-up rather than a guessed transform.
- Operations Messages does not expose an explicit offset or DST flag. The adapter applies the US
  Central DST calendar. An exact repeated-hour operations notice would remain the one known
  timestamp ambiguity.

## Failure semantics

HTTP failure, malformed schema, invalid numeric data, or zero core rows produce no metrics/events
and increment structured source failure state. All modern and legacy loops report structured
attempts. Collection health is based on attempts; freshness is based on publication semantics and
source timestamps. Operations Messages is explicitly event-driven. An unchanged valid payload
resets failures and is reported as success without resubmitting its rows.
