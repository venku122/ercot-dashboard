# Tile aggregate algebra

`ercot-receiver/tile_aggregates.py` defines the mergeable state used to build
historical aggregate tiles without rereading raw samples.

## Interface

- `aggregate_points(points)` builds a `BucketAggregate` from `(timestamp,
value)` pairs or `(timestamp, value, tie_ordinal)` triples. `None` points and `None` values are missing observations and
  do not contribute to the count. Timestamps must be integer seconds and values
  must be finite numbers.
- `merge_aggregates(*states)` accepts empty or time-disjoint fragments in any
  fragment order. Overlapping or interleaved fragments are rejected because an
  endpoint-only state cannot reproduce their canonical point order.
- `finalize_aggregate(state)` exposes count, sum, average, deterministic
  extrema timestamps, first/last points, span, and the unit-neutral integral.
  `finalize_aggregate(state, power=True)` additionally derives `energy_mwh` for
  a catalog-declared MW power series.
- `serialize_aggregate` emits compact, key-sorted, versioned JSON;
  `deserialize_aggregate` validates and restores it. Numeric zero is always
  encoded as `0.0`, so signed `-0.0` cannot create a distinct cache payload.

The state is immutable. The server can store one serialized state for each
series, resolution, and sealed bucket, then merge ordered bucket states for a
larger query window.

## Ordering and ties

Points have canonical order `(timestamp, tie_ordinal)`. The receiver reads
SQLite samples in the established `ORDER BY ts, id` order and replaces the
private database ID with a zero-based ordinal among samples sharing that
timestamp. The ordinal is tile-local, survives version-2 aggregate serialization and
merge boundaries, and never exposes a SQLite ID. Two-element input remains
supported: its existing input order assigns ordinals within each equal-time
group. Equal timestamps add no integral duration. If minimum or maximum values
tie, the earliest timestamp is reported. `first` and `last` mean the first and
last points in timestamp/ordinal order.

Callers partitioning an equal-timestamp group across aggregate fragments must
carry explicit ordinals in the three-element form. Resetting implicit ordinals
across such a boundary is ambiguous and is intentionally not treated as a safe
merge.

Coarse bucket states are mergeable but cannot be clipped at an arbitrary
timestamp. A partial-window client must request native states for both boundary
regions and use coarse states only for fully aligned interior buckets. Merging
those native edges with the coarse interior reconstructs count, sum, extrema,
and the left-step integral without rereading the entire window at native LOD.

## Integral and boundary bridge

The integral is explicitly left-continuous and stepwise:

```text
integral_value_seconds = sum(value[i] * (timestamp[i+1] - timestamp[i]))
```

When a left fragment and right fragment are merged, the boundary term is:

```text
left.last_value * (right.first_timestamp - left.last_timestamp)
```

There is no extrapolation before the first or after the last observation. For a
power series, `energy_mwh` is `integral_value_seconds / 3600` and is `null` for
fewer than two observations. Generic finalization omits `energy_mwh`; frequency,
price, and arbitrary gauges must not acquire an energy label. Serialized state
is likewise generic and never contains `energy_mwh`. This stepwise contract is
deliberate; it is not trapezoidal interpolation.

## Algebra verification

`test_tile_aggregates.py` uses a fixed random seed for 300 irregular datasets.
Each dataset is split into three contiguous fragments, then compared with the
direct aggregate and with both association orders. Counts, endpoints, and
extrema timestamps must be exact. Floating reductions may regroup operands, so
sum, extrema values, endpoints, and integral use relative tolerance `1e-12`
and absolute tolerance `1e-9`; the separately checked MWh conversion uses
relative and absolute tolerance `1e-12`.

The deterministic suite also covers negative values, stable database-order
equal-timestamp values, zero-duration ties,
missing observations, empty and singleton energy, irregular gaps, explicit
cross-fragment bridges, reversed fragment arguments, serialization round trips,
and rejection of interleaved ranges.

Run it from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest ercot-receiver/test_tile_aggregates.py
```
