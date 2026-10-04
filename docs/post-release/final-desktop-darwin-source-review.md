# Final desktop Darwin capture review

Source: `dc3063bbb4ae12c94bff40ccc150419d8a965e2d`. These are Darwin Chromium captures from the owned checkout, not copies of root artifacts or Ubuntu CI frames.

The original run failed all 16 corresponding flows at screenshot assertions. After each individually reviewed frame was adopted, the full flows were repeated without snapshot updates, exposing later screenshots in those flows. The final run passed all 16 flows in 17.3 seconds. The six-project mobile matrix also passed all 102 tests in 2.1 minutes without image updates.

The 31 changed images cover the core and progressive views, nine desktop picker states, market geography and mechanics, regional context, NWS evidence, forecast quality, net load and storage operations. Every original, actual and diff was viewed. The companion JSON records each old/new hash, dimensions, source evidence and full-test trace provenance. POST hashes use raw `resources/<postData._sha1>` bytes before inline text; request bodies with unavailable positive-size resources are recorded as UNKNOWN. Trace requests belong to the whole test, not a fabricated single-frame attribution.

Changes reflect the existing 44px controls, source-distinct legacy collection prices and native MIS unavailable state, archived hourly forecasts, honest partial Outlook timestamps, source-clock corrections and fractional crop rasterization. Exact numeric values, missing-data notes, source identities and intervals remain visible. Empty/loading fallbacks were not accepted as populated captures. The existing long desktop regional provenance string remains clipped; this capture update does not claim to fix it.

The picker retains its frozen geometry assertions and unchanged contract file. The calendar screenshot explicitly hovers July 29 without selecting it, preserving the original screenshot state rather than accepting an accidental residual pointer over July 15. The other picker changes show the existing picker-specific calendar styles and 44px shell/playback targets. No tolerance, numeric assertion, fixture, production source or product style was changed in this supplement.

Preserved evidence is under `/tmp/ercot-post-release-2026-10/final-dc3063-desktop-{red,repeat1-red,...,repeat8-red}`. The final logs are `final-dc3063-desktop-green.log` and `final-dc3063-mobile-matrix.log` in the same campaign directory. The preserved prior root full-suite evidence remains separate at `final-d41-chromium-red`.

This verifies the affected flows on the frozen source and local platform. A later integrated product head, full desktop suite and Ubuntu CI still require their own verification. Local visual passes do not establish the separate remote performance budget.
