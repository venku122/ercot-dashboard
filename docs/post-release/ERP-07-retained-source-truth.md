# ERP-07 retained collection status and shared adequacy eligibility

Independent synthetic regressions demonstrated two correctness defects. A valid-empty latest collection with retained forecast rows appeared ready/partial without the collection notice. The compact outlook rejected headroom lacking its own reported capacity, while the specialist cards and hourly details still displayed it.

The compact surface now identifies valid-empty retained load forecasts and independently reports valid-empty adequacy collection status. Retained values and original publication times remain readable. The shared model applies the same eligible publication and same-row capacity/headroom criteria to Next 24, specialist summary, day cards and hourly details. Publications issued after the current clock provide no eligible future rows.

Two original independent regressions failed before the repair. Nineteen focused model/component checks and ten actual browser checks passed afterward. Browser checks include both product notices without hiding the forecast, compact/specialist unavailable headroom, one shared request owner, historical pin stability, failures, stale values, valid-empty/no-publication states and responsive zoom.

The integrated zoom rules also exposed an ordinary 390px fixed-range header regression: the picker consumed the full flex row, putting the compare control on another row and moving the first canvas to 342.8px against the unchanged 320px ceiling. In ordinary phone containers the picker now has a bounded 200px flex basis, allowing the adjacent compare control to share the row. Narrow zoomed containers retain wrapping. The unchanged first-plot ceiling and 320/768 zoom regressions pass; no threshold or screenshot tolerance was relaxed.

Full static/frontend/receiver/contract validation runs through the normal commit hook. Final cumulative evidence and CI remain separate from these local focused results.
