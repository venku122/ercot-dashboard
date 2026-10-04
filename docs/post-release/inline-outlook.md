# Inline next 24 hour Outlook

Overview places a compact forecast below the existing core plots. Its domain is the current clock through the following 24 hours, independent of the retrospective range and pinned cursor. Forecast demand and forecast adequacy retain their published product identities; neither is an observed historical measurement.

NP3-565-CD supplies the in-use hourly load forecast. The summary finds its peak only inside the next 24 hours; the specialist seven-day peak remains separate. The timestamp plot retains missing values and splits gaps instead of interpolating omitted hours. The exact-value disclosure exposes Chicago interval-ending timestamps, MW values and missing rows. Coverage counts finite values against 24 expected hourly values.

NP3-763-CD supplies the separately published projected headroom. The compact summary requires the same row's available-generation capacity input and a non-null reported headroom. It does not subtract current observed capacity. Its own next-24-hour coverage, publication issue time and source freshness are disclosed separately. The two summaries need not peak at the same time.

Official product descriptions:

- [ERCOT Seven-Day Load Forecast by Model and Weather Zone](https://www.ercot.com/mp/data-products/data-product-details?id=NP3-565-CD)
- [ERCOT System Adequacy Report](https://www.ercot.com/mp/data-products/data-product-details?id=NP3-763-CD)

App owns one Outlook request hook and passes its result to Overview and the specialist route. Switching placements retains the subscriber and pending request. Cursor movement and evidence disclosure do not trigger requests; explicit refresh updates the publication without moving the historical domain or clearing its pin. Optional specialist weather/quality hooks retain their existing source gates.

Loading, request failure, retained-data refresh failure, stale data, incomplete data, valid-empty collection and unknown source eligibility are distinct compact states. An absent publication or absent source health does not prove that a collector is disabled or lacks credentials. Those deployment facts require independent source-audit evidence; the compact surface reports unknown eligibility when the API has no authoritative reason. Optional empty/error states display no empty plot.

Automated evidence covers model scope/capacity guards, real components, phone/desktop layout, keyboard exact values, fixed-domain pinning and refresh, single-owner pending requests, specialist cache reuse and unavailable/stale/empty/unknown states. Physical touch, assistive technology, and actual production publications remain separate acceptance checks.
