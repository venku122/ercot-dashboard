# ERP-08 official GIS source schema correction

The official September 2026 GIS workbook (`GIS_Report_September2026`, MIS report
15933 document 1281327706, published 2026-10-01T16:08:28-05:00) contains one
large-generator row with fuel `MWH`, technology `SO`, study phase `SS Started,
FIS Started, No IA`, and source capacity 50 MW. Its workbook SHA-256 is
`016cddbb7082fd30e02ede6242e3f33adc79ca0f2e7fb49bc9079ebde2671d58`.
The workbook fuel legend does not define MWH. The parser previously rejected the
entire supported monthly report with `long_horizon_gis_enum`.

The bounded correction preserves this literal verified code as `source_mwh`,
labelled **MWH (as reported)**. It remains unclassified; no battery/storage or
energy-unit interpretation is inferred. The displayed aggregate remains a
project-row count and sum of the source Capacity (MW) column. The browser table
shows the source label and explicitly discloses the missing fuel definition.
Unknown fuel and phase codes still fail closed.

The current exact registry adds one fuel to the existing twelve, preserving all
existing ordinals. Its ceiling is 11 phases × 13 fuels = 143 aggregate rows.
Receiver and browser parsers also accept the complete legacy twelve-fuel
registry with its original 132 ceiling; mixed registries/ceilings are rejected.
No persisted schema migration is required and existing content versions remain
readable. This is an additive update to the original PR21 acceptance contract.

The public 673369-byte workbook and 80545-byte official listing were captured in
`/tmp/ercot-post-release-2026-10/` for offline reproducibility. Host and default
container DNS failed; a disposable source-inspection container with `--dns
1.1.1.1` succeeded. No host or infrastructure DNS setting was changed. Offline
replay reduced 1789 source rows to 33 aggregates, retaining the single MWH row.
Only enum/aggregate/public-document metadata is reported; project identities
are not copied to tests or reports.

Regression evidence includes collector real-layout MWH/SO fixture, rejection of
unknown codes, receiver legacy/new publication readback, exact browser registry
validation, and a rendered table/disclosure test. Browser registry validation
also now rejects unknown fuels in later phases explicitly; arithmetic ordering
alone previously allowed some such inputs.
