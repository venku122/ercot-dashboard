# ERP-08 official capped/uncapped market contracts

The captured October 3, 2026 official MIS documents contain exact headers that
were rejected by the legacy market parser:

- NP6-322-CD: SCEDTimeStamp,RepeatedHourFlag,CappedSystemLambda,UncappedSystemLambda.
- NP6-332-CD: SCEDTimestamp,RepeatedHourFlag,ASType,CappedMCPC,UncappedMCPC.

The parser now accepts these exact additive contracts and the original exact
SystemLambda/MCPC contracts. SHA-256 fingerprints of the canonical JSON header
arrays identify the two variants independently. Unknown, partial, reordered,
or mixed fields remain invalid. Publication metadata and official document
identities are preserved; five-service exact-SCED membership remains mandatory.

Capped and uncapped fields produce separate canonical series identities:
`market.sced.system-lambda.{capped,uncapped}` in $/MWh and
`market.sced.as-mcpc.<service>.{capped,uncapped}` in $/MW. Legacy source fields
retain their original identities; no alias or implicit equivalence is created.
Unit basis is the frozen reviewed [PR14 scalar contract](../pr14-market-mechanics-acceptance.md#fixed-scalar-resource-catalog), lines 51–62: energy $/MWh and MCPC $/MW. CSV headers alone do not establish a different unit or authorize time weighting.
The completed-day history continues through the existing immutable domain API.
Corrections retire obsolete current basis pointers while preserving prior bytes.
The previous-day seal checks the keys represented by selected raw source rows.

Coherent snapshots accept exactly the complete per-product legacy or split
series sets. Deltas across a basis change are unavailable for newly introduced
keys. NP6-323 SystemLambda does not establish which NP6-322 capped/uncapped field
has the equivalent definition, so parity is explicitly
`unavailable_unverified_basis` with null delta for split lambda publications.
The browser displays both basis labels and explains the unavailable comparison.
Energy context exposes separate capped/uncapped readings; the legacy energy
signal stays unavailable when its original source field is absent.

The public source capture is in `/tmp/ercot-post-release-2026-10/`:
`market-inspection.jsonl`, NP6-322-CD.csv, NP6-332-CD.csv and the other two
supported same-SCED CSVs. Exact captured source fixtures are committed for the
two corrected contracts. An additional unequal-value regression proves that
capped/uncapped values remain distinct even though this captured run reports
equal values. Offline collector payload generation and isolated in-memory
receiver replay produced 37 readings and 37 immutable resources for the captured
four-source SCED timestamp 1791085520, retaining exact official fingerprints,
values and units. HTTP acceptance also covers canonical GET and ETag/304 for
all twelve capped/uncapped resources.
