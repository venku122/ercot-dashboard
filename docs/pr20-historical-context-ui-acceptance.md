# PR20 historical context frontend acceptance

The Overview exposes one demand-only disclosure, **Historical context and records**. It is closed by
default and makes no historical-context request while closed or outside Overview. `history=1`
restores the open disclosure through reload and Back/Forward navigation. The global compare control
is unchanged; PR20 does not add a year mode or a generic series selector.

Opening resolves exactly one canonical hour-aligned request:

`GET /api/v1/historical-context?series_key=supply-demand.demand&as_of=<UTC hour>`

The panel renders the resolver's embedded summary. It never follows the immutable v2 resource URL,
so opening creates no resource fanout. A changed `as_of`, collapse, view change, or unmount aborts the
active request. A late completion from an old `as_of` cannot appear under the new selection. A failed
refresh of the same canonical hour may retain the last successful summary only with explicit
refresh-failed and last-good wording plus its exact as-of timestamp.

The parser requires the receiver's exact allowlists, fixed policy/methodology/series/unit/statistic,
hour fold intervals, source coverage counts and observation bounds, Type 7 cohort evidence,
partial/complete rank evidence, rolling extrema, retention boundary, content-version pattern, and
canonical immutable URL. Extra keys, nonfinite values, incoherent counts/ratios/states, altered
identity, and poisoned URLs fail closed.

The UI distinguishes pending, unavailable, partial, available, and refresh-failed states. Copy says
"dashboard observations since collection began" and does not call the result a forecast, causal
explanation, historical normal, or all-time ERCOT record. Previous day/week/year preserve the same
America/Chicago civil hour; missing observations are not filled or borrowed.

The exact evidence table contains the selected hour, three calendar comparisons, same-season
same-hour percentiles, completed-day rank, and four observed-extrema windows. State, value/timestamp,
coverage, exclusions, and method are available as text rather than color alone. The table owns
horizontal scrolling, the open/close control is at least 44px, and neither desktop nor iPhone layouts
may create body overflow.

The superseded unconditioned **Price Percentile** and elapsed-24-hour **Historical Comparison** cards
and their two series queries are removed. The remaining calculated-insight cards continue to use
their existing bounded inputs.

Deterministic gates are the strict parser acceptance, jsdom abort/no-mixing lifecycle acceptance,
Chromium browser flow and VRI, iPhone WebKit containment/target checks and VRI, immediate no-update
comparisons, and pinned Noble Chromium/iPhone baselines. The mobile workflow command includes
`e2e/mobile-historical-context.spec.ts`.
