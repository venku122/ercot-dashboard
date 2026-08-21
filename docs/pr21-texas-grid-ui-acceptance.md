# PR 21 — Texas Grid long-horizon UI acceptance

## Truth boundary

The Texas Grid view presents versioned official planning-report snapshots. It does not reuse the
dashboard's operating-capacity tiles, treat interconnection study status as a commitment, or call a
net capacity change an addition or retirement.

- Generator Interconnection Status displays project-row counts and signed source capacity sums by
  official study phase and fuel. Negative MW may be a repowering net-change adjustment. No project
  identity or geography is exposed.
- Resource Capacity Trend keeps `operational_mw`, IA/security categories, `other_planned_mw`, and
  `small_generator_mw` separate. `official_total_mw` is a source total and is never stacked with or
  added to those components. A null source category is shown as source-absent, never zero.
- Long-term load forecast displays the exact ERCOT-adjusted and TSP-provided monthly scenarios. Peak
  MW and energy MWh are bound to Appendix A of the official methodology report. Large-load forecast
  assumptions are context only; project status and gross retirements retain their exact unavailable
  reasons. The UI does not borrow an adjacent source to fill them.

## Request and cache lifecycle

1. Outside `view=texas-grid`, the feature makes zero manifest or immutable-resource requests.
2. Entering the view makes exactly one queryless `GET /api/v1/texas-grid` request. No resource is
   fetched until the user explicitly opens Generator Interconnection, Resource Capacity Trend, or
   Long-Term Load Forecast.
3. Only the selected manifest URL is fetched. It is queryless, same-origin, versioned by `tg1-...`,
   and parsed against the selected publication clocks, period, page URL, and stream.
4. Switching selection aborts the previous resource request. Leaving the view and unmounting abort
   in-flight work. A late prior completion cannot replace the current selection.
5. `grid_resource=gis|resource_capacity_trend|long_term_load_forecast` is the canonical optional selection. Initial load and
   back/forward restore it; closing a resource removes it. The ordinary dashboard time controls are
   not shown because these reports use source annual/month periods, not the operating time window.
6. A manifest refresh failure may retain only the last successful manifest for the same key and is
   labeled. Immutable resources never mix across content-version URLs.

## Strict parser acceptance

- Exact keys, literals, order, bounds, URL allowlists, content versions, source periods, publication
  ordering, source-health cardinality/order, registry order, and unavailable reasons are required.
- GIS accepts signed capacity sums through the receiver bound and canonical fuel IDs, while rejecting
  source codes in aggregate rows, unknown phases/fuels, duplicates, or non-registry order.
- Trend accepts exactly five ordered series and nonempty bounded annual/monthly rows. Periods are
  unique and ascending. The official total must equal every present component within receiver
  tolerance; only `other_planned_mw` may be null.
- LTLF accepts exactly two ordered 240-month scenarios, the fixed workbook and report URLs, the
  Appendix-A unit-binding literal, ascending calendar months, and bounded finite MW/MWh values.
- The two capacity workbook URLs must be the official same-publication annual/monthly pair and match
  `source_period`. Query strings, fragments, credentials, alternate hosts, and poisoned extra keys fail.

## UI, mobile, and VRI gates

- Texas Grid is a lazy ninth dashboard view in More. Navigation focus, direct URL load, reload, and
  back/forward are deterministic.
- Resource-family and series controls have at least 44 px targets. Status and copy are available to
  assistive technology without color-only meaning.
- The page never creates body-level horizontal overflow at 440 px. Exact evidence tables own their
  horizontal scrolling, have a named region and `tabindex=0`, and retain unshortened values.
- Desktop Chromium and iPhone Pro Max WebKit baselines are visually reviewed on Darwin and pinned
  Playwright Noble. Every update is followed immediately by a no-update comparison. Mobile CI must
  include the PR21 spec.
