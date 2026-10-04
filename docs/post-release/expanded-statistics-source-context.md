# Expanded statistics source context

The cumulative integration preserves the completed-request selection label from
ERP-06 and the accessible source-unit disclosure from ERP-09. Expanded legend
captions distinguish raw source units from displayed conversions (for example,
68,300 MW displayed as 68.3 GW). During a queued incompatible range/comparison
change, the caption identifies statistics retained from the previous selection.
The source arrays, statistics and raw CSV values remain unchanged.

Independent frozen-product checks reproduced three failures against `eb63464`:
the old caption claimed values were in MW despite GW cells and called retained
previous-window statistics selected-window statistics. The four-file corrected
overlay passed 14 browser checks. Root cumulative integration passed 17 browser
checks, including actual mixed MW/GW table cells, raw CSV, warm range/comparison
changes, ordinary live refresh, accessibility, and 390px geometry in Chromium
and touch WebKit. Exact final-tip verification is recorded in the acceptance
packet; these are scoped integration results.
