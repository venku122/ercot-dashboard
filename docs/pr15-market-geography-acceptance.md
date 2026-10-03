# PR15 congestion and price geography acceptance contract

This contract fixes the source meaning and safety boundary for PR15. The
feature may show prices and binding constraints that share a reviewed market
time. It is not a price decomposition and does not identify the cause of a
settlement-point price.

## Exact public products

Only unauthenticated public CSV ZIP publications from these exact ERCOT
Current Day Report products are accepted:

| Product    | Report | Cadence                                         | Exact CSV header                                                                                                                                                                         | Header SHA-256                                                     |
| ---------- | -----: | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| NP6-788-CD |  12300 | Event, per SCED run; normally five minutes      | `SCEDTimestamp,RepeatedHourFlag,SettlementPoint,LMP`                                                                                                                                     | `2ab04e739fba30bc2ee527b4927af212669c8932056745ddfe3bdad29e80ce9c` |
| NP6-905-CD |  12301 | 15-minute settlement interval                   | `DeliveryDate,DeliveryHour,DeliveryInterval,SettlementPointName,SettlementPointType,SettlementPointPrice,DSTFlag`                                                                        | `4e6f1ec046967794271f9fd4c2f880b0382f561502c24e0f883aa0be0cc21974` |
| NP6-86-CD  |  12302 | Hourly, when needed; contains several SCED runs | `SCEDTimeStamp,RepeatedHourFlag,ConstraintID,ConstraintName,ContingencyName,ShadowPrice,MaxShadowPrice,Limit,Value,ViolatedMW,FromStation,ToStation,FromStationkV,ToStationkV,CCTStatus` | `732f368c6be8e87cb0806a57c5ac510b4944011ea22c72bf354de0c48bd89ee7` |

The exact Public API paths remain
`/np6-788-cd/lmp_node_zone_hub`,
`/np6-905-cd/spp_node_zone_hub`, and
`/np6-86-cd/shdw_prices_bnd_trns_const`. The credential-free MIS path is the
runtime source because it exposes current CSV ZIP publications without putting
an account credential in the collector.

The list adapter accepts only `SecurityStatus=P`, `Extension=zip`, exact report
ID, and an exact `_csv.zip` ConstructedName. It requires the paired XML sibling
with the same `PublishDate` but downloads only the CSV. The accepted names are:

```text
^cdr\.00012300\.0000000000000000\.\d{8}\.\d{9}\.LMPSROSNODENP6788_\d{8}_\d{6}_csv\.zip$
^cdr\.00012301\.0000000000000000\.\d{8}\.\d{9}\.SPPHLZNP6905_\d{8}_\d{4}_csv\.zip$
^cdr\.00012302\.0000000000000000\.\d{8}\.\d{9}\.SCEDBTCNP686_csv\.zip$
```

`DocID` plus the offset-bearing `PublishDate` is official publication
provenance. `PublishDate` independently normalizes exactly to `issued_at`.
Neither the outer filename timestamp nor a friendly-name timestamp substitutes
for it. The content digest identifies immutable bytes. Raw publication and row
timestamps remain available alongside normalized UTC instants.

## Time, identity, and units

NP6-788 and NP6-86 timestamps are America/Chicago wall-clock values paired
with an exact `N` or `Y` repeated-hour flag. Seconds are preserved. A fall
repeated wall time produces two UTC instants one hour apart; a nonexistent
spring wall time is rejected.

NP6-905 rows identify the end of one ERCOT 15-minute market interval. On a
normal day, delivery hour 1 interval 1 ends at 00:15 and delivery hour 24
interval 4 ends at the next local midnight. A source label whose calculated
spring wall-clock interval end does not exist is rejected. Fall labels whose
end is ambiguous are distinguished with `DSTFlag`. Impossible
hour/interval/flag combinations are rejected. The natural key includes both
`SettlementPointName` and `SettlementPointType`: the same load-zone name is
published as distinct `LZ` and `LZEW` prices.

LMP and Settlement Point Price use `$/MWh`. NP6-86 `ShadowPrice` and
`MaxShadowPrice` use `$/MWh`; `Limit`, `Value`, and `ViolatedMW` use `MW`;
station voltages use `kV`. `ConstraintID` is retained as a canonical decimal
string rather than passing through a floating-point number. `CCTStatus` accepts
only `COMP` (competitive) and `NONCOMP` (non-competitive).

The reviewed natural keys are:

- NP6-788: SCED timestamp, repeated flag, settlement point;
- NP6-905: delivery date, hour, interval, DST flag, settlement-point name, and
  settlement-point type;
- NP6-86: SCED timestamp, repeated flag, constraint ID, constraint name,
  contingency name, endpoint stations, and endpoint voltages.

Replay of identical official publication bytes is idempotent. Different bytes
under the same official identity are a collision. A later official publication
may create a new content version without changing an older immutable resource.

## Geography and attribution boundary

NP6-788 does not publish a settlement-point type or coordinates. Its
settlement-point field is opaque outside a reviewed exact allowlist. PR15 may
not infer a node location, coordinates, polygon, county, load zone, or display
label from an arbitrary identifier.

The default hub/load-zone heatmap is a labeled value matrix, not a spatial map.
It selects exact NP6-905 `HU` rows for `HB_HOUSTON`, `HB_NORTH`, `HB_PAN`,
`HB_SOUTH`, and `HB_WEST`, and exact `LZ` rows for `LZ_AEN`, `LZ_CPS`,
`LZ_HOUSTON`, `LZ_LCRA`, `LZ_NORTH`, `LZ_RAYBN`, `LZ_SOUTH`, and `LZ_WEST`.
`LZEW` is a distinct energy-weighted price and must not overwrite `LZ`.
`HB_BUSAVG` (`SH`) and `HB_HUBAVG` (`AH`) are aggregates, not geographic hub
cells. Raw point name and type remain visible.

NP6-86 provides a constraint's monitored element, contingency, endpoint
stations and voltages, shadow price, cap, limit, flow, violation, and
competitiveness. It does not provide the settlement-point shift factor needed
to calculate the constraint's effect on a point LMP. The only accepted join is
an exact normalized NP6-788/NP6-86 SCED instant including the repeated-hour
identity. A nearest-time join is forbidden. NP6-905 remains a separately timed
15-minute settlement product and is never joined to one SCED as a causal
decomposition.

Every public constraint context uses the stable policy value:

```text
coincident_constraint_not_point_price_attribution
```

and exposes `attribution_status=unavailable_without_shift_factors`. Public
responses contain no `cause`, `driver`, `contribution`, `decomposition`, or
sole-cause claim. User copy says that the constraints were binding in the same
SCED and that this report does not establish their contribution to a displayed
point price.

## Bounded collection and history

Application limits are deliberately above the bounded current observations;
they are safety limits, not claims about ERCOT's maximum cardinality:

- 4 MiB and 5,000 candidates per document-list response;
- 2 MiB compressed ZIP and 8 MiB extracted single CSV;
- 5,000 rows per NP6-788 or NP6-905 document and 10,000 per NP6-86 document;
- at most 48 publications per product per run, selected oldest first after a
  per-product checkpoint;
- a fresh bootstrap takes only the most recent bounded window and reports its
  truncation rather than attempting the displayed archive.

No-new-document, valid-empty, stale, expired-gap, schema-failed, and transport-
failed states remain distinct. A later valid document advances independently
past a failed or expired document while preserving bounded gap evidence.

Normalized source rows retain 35 days. The current UTC day remains mutable and
does not create immutable full-day blobs. Completed-day corrections create a
new content version and retain old bytes and ETag for their advertised lifetime.
The implementation must not create one eager immutable object for every node.
Daily product shards or selected-point materialization must keep object and
response counts bounded. Node lookup/ranking is bounded to 100 rows, exact
identifiers, and explicit total/truncation metadata.

Required deterministic acceptance covers exact headers and fingerprints,
constructed-name and publication provenance, duplicate natural keys, finite
numeric validation, normal/spring/fall time conversion, the LZ/LZEW identity
collision, exact-SCED-only constraint context, anti-causality response keys,
row/body/run bounds, checkpoint replay and gaps, correction immutability,
valid-empty health, and stable cache bytes/ETag.

## Evidence boundary

The schemas and current cardinality shape were checked on 2026-08-20 through
bounded credential-free official lists and CSV ZIPs. No source rows, live
values, or DocIDs are retained in this repository. One inspected NP6-788 file
contained one SCED and 1,118 unique points; NP6-905 contained one interval and
1,130 `(point,type)` rows for 1,118 names; NP6-86 contained 24 rows across 12
SCEDs. These are observations, not source guarantees.

Authoritative references:

- [NP6-788 product](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-788-CD)
- [NP6-905 product](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-905-CD)
- [NP6-86 product](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-86-CD)
- [ERCOT Current Day Reports XSD](https://github.com/ercot/api-specs/blob/main/cdr/Current_Day_Reports.xsd)
- [ERCOT Public API OpenAPI](https://github.com/ercot/api-specs/blob/main/pubapi/pubapi-apim-api.json)
- [ERCOT SCED constraints message](https://developer.ercot.com/applications/ews/Market%20Information%20Messages/SCED%20Violated%20Constraints/)
- [ERCOT Real-Time Operations training: point LMP impact depends on shift factors](https://www.ercot.com/files/docs/2024/07/22/2025_03-Resource_RT_Ops.pdf)
