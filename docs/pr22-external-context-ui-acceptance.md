# PR 22 external-context UI acceptance

## Truth boundary

The External Context view is secondary, lazy context. It never replaces, backfills, validates, or
silently substitutes for an ERCOT operational observation. Coincident EIA-930 demand or
interchange, Henry Hub price, and EPA eGRID annual rates do not establish causality.

- EIA-930 values are delayed, preliminary one-hour energy observations in `megawatthours`, not
  instantaneous ERCOT MW. Positive total interchange is EIA net export/outflow; negative is net
  import/inflow.
- Henry Hub is a civil-date daily spot price in `usd_per_mmbtu`. Missing weekends and holidays are
  gaps, not zeroes or values to fill.
- EPA eGRID values are seven source-published retrospective annual ERCT average output emission
  rates in `lb_mwh`. They are not current, marginal, generator-specific, or ERCOT-wide mass
  emissions. The dashboard does not multiply them by live demand or generation.
- EPA CAMD remains unavailable with reason
  `ercot_footprint_and_coverage_methodology_not_frozen`. It is never shown as zero.
- Missing, blank, whitespace-only, or `DEMO_KEY` EIA credentials disable EIA-930 and Henry Hub
  independently with `eia_api_key_not_configured`. A rejected configured credential is failed, not
  disabled. Public UI and fixtures contain no credential.

The public policy is
`external_context_not_ercot_operational_authority_or_live_emissions_measurement`.

## Request and URL lifecycle

- The view is code-split under More and canonical at `view=external-context`.
- There are zero external-context requests outside the view. The general Overview latest, health,
  baselines, derived context, and events fanout is also disabled in Outlook, Texas Grid, and
  External Context.
- Entering the view performs exactly one queryless manifest request. No immutable resource is
  requested until the user opens or URL-selects an available section.
- At most the selected section resource is requested. Disabled, unavailable, and failed sections
  never trigger a resource request.
- The allowlisted `context_source` selector restores on reload and browser back/forward. Leaving the
  view removes it from the canonical URL.
- Selection change, collapse, view exit, and unmount abort the prior resource request. A late prior
  response cannot replace or mix with the current selection. The view does not retain prior-source
  rows while another source loads or fails.

## Strict public data

The queryless manifest and selected immutable resource are parsed with exact key allowlists,
literal schema/kind/policy/stream identities, finite bounded values, ordered registries, bounded
cardinality, and cross-field state/provenance invariants. Selected links are queryless same-origin
paths whose `xc1-` content version matches the route. Unknown fields and malformed state fail
closed.

Every available evidence surface exposes the source identity, native cadence/time basis, unit,
retrieval/release identity, freshness, and exact values in a table. eGRID always shows data year,
revision, release date, ERCT / ERCOT All, artifact identity, and all seven exact rate metrics.
Partial source availability remains visible: one failed or disabled source cannot hide a valid
eGRID resource or regress another cached last-good resource.

## Interaction and visual acceptance

- Section controls are semantic buttons with at least a 44 by 44 CSS-pixel target and visible
  keyboard focus. State is conveyed by text, not color alone.
- Loading, disabled, unavailable, failed, stale-last-good, and refresh-failed states use explicit
  copy. Disabled and unavailable are not empty datasets.
- Exact evidence tables own horizontal scrolling, are keyboard focusable, and do not create body
  overflow at 375, 390, or 440 CSS-pixel widths or iPhone landscape.
- Desktop Chromium and iPhone WebKit screenshots are reviewed on Darwin and pinned Playwright Noble,
  followed immediately by no-update comparisons. CI includes the populated PR 22 mobile spec.

## Deferred

Live CAMD integration, causal joins, fill/interpolation, same-hour Henry Hub alignment, national
comparison expansion, and replacement of ERCOT feeds are outside PR 22. They require separately
reviewed source, geography, unit, coverage, revision, and retention contracts.
