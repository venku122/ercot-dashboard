# Remaining data review plan

Scope: close the missing-data findings from the September visual review on the local stack. This is a plan, not source activation or production deployment.

## 1. Forecast demand on the overview chart

Observed: the database has 288 forecast-demand observations, but zero in the trailing six-hour window. The next future point is 2026-09-13 06:00 UTC. Actual demand is populated. The chart currently requests the same historical window for both series, leaving a blank forecast legend entry.

Work: trace the source's publication and delivery-time semantics, then decide whether this chart compares historical actuals with forecasts issued before delivery, or explicitly extends into the future. Use stored forecast vintages for the former; label the future interval and publication time for the latter. Do not shift future timestamps into the past or substitute actuals for forecasts. Explain a missing overlapping forecast directly in the legend.

Acceptance: a window with overlapping observations draws both lines; a window without overlap states why. Verify timestamps and values against the source, with boundaries tested in America/Chicago including DST.

## 2. Capacity and emergency-state history

Observed: the Reliability headroom chart uses Total_System_Capacity and Actual_System_Demand from the real-time snapshot source. Only 84 observations existed at inspection, compared with 505 supply/demand observations. The prior collector stopped for roughly ten days. The source products have different collection histories and must not be silently substituted.

Work: inventory coverage per series and day; distinguish collection gaps from failed queries. Backfill only from a verified equivalent historical source. Show the first collected timestamp and gaps when history cannot be recovered. Check EEA state rendering separately; sparse discrete observations do not establish continuous official event history.

Acceptance: exact API rows match plotted points; missing intervals remain visible gaps; any step/hold rendering has a documented validity interval and no invented history.

## 3. Supported optional feeds and outlook panels

Observed: Outlook responds HTTP 200 with no forecast or adequacy publication. Forecast Quality has no resources. Predictive Weather has no forecast/alert publication. Market Geography reports never_run and no settlement or LMP rows. Texas Grid has no selected planning publications. These local collectors are disabled, rather than demonstrated broken.

Work order:

1. Produce a source-to-panel matrix of flags, credentials, expected cadence, publication IDs, and current health. Check credential presence without printing values.
2. Enable credential-free supported feeds individually in local review, starting with predictive weather and verified public planning products. Supply the required NWS identification header.
3. Run the ERCOT authenticated API/schema gate, then enable forecast/adequacy and renewable publication collection, followed by market mechanics/geography. Use bounded requests and existing retry/checkpoint policies.
4. Verify forecast-vintage and actual-load pairs before generating Forecast Quality. Accumulate enough matched intervals to make scores meaningful; show insufficient coverage until then.
5. Verify each panel through collector delivery, receiver manifest, exact data table, and browser chart. Include selected settlement-point identity and freshness rather than relying on a working aggregate price chart.

Acceptance per feed: successful source request, accepted ingest, valid publication pointer, expected units/timestamps, healthy collection state, and rendered exact values. Restart/retry must remain idempotent. Record any external blocker independently of implementation failures.

## 4. Final acceptance evidence

Refresh desktop and mobile screenshots with actual enabled local data in addition to deterministic regression fixtures. Exercise six-hour, one-day, seven-day and a historical gap window. Record revision, source timestamps, coverage, unavailable reasons, and a pass/fail/deferred disposition for every original data complaint.

Existing deferrals remain: discontinued live four-second ESR, resource SOC, complete TXANS history, unverified project/retirement datasets, unsupported attribution, credentialed EIA/Henry Hub and EPA CAMD, and production/Cloudflare promotion. A disabled supported local feed is not automatically an accepted deferral.
