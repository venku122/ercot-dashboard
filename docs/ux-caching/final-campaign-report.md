# Production UX and caching campaign report

## Outcome

The seven-draft stack is implementation-complete and locally accepted. The planned six slices are
followed by one narrowly scoped hardening draft created because integrated iPhone WebKit testing
found a real 18 px time-range target. Production promotion is **held**, not failed: the Portainer
credential/certificate path is unavailable without bypassing a certificate warning, so no remote
mutation was attempted.

Prerequisite PR [#11](https://github.com/venku122/ercot-dashboard/pull/11) merged as
`73ecb29c24cb9a9b26546cb4c8e92e3c48c07fd5` before the campaign branches were cut.

## Review stack

| Order | Draft                                                      | Base                               | Scope                                                                                            |
| ----- | ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1     | [#25](https://github.com/venku122/ercot-dashboard/pull/25) | `main`                             | Source correctness, honest lifecycles, disabled unsupported outage source, Diagnostics ownership |
| 2     | [#26](https://github.com/venku122/ercot-dashboard/pull/26) | `campaign/01-source-lifecycle`     | SWR refresh policy, stable keys, previous-data retention, focus/reconnect behavior               |
| 3     | [#27](https://github.com/venku122/ercot-dashboard/pull/27) | `campaign/02-swr-refresh`          | Canonical historical chunks, sealed receiver cache, ETags, browser/edge cache policy             |
| 4     | [#28](https://github.com/venku122/ercot-dashboard/pull/28) | `campaign/03-cache-architecture`   | Stable Overview readings and concise weighted Grid Health summary                                |
| 5     | [#29](https://github.com/venku122/ercot-dashboard/pull/29) | `campaign/04-overview-grid-health` | View hierarchy, Market naming/cadence/ranking context, reliability cleanup                       |
| 6     | [#30](https://github.com/venku122/ercot-dashboard/pull/30) | `campaign/05-hierarchy-market`     | METAR wind direction/gust, Weather conditions, robust time-error recovery trend, iPad projects   |
| 7     | [#31](https://github.com/venku122/ercot-dashboard/pull/31) | `campaign/06-weather-analytics`    | WebKit tap-target fix, realistic QA fixtures, macOS/Linux visual baselines                       |

Every listed base is an ancestor of its head. PR 1 contains two test-only follow-ups discovered by
CI: reviewed Linux visual baselines and deterministic alert-details timing. PR 6 contains one
test-only follow-up for the new time-error headings. PR 7 contains the integrated hardening changes
and cross-platform baselines.

## Acceptance evidence

### Deterministic gates

- Static/type/lint/format checks pass.
- Frontend: 92 tests pass.
- Receiver: 28 tests pass.
- Collector: 15 fixture tests pass, including the minimized current METAR payload.
- Desktop Chromium: 27 semantic and visual-regression tests pass on macOS.
- Mobile: 45 tests pass across Pixel Chromium, iPhone Pro Max WebKit, compact Chromium, and iPhone
  landscape WebKit.
- Tablet: two WebKit tests pass at 834×1194 and 1194×834 with no horizontal overflow.
- Production bundle builds successfully.
- Secure Compose accepts the required API key and rejects a missing key in CI.

### Cache and performance

The final local receiver benchmark used 105,120 tagged rows. The processed-chunk cache retained
sealed entries through unrelated live ingest and recorded an 84.6% hit ratio in the deterministic
scenario. Warm median speedups were approximately 315× for six hours and 2,872× for seven days.
The browser performance suite reported no long tasks in the final local mobile run and bounded heap
growth below the existing budget.

Cloudflare activation remains an operator step. The exact cache-rule contract and purge/rollback
procedure are in [03-receiver-cloudflare-cache.md](./03-receiver-cloudflare-cache.md); no edge rule
was mutated during this campaign.

### Live public sources

The candidate live verifier passed against current public payloads:

- Fuel Mix: eight fuels, 16 normalized metrics, 2,608 points.
- Supply/Demand: 38 actual rows plus forecast data, 364 metric points.
- Wind/Solar: 48 source rows, 10 metrics, 292 points with a current actual-data timestamp.
- Generation outages: 1,766 rows and 17,660 points.
- Operations messages: 24 structured events.
- Aviation Weather: KAUS, KDFW, KHOU, and KSAT returned numeric wind bearings; KDFW included the
  optional gust field. The collector preserves each official `obsTime`.

The cadence labels used in Market follow ERCOT's official products: real-time settlement point
prices are published on a 15-minute cadence, while SCED LMP is a separate 5-minute product.

### Visual inspection

Reviewed final surfaces include Overview, expanded Grid Health factors, Generation/Fuel,
Reliability, Market, Weather, Advanced, Diagnostics, analysis controls, inspect mode, iPhone
portrait/landscape, and iPad portrait/landscape. Repository baselines cover macOS Chromium/WebKit
and Ubuntu Chromium/WebKit. Additional iPad evidence is retained locally at
`/tmp/ercot-pr6-visual-evidence`.

## Production hold and recovery gate

Public production at <https://ercot.tarazevits.io> is still running the pre-campaign deployment.
A read-only probe on 2026-08-14 showed:

- `fuel_mix`: collection failed with `fuel_mix_schema_invalid`, roughly eight days since valid data.
- `supply_demand`: source health reported fresh, but returned demand/capacity points were roughly 23
  days old. This is the false-health condition fixed by PR 1.
- `wind_solar`: collection healthy but the legacy health payload did not expose a data timestamp.

Deployment requires the protected Portainer credentials and a trusted management endpoint. The
available browser path presents an untrusted-certificate interstitial; the campaign did not bypass
it. Therefore the following production acceptance items remain pending:

1. Back up the current Portainer stack definition and environment array.
2. Deploy the merged/pinned receiver and collector images with `Prune=false` while preserving the
   stack environment.
3. Confirm OCI revision labels and image IDs.
4. Verify fresh Fuel Mix, Supply/Demand actuals, Wind/Solar actuals, and source timestamps directly
   from the production API.
5. Run public desktop/mobile smoke tests through the real origin.
6. Activate the reviewed Cloudflare cache rules only after receiver validation, then verify HIT,
   MISS, ETag/304, purge, and rollback behavior.

Until all six steps pass, production recovery and CDN activation must remain marked pending.
