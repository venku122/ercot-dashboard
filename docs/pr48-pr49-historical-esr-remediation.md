# PR48/PR49 historical four-second ESR remediation

Status: `BLOCKED_EXTERNAL` — a nonempty authoritative historical response could
not be obtained with the credentials available to this remediation workspace.

## Sanitized preflight record

- Checked: 2026-08-20
- Official endpoint: `GET https://api.ercot.com/api/public-data/rptesr-m/4_sec_esr_charging_mw`
- Product: four-second ESR charging MW (`rptesr-m`)
- Intended bounded historical probe: 2025-05-29 through 2025-05-30
- Required environment: ERCOT API username, password, and the separate ESR API
  subscription key
- Credential result: none of the three required values was available to the
  process; the local password manager required interactive unlock
- HTTP status: not attempted, to avoid making an invalid or misleading
  unauthenticated probe
- Returned row count: not observed
- Returned field definitions: not observed in this historical preflight

Earlier credentialed repository evidence established only a successful empty
response and a five-field schema for other windows. It does not establish the
historical nonempty row contract and is not reused as one here. In particular,
this remediation does not freeze types, cadence, ordering, pagination,
duplicates, corrections, natural identity, DST behavior, or retention from the
schema-only result or the stale fixture.

ERCOT's api-specs discussion #129 states that this feed contains data before
RTC+B and stopped publishing current data on 2025-12-05. Discussion #106 states
that historical/API access requires a separate subscription key. Those facts
support a future controlled historical import but do not substitute for the
required nonempty probe.

## Resulting product boundary

- Current four-second ESR remains `historical_only_discontinued`; it is never
  shown as live, stale, valid-empty, or zero.
- PR48's verified five-minute, system-wide storage aggregate remains the only
  current storage-operations feed.
- PR49 remains a multi-cadence context replay and makes no four-second battery
  response, resource-level, state-of-charge, or causal claim.
- No parser, database table, backfill runner, retention policy, or frontend
  series was created from unverified fields.
- A future importer requires a nonempty bounded 2025-05-29/30 probe and the
  contract, storage, correction, benchmark, and replay gates in the remediation
  directive before activation.

## Upstream references

- ERCOT Public API developer portal: <https://apiexplorer.ercot.com/>
- ERCOT api-specs discussion #106: <https://github.com/ercot/api-specs/discussions/106>
- ERCOT api-specs discussion #129: <https://github.com/ercot/api-specs/discussions/129>
