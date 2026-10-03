# PR53 LTLF and planning-data completion

Status: PASS for the bounded LTLF slice. Large-load project status and gross
retirements remain explicitly unavailable because no reviewed public
machine-readable source supports those claims.

## Official sources and frozen evidence

- Page: `https://www.ercot.com/gridinfo/load/forecast/index.html`
- Monthly workbook:
  `https://www.ercot.com/files/docs/2025/04/08/2025-ERCOT-Monthly-Peak-Demand-and-Energy-Forecast.xlsx`
- Methodology report:
  `https://www.ercot.com/files/docs/2025/04/08/2025_LTLF_Report.docx`
- Workbook SHA-256 observed during the bounded 2026-08-20 audit:
  `cf2f50b9f9846f6d378715b7027a58bbeda926ce43626178e0604e48866e2e75`
- Report SHA-256 observed during the bounded 2026-08-20 audit:
  `1028603e53839ef33ce118f8851de61fe3771320fb41c986b304c95fc6aa208d`

The workbook has one sheet and exactly 243 rows. It contains 240 monthly rows
for each official population from 2025 through 2044: `ERCOT Adjusted Forecast`
and `TSP Provided Forecast`. The official workbook layout shifts the TSP date
columns by one row relative to its values; the parser freezes and tests that
layout rather than heuristically scanning cells.

Appendix A of the methodology report defines peak demand in MW and energy in
TWh. The collector binds the workbook columns as monthly peak MW and monthly
energy MWh only after verifying that adjusted monthly MWh sums reproduce the
report's rounded annual TWh values for 2025 through 2031. No unit is inferred
from an unlabeled numeric cell.

## Public behavior

The collector publishes a third independent Texas Grid stream,
`long_term_load_forecast`. The receiver materializes content-versioned `tg1-`
resources at:

`/api/v2/texas-grid/long_term_load_forecast/v1/{content_version}`

The manifest exposes its selected publication independently from GIS and
Resource Capacity Trend. The UI fetches it only after explicit selection and
shows the two scenarios separately with an exact horizontally scrollable
evidence table.

Large-load content is limited to methodology statements about forecast inputs:
TSP contracts/officer-letter ramp schedules and ERCOT timing/realization
adjustments. Current Batch Zero documents are process context, not a public
project-status dataset. The dashboard therefore does not claim project queue,
energized, operating, suspended, or realized status.

GIS cancellations/inactive projects, commissioning milestones, and net
operational-capacity changes do not establish gross retirements. The retirement
section remains `unavailable` with reason `no_verified_gross_retirement_source`.
