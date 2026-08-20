# PR23 deployment, environment, and rollback acceptance

## Scope and decision

This is a read-only deployment handoff. It does not authorize a merge, image
publish, Portainer update, database mutation, source enablement, or Cloudflare
change. Secret **names** are recorded below; secret values must not appear in
Git, CI output, PR text, screenshots, source-health rows, or this document.

The checked-in production Compose file has complete wiring for the new opt-in
collectors, but it is a local build definition (`ercot-receiver:local` and
`ercot-collector:local`), not a production Portainer payload. Promotion must be
made from the current live stack definition and complete Portainer `Env` array,
using matching immutable receiver and collector image revisions.

## Exact deployment surface

All authenticated POSTs use the receiver's shared `METRICS_API_KEY`. Public GET
routes do not accept that key.

| Capability                | Collector setting                                                              | Receiver ingest                                                        | Public read                                                                         | Credential state                                         |
| ------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Market geography          | `ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED`, `ERCOT_MARKET_GEOGRAPHY_ENDPOINT`     | `/api/market-geography-publications/ingest`                            | `/api/v1/market-geography`                                                          | ERCOT Public API credentials required                    |
| Storage context replay    | none added                                                                     | existing storage/frequency/market ingests                              | existing inputs composed by the frontend                                            | no new credential                                        |
| Predictive weather        | `NWS_WEATHER_INGEST_ENABLED`, `NWS_WEATHER_ENDPOINT`, `NWS_WEATHER_USER_AGENT` | `/api/predictive-weather/ingest`                                       | `/api/v1/predictive-weather`                                                        | credential-free; stable identifying User-Agent required  |
| Unified grid events       | none added                                                                     | `/api/grid-events/ingest`, also derived from accepted NWS alerts       | `/api/v1/grid-events`                                                               | existing operations/EEA/NWS source configuration         |
| Historical demand context | none added                                                                     | derived from existing demand observations                              | `/api/v1/historical-context` and selected `/api/v2/historical-context/...` resource | no new credential                                        |
| Texas Grid                | `ERCOT_LONG_HORIZON_INGEST_ENABLED`, `ERCOT_LONG_HORIZON_ENDPOINT`             | `/api/texas-grid/ingest`, `/api/texas-grid/source-attempt`             | `/api/v1/texas-grid` and selected `/api/v2/texas-grid/...` resource                 | credential-free official workbooks                       |
| External context          | `EXTERNAL_CONTEXT_INGEST_ENABLED`, `EXTERNAL_CONTEXT_ENDPOINT`                 | `/api/external-context/ingest`, `/api/external-context/source-attempt` | `/api/v1/external-context` and selected `/api/v2/external-context/...` resource     | current runnable slice is credential-free EPA eGRID only |

The environment-name inventory that must survive a Portainer update is:

- Shared receiver/collector secret: `METRICS_API_KEY`.
- Existing ERCOT secrets: `ERCOT_API_USERNAME`, `ERCOT_API_PASSWORD`,
  `ERCOT_PUBLIC_API_SUBSCRIPTION_KEY`, `ERCOT_ESR_API_SUBSCRIPTION_KEY`.
- Existing and new opt-ins: `ERCOT_FORECAST_INGEST_ENABLED`,
  `ERCOT_RENEWABLE_INGEST_ENABLED`,
  `ERCOT_REGIONAL_RENEWABLE_INGEST_ENABLED`,
  `ERCOT_MARKET_MECHANICS_INGEST_ENABLED`,
  `ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED`, `NWS_WEATHER_INGEST_ENABLED`,
  `ERCOT_LONG_HORIZON_INGEST_ENABLED`, and
  `EXTERNAL_CONTEXT_INGEST_ENABLED`, plus each corresponding endpoint variable.
- NWS identity: `NWS_WEATHER_USER_AGENT`.
- Reserved optional EIA credential: `EIA_API_KEY`.

Preserve unknown live variables too. Fetching only the Portainer stack file is
insufficient: the authorized deployer must also fetch stack metadata and retain
the complete `Env` array. `EIA_API_KEY` must remain empty in this bounded slice;
`DEMO_KEY` is never a production credential. Supplying a real EIA key does not
enable EIA-930 or Henry Hub in the current implementation.

## Disabled-state and process-liveness contract

Every opt-in defaults to the exact string comparison `=== "true"`; missing,
empty, or differently cased values are disabled. Disabled runners make no
upstream requests and must remain pending because the collector supervises all
runners with `Promise.race`.

PR23 found and resolved a release blocker in the external-context runner: its
disabled path originally resolved, which could terminate and restart the whole
collector under the default `EXTERNAL_CONTEXT_INGEST_ENABLED=false`. The frozen
contract is now `startExternalContext(): Promise<never>` with a regression that
proves another runner wins the race and the disabled runner performs zero
fetches. That regression is a promotion gate.

The receiver has a Docker health check on `/api/status`; the collector has no
Docker health check. A running collector container therefore proves process
liveness only, not successful collection. Container restart count, collector
logs, source timestamps, section state, and source-health rows are all required.

## Error and operator-truth matrix

| Condition                                       | Observable behavior                                                              | Required interpretation/action                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Receiver has no configured `METRICS_API_KEY`    | authenticated POST returns `500 {"error":"missing_api_key"}`                     | deployment configuration failure; do not enable sources                              |
| Missing or wrong collector key                  | authenticated POST returns `401 {"error":"unauthorized"}`                        | receiver rejected the collector; repair the shared secret                            |
| Receiver rate limit                             | `429` and no accepted mutation                                                   | inspect retry/log behavior; do not treat it as an empty source                       |
| ERCOT Public API 429/5xx/timeout                | bounded retry with jitter and bounded `Retry-After` support                      | verify eventual success or explicit failed health                                    |
| NWS 429/5xx/timeout                             | bounded backoff; reviewed stale cached data may remain selected                  | selected data can be stale while source health is failed                             |
| Texas Grid product failure                      | per-product `/source-attempt` failure; other product may still succeed           | verify product isolation and later recovery                                          |
| EPA eGRID failure                               | `/api/external-context/source-attempt` failure; prior selected resource retained | failure is not a valid empty resource                                                |
| Collector cannot reach/authenticate to receiver | failure report cannot be persisted through the same broken path                  | receiver health may remain last-good; collector logs/restarts are mandatory evidence |
| Receiver/materialization 5xx                    | current pointer/generation must not advance                                      | retain last-good state and investigate before retry                                  |

Source state and data availability are separate dimensions. A section may keep
a valid selected last-good resource while its source-health row reports a newer
failure. Conversely, disabled or methodologically unavailable sections must not
be reported as failed merely because no collection was attempted.

## Promotion sequence

1. Merge the stack in dependency order and rerun all deterministic tests at the
   resulting main commit. Publish receiver and collector images from that same
   commit; record tag, digest, and OCI revision for both.
2. From the current live Portainer stack, export metadata, Compose, the complete
   `Env` array, container image IDs/digests, restart counts, public source-health
   output, and a consistent SQLite backup. Never derive the update payload from
   the repository's `:local` Compose file.
3. Update with matching pinned receiver and collector images, all newly added
   opt-ins false, `PullImage=true`, and `Prune=false`. Preserve volumes, ports,
   proxy/network configuration, existing credentials, and unknown environment
   entries.
4. Verify receiver health and legacy data freshness, then verify every new public
   route returns its documented disabled, unavailable, or empty state. Confirm
   an unauthenticated ingest gets 401 and the collector does not restart-loop.
5. After the receiver is stable, request historical context once to exercise its
   bounded lazy materialization. Observe latency, CPU, database growth, response
   state, selected resource URL, and subsequent ETag/304 behavior.
6. Enable one reviewed source per complete Env-preserving stack update. A safe
   order is market geography, NWS, Texas Grid, then EPA eGRID. Validate each
   source before proceeding; do not enable EIA-930, Henry Hub, or EPA CAMD.
7. Through the real public origin, verify response bodies, strong ETag/304,
   canonical selected immutable URLs, source timestamps, failure/recovery
   counters, collector logs, image digests/revisions, and zero unexpected
   restarts. An HTML shell or `/api/status` alone is insufficient.

The first successful collector cycle is immediate for these runners; no operator
should wait for the nominal six-hour or weekly interval before deciding whether
the initial deployment succeeded.

## Rollback sequence

1. Disable the affected new source first. If the failure is cross-cutting, stop
   the collector before changing receiver state.
2. Restore both previous matching pinned image references using the saved full
   Compose and complete `Env` array, with `PullImage=true` and `Prune=false`.
3. Leave additive tables in place when the old receiver ignores them. Do not
   delete tables, prune volumes, or treat rollback as data cleanup.
4. Restore the database only if compatibility review requires it. Stop the
   receiver and restore a coherent backup; never restore only a live SQLite main
   file while discarding its active WAL/SHM state.
5. Reverify old-route freshness, public response bodies, source health, image
   digests/revisions, container restart counts, and desktop/mobile access through
   the real origin.

## Deterministic promotion gates

- Production and development Compose expansion succeeds with a non-secret dummy
  key, and both contain the new opt-in names and exact internal ingest paths.
- No tracked `.env` file contains runtime secrets; `.env.example` contains names
  and placeholders only.
- Receiver and collector images are pinned to the same source revision, not
  `latest` or the repository's `:local` tags.
- The disabled external-context race/zero-fetch regression passes.
- Every authenticated new POST returns 401 without a key and does not mutate its
  current pointer or source health.
- A successful source observation followed by 429/5xx/network failure preserves
  last-good data, exposes failed health where the receiver is reachable, and a
  later valid success resets health without duplicating a publication.
- Queryless manifests reject query aliases; selected immutable URLs return the
  exact content version and support strong ETag/304.
- Portainer change evidence includes the pre-change complete `Env`, previous and
  new digests, database backup identity, `Prune=false`, post-change restarts, and
  a tested rollback payload. Values of secret entries remain redacted.

## Known gaps requiring an operator decision

- There is no collector health check or independent delivery telemetry. A shared
  key/network failure can prevent both ingest and failure reporting, so source
  health alone cannot prove the collector is working.
- Production Compose binds receiver port 8080 on all host interfaces. Preserve
  the live architecture during this campaign, but verify the existing firewall,
  reverse-proxy, and public exposure boundary before approval.
- EIA credential wording in the receiver README can imply that a non-DEMO key
  enables EIA. The current implementation does not; the external-context method
  document is the authoritative bounded behavior.
- This audit used repository and local deterministic evidence only. Current
  Portainer stack identity, Env values, image digests, database size, source
  freshness, Cloudflare behavior, and rollback viability remain unverified until
  an authorized preflight.
