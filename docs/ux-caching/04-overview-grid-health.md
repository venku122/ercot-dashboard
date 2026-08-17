# Overview and Grid Health presentation

Operational KPI tiles use three stable rows: label, tabular current value, and a reserved trend
slot. Missing comparison history leaves the slot visually quiet instead of redistributing height or
printing an unavailable warning. Only first load renders loading text; SWR background validation
keeps the complete prior tile mounted. The browser regression records tile text and bounds, advances
the live refresh clock, delays the replacement, and verifies zero text or dimension change until the
new snapshot resolves atomically.

Grid Health is a single default summary rather than an exposed factor-card grid. The horizontal bar
allocates width by each factor's maximum weight and fills each segment by points retained. A striped
segment means its input is unavailable. The adjacent score, condition, input coverage, and largest
pressures ensure color is never the only signal. The section's accessible label enumerates every
factor's retained and possible points.

The complete factor values, formulas, score bands, mandatory-input rules, and EEA overrides remain
behind **How status is determined**. When mandatory inputs or minimum coverage are absent, the viewer
sees “Not enough fresh inputs” plus the actual requirement rather than a generic unavailable result.

Freshness metadata is omitted when no observation timestamp exists. Missing KPI trend history is
also omitted because it does not change interpretation of the current value.
