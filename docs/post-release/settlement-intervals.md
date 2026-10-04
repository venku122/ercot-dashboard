# ERP-05 settlement interval semantics

Overview ranking and selected history now use NP6-905-CD Settlement Point Prices
from the existing Market Geography publications. They do not infer delivery
intervals from `ercot.pricing` collection timestamps. Legacy APIs and observations
remain intact and distinguishable.

ERCOT's [product page](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-905-CD)
identifies the 15-minute SPP product. Its [services time convention](https://developer.ercot.com/applications/ews/Services%20Organization/)
defines the fall sequence as hours 01, 02, 02R, 03, with delivery-hour boundaries
in prevailing Texas time. Reviewed CSV fields remain DeliveryDate, DeliveryHour,
DeliveryInterval, DSTFlag, point name, point type and price.

The normal/repeated flag identifies the **delivery interval's start hour**.
Resolve `(DeliveryHour - 1):((DeliveryInterval - 1) * 15)` in Chicago with the
flag, then add 900 elapsed seconds. Do not resolve the end wall clock's fold:
HE2 interval4 on 2026-11-01 ends at 07:00Z for N and 08:00Z for Y. The first
end reads 01:00 CST although its start was 01:45 CDT. Spring HE2 interval4
validly ends at 03:00 CDT. Nonexistent delivery starts remain rejected.
Collector, receiver and frontend now use the same rule. Raw labels/flags stay
unchanged. Stored old end-fold rows are not rewritten; later promotion requires
an explicitly reviewed migration/re-ingestion if such rows exist.

Select the greatest completed target epoch, not newest retrieval or publication.
Within that exact interval use the latest official issue; equal-issue documents
may contribute distinct points despite separate retrieval clocks. A later
partial correction does not borrow missing points from an earlier issue or
interval. Each row retains its own publication/content/retrieval provenance.
Coverage is 13 configured hub/load-zone identities, with the two existing
reference-price identities kept separate. Ties sort by point name; negative
prices remain signed. Selected point stays visible in the control even when
absent from the returned ranking.

The additive `/api/v1/market-price-history` accepts exact point+type identity and
at most 35 days, returning native interval bounds and per-point provenance.
Unsupported points/windows fail explicitly; no hub curve is substituted. The
selected Overview chart, Inspect, cursor, statistics, and export receive one
shared exact-point LoadedSeries. SWR keys include point+type+window and do not
retain previous selection data. Browser history/reload restore `overviewPoint`;
legacy `marketPoint` remains a compatible input.

Historical chart selection does not change the ranking's **latest completed**
clock. Both history and ranking use latest published corrections and explicitly
make no as-known-by-system replay claim. Credential/source-disabled deployments
show unavailable states. No production database, credentials, source activation,
legacy timestamps or remote configuration were changed.
