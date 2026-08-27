# PR15 market-geography API and UI acceptance

This is the independent black-box acceptance boundary for the receiver and browser. Source parsing,
timestamp normalization, exact CSV headers, and units are frozen separately in
`pr15-market-geography-acceptance.md`.

## Coherent current state

Each available NP6-788 LMP or NP6-905 Settlement Point Price matrix contains exactly one finite
`$/MWh` reading for each of the seven reviewed hubs and eight reviewed load-zone identities at one
exact target timestamp. A missing, duplicated, unexpected, or differently timed identity makes the
layer partial or unavailable. The receiver and UI never borrow an independently latest value to
complete a newer matrix.

NP6-86 current constraints all share the manifest's exact SCED timestamp and repeated-hour flag.
Rows are deterministically ordered and bounded. A successful bounded query with no rows means only
that the query returned no rows; it is not displayed as proof that no congestion existed.

The LMP, SPP, and constraint products are contemporaneous context with different cadences and bases.
No API or UI field may claim a cause, contribution, allocation, attribution, calculated price, or
exact decomposition between them.

## HTTP and caching

Authenticated ingest is `POST /api/market-geography-publications/ingest`. The current manifest is
the queryless `GET /api/v1/market-geography`. Completed-day resources use only:

`/api/v2/market-geography/{kind}/{identity}/v1/{content_version}/1d/{utc_day_start}/native`

The route allowlists `kind` and identity grammar, requires a canonical version, aligned non-negative
UTC day, and `native` LOD, and rejects aliases, leading-zero days, query strings, or raw names with
`no-store`.

The manifest has a deterministic ETag, short public/browser and shared-cache lifetime,
`must-revalidate`, receiver singleflight, and explicit ingest dependencies. Ingest racing manifest
generation cannot leave a stale result stored after commit.

Open-day ingestion creates no immutable full-day resource. Rollover seals the prior day once and an
unchanged replay creates no version. A completed-day correction creates a new content version only
for affected identities. A previously advertised URL retains byte-identical content and ETag for
its advertised lifetime. Raw rows and retired versions are pruned only under a bounded retention
policy that cannot break a still-cacheable URL.

## Browser lifecycle

- Outside Market and while collapsed, the feature performs zero market-geography requests.
- Expanding performs one manifest request.
- Selecting a price fetches only that price identity's selected completed-day resource.
- Selecting a constraint fetches only that constraint identity's selected completed-day resource.
- Switching selection, collapsing, or leaving Market aborts obsolete work. A stale completion
  cannot overwrite the newer selection.
- A refresh failure with prior valid data keeps that data and announces a warning. First-load
  failure, loading, valid-empty, partial, stale, and schema-invalid states remain distinct.
- Bounded URL state restores the selected layer and identity through reload and Back/Forward;
  invalid state is removed without losing unrelated dashboard parameters.

## Visualization and accessibility

The price visualization is visibly titled **settlement-price matrix — not geographic boundaries**.
The repository has no reviewed polygon geometry for these identities. Position cannot imply
distance, adjacency, topology, direction, or a transmission path.

Every matrix cell includes exact code, human label, type, signed value, unit, and observation time.
A visible fixed legend explains color, while text preserves negative and elevated meaning without
color. A keyboard-reachable exact table contains all 15 rows for a coherent layer.

Constraint history uses actual target-time spacing and breaks across missing samples. Its exact
table retains source values and names without invented expansions. Price and constraint selections
are exposed through native controls with at least 44-by-44 CSS-pixel targets, visible focus, and
selection state. Matrix navigation supports Arrow keys, Home, and End without adding 15 tab stops.
Scrollable tables are focusable and keep semantic headings. Status changes use a polite live region.

At the 440-by-956 iPhone Pro Max viewport, the page has no horizontal body overflow, controls wrap,
the legend and provenance remain visible, and both exact tables remain operable.

## Deterministic visual evidence

Desktop Chromium and iPhone Pro Max WebKit fixtures cover:

- a coherent 15-point matrix containing negative and divergent prices;
- an exact-SCED populated constraint list and selected constraint history;
- partial/stale source state without layout collapse or invented zeroes.

Darwin and pinned Ubuntu baselines follow the repository's existing Playwright snapshot naming,
locale, dark color scheme, and America/Chicago timezone conventions.
