#!/usr/bin/env python3
"""Mergeable aggregate algebra for ordered metric tile samples.

The integral uses a left-continuous, stepwise bridge: a point's value applies
until the next canonical point timestamp. Equal timestamps have zero duration.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Iterable, Mapping, Sequence


SERIALIZATION_VERSION = 2
Point = tuple[int, int, float]


def _canonical_float(value) -> float:
    normalized = float(value)
    return 0.0 if normalized == 0 else normalized


@dataclass(frozen=True)
class BucketAggregate:
    count: int = 0
    value_sum: float = 0.0
    minimum: float | None = None
    minimum_ts: int | None = None
    maximum: float | None = None
    maximum_ts: int | None = None
    first_ts: int | None = None
    first_ordinal: int | None = None
    first_value: float | None = None
    last_ts: int | None = None
    last_ordinal: int | None = None
    last_value: float | None = None
    integral_value_seconds: float = 0.0

    @property
    def empty(self) -> bool:
        return self.count == 0


def _point(timestamp, value, ordinal) -> Point | None:
    """Normalize one point; None values are explicit missing observations."""
    if value is None:
        return None
    if not isinstance(timestamp, int) or isinstance(timestamp, bool):
        raise TypeError("timestamp must be an integer")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError("value must be numeric or None")
    if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 0:
        raise TypeError("point ordinal must be a non-negative integer")
    normalized = _canonical_float(value)
    if not math.isfinite(normalized):
        raise ValueError("value must be finite")
    return timestamp, ordinal, normalized


def aggregate_points(
    points: Iterable[Sequence[int | float | None] | None],
) -> BucketAggregate:
    """Aggregate by ``(timestamp, ordinal)``; 2-tuples retain tie input order."""
    normalized: list[Point] = []
    next_tie_ordinal: dict[int, int] = {}
    for point in points:
        if point is None:
            continue
        if len(point) not in (2, 3):
            raise ValueError("point must contain timestamp, value, and optional ordinal")
        if len(point) == 2:
            ordinal = next_tie_ordinal.get(point[0], 0)
            if point[1] is not None:
                next_tie_ordinal[point[0]] = ordinal + 1
        else:
            ordinal = point[2]
        parsed = _point(point[0], point[1], ordinal)
        if parsed is not None:
            normalized.append(parsed)
    if not normalized:
        return BucketAggregate()
    normalized.sort()
    if any(
        (left[0], left[1]) == (right[0], right[1])
        for left, right in zip(normalized, normalized[1:])
    ):
        raise ValueError("duplicate point timestamp and ordinal")

    minimum_value = min(value for _ts, _ordinal, value in normalized)
    maximum_value = max(value for _ts, _ordinal, value in normalized)
    minimum_ts = min(
        ts for ts, _ordinal, value in normalized if value == minimum_value
    )
    maximum_ts = min(
        ts for ts, _ordinal, value in normalized if value == maximum_value
    )
    integral = math.fsum(
        value * (next_ts - ts)
        for (ts, _ordinal, value), (next_ts, _next_ordinal, _next_value) in zip(
            normalized, normalized[1:]
        )
    )
    return BucketAggregate(
        count=len(normalized),
        value_sum=math.fsum(value for _ts, _ordinal, value in normalized),
        minimum=minimum_value,
        minimum_ts=minimum_ts,
        maximum=maximum_value,
        maximum_ts=maximum_ts,
        first_ts=normalized[0][0],
        first_ordinal=normalized[0][1],
        first_value=normalized[0][2],
        last_ts=normalized[-1][0],
        last_ordinal=normalized[-1][1],
        last_value=normalized[-1][2],
        integral_value_seconds=integral,
    )


def _first_key(state: BucketAggregate) -> tuple[int, int]:
    assert state.first_ts is not None and state.first_ordinal is not None
    return state.first_ts, state.first_ordinal


def _last_key(state: BucketAggregate) -> tuple[int, int]:
    assert state.last_ts is not None and state.last_ordinal is not None
    return state.last_ts, state.last_ordinal


def _earlier_extreme(
    left_value: float,
    left_ts: int,
    right_value: float,
    right_ts: int,
    *,
    choose_minimum: bool,
) -> tuple[float, int]:
    if left_value == right_value:
        return left_value, min(left_ts, right_ts)
    if (left_value < right_value) == choose_minimum:
        return left_value, left_ts
    return right_value, right_ts


def _merge_ordered(left: BucketAggregate, right: BucketAggregate) -> BucketAggregate:
    if left.empty:
        return right
    if right.empty:
        return left
    if _last_key(left) == _first_key(right):
        raise ValueError("aggregate fragments duplicate an endpoint")
    if _last_key(left) > _first_key(right):
        raise ValueError("aggregate ranges overlap or interleave")
    assert left.minimum is not None and left.minimum_ts is not None
    assert right.minimum is not None and right.minimum_ts is not None
    assert left.maximum is not None and left.maximum_ts is not None
    assert right.maximum is not None and right.maximum_ts is not None
    assert left.last_ts is not None and left.last_value is not None
    assert right.first_ts is not None
    minimum, minimum_ts = _earlier_extreme(
        left.minimum,
        left.minimum_ts,
        right.minimum,
        right.minimum_ts,
        choose_minimum=True,
    )
    maximum, maximum_ts = _earlier_extreme(
        left.maximum,
        left.maximum_ts,
        right.maximum,
        right.maximum_ts,
        choose_minimum=False,
    )
    bridge = left.last_value * (right.first_ts - left.last_ts)
    return BucketAggregate(
        count=left.count + right.count,
        value_sum=math.fsum((left.value_sum, right.value_sum)),
        minimum=minimum,
        minimum_ts=minimum_ts,
        maximum=maximum,
        maximum_ts=maximum_ts,
        first_ts=left.first_ts,
        first_ordinal=left.first_ordinal,
        first_value=left.first_value,
        last_ts=right.last_ts,
        last_ordinal=right.last_ordinal,
        last_value=right.last_value,
        integral_value_seconds=math.fsum(
            (left.integral_value_seconds, bridge, right.integral_value_seconds)
        ),
    )


def merge_aggregates(*states: BucketAggregate) -> BucketAggregate:
    """Merge time-disjoint fragments, accepting them in any fragment order."""
    ordered = sorted((state for state in states if not state.empty), key=_first_key)
    merged = BucketAggregate()
    for state in ordered:
        merged = _merge_ordered(merged, state)
    return merged


def finalize_aggregate(
    state: BucketAggregate, *, power: bool = False
) -> dict[str, object]:
    """Finalize generic fields; opt in to MW-seconds-to-MWh for power series."""
    average = state.value_sum / state.count if state.count else None
    span_seconds = (
        state.last_ts - state.first_ts
        if state.first_ts is not None and state.last_ts is not None
        else None
    )
    result: dict[str, object] = {
        "count": state.count,
        "sum": state.value_sum,
        "average": average,
        "minimum": state.minimum,
        "minimum_ts": state.minimum_ts,
        "maximum": state.maximum,
        "maximum_ts": state.maximum_ts,
        "first": (
            None
            if state.first_ts is None
            else {"ts": state.first_ts, "value": state.first_value}
        ),
        "last": (
            None
            if state.last_ts is None
            else {"ts": state.last_ts, "value": state.last_value}
        ),
        "span_seconds": span_seconds,
        "integral_value_seconds": state.integral_value_seconds,
    }
    if power:
        result["energy_mwh"] = (
            state.integral_value_seconds / 3600 if state.count > 1 else None
        )
    return result


def aggregate_to_dict(state: BucketAggregate) -> dict[str, object]:
    return {
        "version": SERIALIZATION_VERSION,
        "count": state.count,
        "value_sum": _canonical_float(state.value_sum),
        "minimum": (
            None if state.minimum is None else _canonical_float(state.minimum)
        ),
        "minimum_ts": state.minimum_ts,
        "maximum": (
            None if state.maximum is None else _canonical_float(state.maximum)
        ),
        "maximum_ts": state.maximum_ts,
        "first_ts": state.first_ts,
        "first_ordinal": state.first_ordinal,
        "first_value": (
            None if state.first_value is None else _canonical_float(state.first_value)
        ),
        "last_ts": state.last_ts,
        "last_ordinal": state.last_ordinal,
        "last_value": (
            None if state.last_value is None else _canonical_float(state.last_value)
        ),
        "integral_value_seconds": _canonical_float(state.integral_value_seconds),
    }


def serialize_aggregate(state: BucketAggregate) -> str:
    return json.dumps(
        aggregate_to_dict(state),
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def deserialize_aggregate(payload: str | bytes | Mapping[str, object]) -> BucketAggregate:
    decoded = json.loads(payload) if isinstance(payload, (str, bytes)) else dict(payload)
    if decoded.get("version") != SERIALIZATION_VERSION:
        raise ValueError("unsupported aggregate serialization version")
    state = BucketAggregate(
        count=int(decoded["count"]),
        value_sum=_canonical_float(decoded["value_sum"]),
        minimum=(
            None
            if decoded["minimum"] is None
            else _canonical_float(decoded["minimum"])
        ),
        minimum_ts=None if decoded["minimum_ts"] is None else int(decoded["minimum_ts"]),
        maximum=(
            None
            if decoded["maximum"] is None
            else _canonical_float(decoded["maximum"])
        ),
        maximum_ts=None if decoded["maximum_ts"] is None else int(decoded["maximum_ts"]),
        first_ts=None if decoded["first_ts"] is None else int(decoded["first_ts"]),
        first_ordinal=_deserialize_ordinal(decoded["first_ordinal"]),
        first_value=(
            None
            if decoded["first_value"] is None
            else _canonical_float(decoded["first_value"])
        ),
        last_ts=None if decoded["last_ts"] is None else int(decoded["last_ts"]),
        last_ordinal=_deserialize_ordinal(decoded["last_ordinal"]),
        last_value=(
            None
            if decoded["last_value"] is None
            else _canonical_float(decoded["last_value"])
        ),
        integral_value_seconds=_canonical_float(decoded["integral_value_seconds"]),
    )
    _validate_state(state)
    return state


def _deserialize_ordinal(value) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("aggregate ordinal must be a non-negative integer")
    return value


def _validate_state(state: BucketAggregate) -> None:
    if state.count < 0:
        raise ValueError("count must not be negative")
    optional = (
        state.minimum,
        state.minimum_ts,
        state.maximum,
        state.maximum_ts,
        state.first_ts,
        state.first_ordinal,
        state.first_value,
        state.last_ts,
        state.last_ordinal,
        state.last_value,
    )
    if state.empty:
        if any(value is not None for value in optional):
            raise ValueError("empty aggregate must not contain points")
        if state.value_sum != 0 or state.integral_value_seconds != 0:
            raise ValueError("empty aggregate totals must be zero")
        return
    if any(value is None for value in optional):
        raise ValueError("non-empty aggregate is missing point fields")
    if (
        not isinstance(state.first_ordinal, int)
        or isinstance(state.first_ordinal, bool)
        or state.first_ordinal < 0
        or not isinstance(state.last_ordinal, int)
        or isinstance(state.last_ordinal, bool)
        or state.last_ordinal < 0
    ):
        raise ValueError("aggregate ordinals must be non-negative integers")
    numeric = (
        state.value_sum,
        state.minimum,
        state.maximum,
        state.first_value,
        state.last_value,
        state.integral_value_seconds,
    )
    if not all(math.isfinite(float(value)) for value in numeric):
        raise ValueError("aggregate values must be finite")
    if _first_key(state) > _last_key(state):
        raise ValueError("aggregate endpoints are out of order")
