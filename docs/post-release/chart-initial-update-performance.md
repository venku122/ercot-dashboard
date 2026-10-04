# Avoid repeating the constructor's chart update

Chart.js already builds and renders its initial data, range and interaction options. The following effects previously performed the same data update and policy update again. Applied-input snapshots now skip only an identical update on that same chart instance. Changed datasets, events, bounds, domains and interaction policies still update normally. Initial pinned-cursor restoration draws its overlay explicitly; small zero-centered domains retain the existing minimum magnitude of one.

The disabled-events empty array is also stable, so unrelated parent renders do not falsely signal new event data. This does not defer any source request, remove observations, alter the renderer, or change the performance observer.

A new genuine regression first observed two redundant owned data updates after the two populated core charts had rendered. It now observes zero, then verifies that a subsequent six-hour selection does update and preserves the existing instances. All fifteen focused tests passed, including the unchanged full homepage tests, held-frequency core priority, four warm context cases and paired-envelope table/CSV source correctness. Exact strict numeric and complete cumulative acceptance remain separate checks; the previous Linux 2,566 ms miss is retained.
