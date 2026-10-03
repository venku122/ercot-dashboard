# ERCOT Grid Observatory - technical human-review packet

Date: 2026-08-27  
Repository: `venku122/ercot-dashboard`  
Review stack: PR #33 through PR #55  
Status: **READY FOR DETAILED HUMAN REVIEW / CONDITIONAL MERGE CANDIDATE**

This is a review candidate, not a deployment approval. Nothing was merged or deployed while this
packet was prepared. Production, Portainer, production SQLite, collectors, Cloudflare, and DNS were
not changed.

## 1. Executive disposition

The stacked implementation is ready for detailed code, architecture, data-semantics, visual, and
operational review. The most important remediation is complete: PR #37 no longer writes generated
generic canonical tile bodies to SQLite or the filesystem. SQLite observations remain authoritative;
the receiver retains only a bounded process LRU, coalesces concurrent work with singleflight, and
uses normal HTTP/CDN/browser caching. Restart and correction behavior is covered by deterministic
acceptance tests and a 300-window benchmark.

The current four-second ESR source remains **BLOCKED_EXTERNAL - ACCEPTED SCOPE LIMIT**. ERCOT ended
that live feed after 2025-12-05. The product truthfully exposes five-minute system-wide aggregate
storage context and does not claim resource identity, SOC, high-resolution battery response, or
causal attribution.

## 2. Review boundaries and evidence rules

- All data shown in the curated screenshots is deterministic synthetic review-fixture data.
- New forecast-quality and net-load screenshots include the visible label
  `DETERMINISTIC SYNTHETIC REVIEW FIXTURE`; the remaining screenshots are existing deterministic
  Playwright fixtures and are labeled as synthetic in this packet and their test sources.
- No production browser session, database, token, credential, or source row is embedded.
- Counts of reviews or comments are not used as quality evidence.
- Domain-specific immutable resources (for example publication snapshots) remain where their
  reviewed contracts require content versioning. The removed persistence was the generic canonical
  tile-body store.

## 3. Architecture

### 3.1 System context

![System context](review-evidence/diagrams/01-system-context.png)

Collectors strictly parse official source contracts and preserve source clocks, provenance, and
health. The receiver owns normalized SQLite state and bounded API materialization. The browser owns
window planning, lazy lifecycle, exact tables, and user-facing truth boundaries.

### 3.2 Canonical tile request path

![Canonical tile request paths](review-evidence/diagrams/02-canonical-tile-request-paths.png)

The canonical tile path is memory-only after generation. On a cold receiver, one bounded SQLite
query generates deterministic JSON and an ETag. Warm receiver, CDN, and browser paths avoid SQLite.
No generic tile body file or `tile_resources` table is created.

### 3.3 Restart and correction behavior

![Restart and correction](review-evidence/diagrams/03-restart-and-correction.png)

A receiver restart intentionally loses its LRU. The next request regenerates identical bytes and
ETag from the same observations. A corrected observation invalidates intersecting ranges only;
unrelated tiles remain cache hits and byte-identical.

### 3.4 Frontend tile planner

![Frontend planner](review-evidence/diagrams/04-frontend-tile-planner.png)

The production planner combines native edge tiles with canonical 1-hour or 1-day interior tiles.
Exact URLs coalesce repeat callers. Points are parsed and merged by timestamp without interpolation.

### 3.5 Provenance and semantics

![Provenance](review-evidence/diagrams/05-data-provenance-and-semantics.png)

Official publications, source observations, and dashboard-derived annotations remain distinct. A
shared UTC viewport is a display relationship only; it does not establish contribution or cause.

### 3.6 Deployment and rollback

![Deployment and rollback](review-evidence/diagrams/06-deployment-and-rollback.png)

Deployment is explicitly outside this remediation. If separately approved, use pinned matching
images, preserve the complete Portainer environment, keep new sources disabled initially, use
`Prune=false`, enable one source at a time, and retain a collector-first rollback.

## 4. Cache and storage contract

| Layer                         | Stores generated tile bodies?      | Lifetime / invalidation                             | Role                      |
| ----------------------------- | ---------------------------------- | --------------------------------------------------- | ------------------------- |
| SQLite metrics                | No                                 | Authoritative observations; corrections update rows | Source of truth           |
| Receiver LRU                  | Yes, memory only                   | Bounded process lifetime; exact range invalidation  | Origin acceleration       |
| Receiver singleflight         | In-flight only                     | One leader per canonical key                        | Concurrency control       |
| CDN / HTTP cache              | Response bytes                     | Origin-directed revalidation                        | Shared delivery           |
| Browser cache / promise reuse | Response bytes / in-flight promise | Navigation lifetime and HTTP policy                 | Client acceleration       |
| Filesystem                    | No                                 | Not applicable                                      | No generic tile artifacts |

The old age-only `immutable` tile claim is removed. Older generic tiles currently use finite
revalidation (`max-age=60, s-maxage=300, must-revalidate`). Hashed frontend assets and separately
reviewed domain publication resources have their own explicit contracts.

## 5. Performance evidence

The benchmark runs the production TypeScript planner over 300 deterministic overlapping windows:
50 each of 6 hours, 24 hours, 7 days, 30 days, 90 days, and 1 year. The synthetic SQLite fixture
contains 247,680 five-minute observations across two physical series and 430 days.

| Range | Unique v2 URLs | App hit ratio |  Reuse |   Cold p50/p95/p99 ms |   Warm p50/p95/p99 ms | Warm SQL |
| ----- | -------------: | ------------: | -----: | --------------------: | --------------------: | -------: |
| 6h    |             30 |         71.4% |  3.50x | 1.292 / 6.635 / 7.137 | 0.266 / 1.157 / 1.175 |        0 |
| 24h   |             81 |         66.0% |  2.94x | 1.038 / 5.630 / 5.737 | 0.277 / 1.088 / 1.130 |        0 |
| 7d    |            100 |         85.2% |  6.76x | 1.039 / 5.646 / 5.832 | 0.281 / 1.082 / 1.107 |        0 |
| 30d   |            123 |         93.3% | 14.85x | 1.054 / 5.469 / 5.611 | 0.281 / 1.077 / 1.087 |        0 |
| 90d   |            183 |         96.2% | 26.37x | 1.801 / 5.434 / 5.664 | 0.353 / 1.108 / 1.195 |        0 |
| 1y    |            459 |         97.5% | 40.47x | 1.857 / 2.259 / 5.583 | 0.371 / 0.415 / 1.102 |        0 |

Across all ranges, v2 used 623 unique URLs versus 554 in the v1 comparison: v2 has 69 more unique
URLs because unaligned windows require exact native edge tiles. The packet does not misstate this as
a cardinality reduction. The benefit is canonical application reuse: 26,247 references coalesced to
623 URLs (42.13x overall), and every warm run performed zero SQLite statements.

Concurrency evidence: ten same-key clients produced one leader, nine waiters, and one SQLite
generation. Two different keys produced two leaders and two generations. Restart evidence produced
a cold MISS and one generation with identical bytes/ETag and no persistent tile artifact. Correction
evidence changed the affected tile only.

See `review-evidence/2026-08-27--performance-matrix.md`, JSON, and CSV for full metrics.

## 6. Data products and truth boundaries

| Surface                   | Source/time basis                                  | Truth boundary                                           |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Overview and Grid Outlook | ERCOT operational observations and forecasts       | Operational context; no external replacement             |
| Forecast quality          | Matched official forecast and actual vintages      | Diagnostic product pairing, not ERCOT score              |
| Net load and ramp         | Demand minus wind and solar                        | Dashboard-derived; no interpolation or cause             |
| Regional geography        | Reviewed settlement-point allowlists               | Labeled matrix/tile geography; no invented node polygons |
| Market mechanics          | Exact coherent SCED publications                   | Same-SCED context; no causal decomposition               |
| Congestion geography      | LMP/SPP and coincident constraints                 | Constraints do not prove point-price contribution        |
| Storage operations        | Five-minute system-wide aggregate                  | No SOC, resource identity, dispatch intent, or revenue   |
| Storage replay            | Multi-cadence UTC display window                   | Not four-second battery-response attribution             |
| Predictive weather        | Four representative NWS airport points + TX alerts | Not ERCOT weather zones or grid alerts                   |
| Unified event timeline    | ERCOT/NWS/source/derived evidence                  | Provenance classes remain separate; TXANS gap visible    |
| Historical context        | Observed local-calendar peers                      | Dashboard-derived, not ERCOT record or forecast          |
| Texas Grid                | Official planning snapshots                        | Planned/studied is not installed or committed capacity   |
| External context          | EPA eGRID bounded annual context                   | Not live emissions and not ERCOT operational authority   |

## 7. Visual review index

Every image below is synthetic test evidence. Desktop and iPhone WebKit views are paired. The two
new populated evidence fixtures visibly carry the synthetic label. Automated tests separately check
lazy requests, exact tables, keyboard/focus, internal horizontal scrolling, and page containment.

### 7.1 Overview

![Overview desktop](review-evidence/visuals/01-overview-desktop.png)
![Overview mobile](review-evidence/visuals/01-overview-mobile.png)

### 7.2 Grid Outlook

![Grid Outlook desktop](review-evidence/visuals/02-grid-outlook-desktop.png)
![Grid Outlook mobile](review-evidence/visuals/02-grid-outlook-mobile.png)

### 7.3 Forecast quality

![Forecast quality desktop](review-evidence/visuals/03-forecast-quality-desktop.png)
![Forecast quality mobile](review-evidence/visuals/03-forecast-quality-mobile.png)

### 7.4 Net load and ramp

![Net load desktop](review-evidence/visuals/04-net-load-desktop.png)
![Net load mobile](review-evidence/visuals/04-net-load-mobile.png)

### 7.5 Regional geography

![Regional geography desktop](review-evidence/visuals/05-regional-geography-desktop.png)
![Regional geography mobile](review-evidence/visuals/05-regional-geography-mobile.png)

### 7.6 Market mechanics

![Market mechanics desktop](review-evidence/visuals/06-market-mechanics-desktop.png)
![Market mechanics mobile](review-evidence/visuals/06-market-mechanics-mobile.png)

### 7.7 Congestion and price geography

![Congestion geography desktop](review-evidence/visuals/07-congestion-geography-desktop.png)
![Congestion geography mobile](review-evidence/visuals/07-congestion-geography-mobile.png)

### 7.8 Storage operations

![Storage operations desktop](review-evidence/visuals/08-storage-operations-desktop.png)
![Storage operations mobile](review-evidence/visuals/08-storage-operations-mobile.png)

### 7.9 Multi-cadence storage context replay

![Storage replay desktop](review-evidence/visuals/09-storage-replay-desktop.png)
![Storage replay mobile](review-evidence/visuals/09-storage-replay-mobile.png)

### 7.10 Predictive weather

![Predictive weather desktop](review-evidence/visuals/10-predictive-weather-desktop.png)
![Predictive weather mobile](review-evidence/visuals/10-predictive-weather-mobile.png)

### 7.11 Unified grid event timeline

![Event timeline desktop](review-evidence/visuals/11-event-timeline-desktop.png)
![Event timeline mobile](review-evidence/visuals/11-event-timeline-mobile.png)

### 7.12 Historical context

![Historical context desktop](review-evidence/visuals/12-historical-context-desktop.png)
![Historical context mobile](review-evidence/visuals/12-historical-context-mobile.png)

### 7.13 Texas Grid long-horizon planning

![Texas Grid desktop](review-evidence/visuals/13-texas-grid-desktop.png)
![Texas Grid mobile](review-evidence/visuals/13-texas-grid-mobile.png)

### 7.14 External context

![External context desktop](review-evidence/visuals/14-external-context-desktop.png)
![External context mobile](review-evidence/visuals/14-external-context-mobile.png)

## 8. Human review checklist

- [ ] Confirm PR #37 has no generic tile body schema, file write, persistence helper, or exact child route.
- [ ] Confirm restart/correction acceptance describes deterministic regeneration, not retained old bodies.
- [ ] Review all six architecture diagrams against production code.
- [ ] Review benchmark methodology and the honest negative v1-to-v2 unique-URL comparison.
- [ ] Review desktop/mobile visuals for layout, labeling, gaps, stale/partial states, and exact tables.
- [ ] Confirm official/source-observation/derived provenance remains visible and machine-checkable.
- [ ] Confirm no causal claims or cross-product nearest-time joins were introduced.
- [ ] Confirm all unsupported sections show unavailable/deferred rather than zero.
- [ ] Confirm the four-second ESR status is accepted as an external scope limit.
- [ ] Confirm exact-head CI, range-diff, stack base/head topology, secret scan, build, and Compose evidence.
- [ ] Approve or reject merge separately from any production rollout.
- [ ] If merge is approved, require a second explicit deployment approval using the handoff runbook.

## 9. Deployment summary

The complete deployment and rollback procedure is in
`2026-08-27--ercot-observatory-review-remediation-handoff.txt`. The safe sequence is: preserve exact
live stack and complete Env, deploy matching pinned images with all new opt-ins disabled and
`Prune=false`, prove routes/auth/freshness/restart behavior, enable one source at a time, then consider
a separately approved Cloudflare rule. Rollback disables collectors first and restores both prior
images plus the complete previous Env.

## 10. Final statement

**READY FOR DETAILED HUMAN REVIEW / CONDITIONAL MERGE CANDIDATE**

Nothing was merged or deployed during this work. Production, Portainer, production SQLite,
collectors, Cloudflare, and DNS remain unchanged.
