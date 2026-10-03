#!/usr/bin/env python3
"""Content-addressed dashboard-derived net-load resources.

Actual rows use only the four values captured at the same timestamp from
ERCOT's Real-Time System Conditions page. Forecast rows use one preserved
publication per input product under a single, explicit as-of cutoff. Neither
resource is presented as ERCOT's official net-load methodology.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import time
from collections import defaultdict
from datetime import date, datetime, time as datetime_time, timedelta
from zoneinfo import ZoneInfo


METHODOLOGY_VERSION = "v1"
RESOURCE_SCHEMA_VERSION = 1
CHICAGO = ZoneInfo("America/Chicago")
HORIZONS = {"1h": 3_600, "6h": 21_600, "24h": 86_400}
ACTUAL_SERIES_KEY = "net-load.actual"
FORECAST_SERIES_KEY = "net-load.forecast"
FORECAST_SEMANTIC_KEYS = {
    "1h": "net-load.forecast.latest-capped-1h-before-utc-day",
    "6h": "net-load.forecast.latest-capped-6h-before-utc-day",
    "24h": "net-load.forecast.latest-capped-24h-before-utc-day",
}
DAILY_FORECAST_SEMANTIC_KEYS = {
    horizon: f"net-load.forecast.latest-capped-{horizon}-before-market-day"
    for horizon in HORIZONS
}
EVENING_POLICY = "dashboard_evening_v1"
MAX_MANIFEST_DAYS = 90

REALTIME_METRICS = {
    "demand": "ercot.Real_Time_Data.Actual_System_Demand",
    "wind": "ercot.Real_Time_Data.Total_Wind_Output",
    "solar": "ercot.Real_Time_Data.Total_PVGR_Output",
    "published": "ercot.Real_Time_Data.Average_Net_Load",
}
STORAGE_METRIC = "ercot.storage.net_output_mw"
LOAD_SOURCE = "ercot_public_np3_565_weather_zone_forecast"
LOAD_PRODUCT = "NP3-565-CD"
WIND_SOURCE = "ercot_mis_np4_732"
WIND_PRODUCT = "NP4-732-CD"
SOLAR_SOURCE = "ercot_mis_np4_737"
SOLAR_PRODUCT = "NP4-737-CD"


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _delivery_bounds(delivery_date: str) -> tuple[int, int]:
    try:
        parsed = date.fromisoformat(delivery_date)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_net_load_delivery_date") from exc
    if parsed.isoformat() != delivery_date:
        raise ValueError("invalid_net_load_delivery_date")
    start = int(datetime.combine(parsed, datetime_time(), CHICAGO).timestamp())
    end = int(datetime.combine(parsed + timedelta(days=1), datetime_time(), CHICAGO).timestamp())
    if end - start not in (82_800, 86_400, 90_000):
        raise ValueError("invalid_net_load_delivery_day")
    return start, end


def _mean(values):
    return sum(values) / len(values) if values else None


def init_net_load_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS net_load_resources (
            series_key TEXT NOT NULL,
            methodology_version TEXT NOT NULL,
            content_version TEXT NOT NULL,
            horizon TEXT NOT NULL,
            day_start INTEGER NOT NULL,
            lod TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (
                series_key, methodology_version, content_version, horizon, day_start, lod
            )
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS net_load_current (
            series_key TEXT NOT NULL,
            methodology_version TEXT NOT NULL,
            horizon TEXT NOT NULL,
            day_start INTEGER NOT NULL,
            content_version TEXT NOT NULL,
            dataset_cutoff INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (series_key, methodology_version, horizon, day_start)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_net_load_current_date
        ON net_load_current(day_start DESC, series_key, horizon)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS net_load_daily_resources (
            series_key TEXT NOT NULL, methodology_version TEXT NOT NULL,
            content_version TEXT NOT NULL, horizon TEXT NOT NULL,
            delivery_date TEXT NOT NULL, payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(series_key,methodology_version,content_version,horizon,delivery_date)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS net_load_daily_current (
            series_key TEXT NOT NULL, methodology_version TEXT NOT NULL,
            horizon TEXT NOT NULL, delivery_date TEXT NOT NULL,
            content_version TEXT NOT NULL, dataset_cutoff INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(series_key,methodology_version,horizon,delivery_date)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS net_load_materialization_health (
            pipeline TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            last_attempt_ts INTEGER NOT NULL,
            last_success_ts INTEGER,
            last_error_code TEXT
        )
        """
    )
    conn.commit()


def record_net_load_materialization_health(
    conn, pipeline, success, current_ts, error_code=None
):
    if pipeline not in ("actual", "forecast"):
        raise ValueError("invalid_net_load_pipeline")
    code = None if success else str(error_code or "materialization_failed")[:80]
    conn.execute(
        """
        INSERT INTO net_load_materialization_health
        (pipeline,state,last_attempt_ts,last_success_ts,last_error_code)
        VALUES(?,?,?,CASE WHEN ? THEN ? ELSE NULL END,?)
        ON CONFLICT(pipeline) DO UPDATE SET
          state=excluded.state,last_attempt_ts=excluded.last_attempt_ts,
          last_success_ts=CASE WHEN ? THEN excluded.last_attempt_ts
                               ELSE net_load_materialization_health.last_success_ts END,
          last_error_code=excluded.last_error_code
        """,
        (pipeline,"healthy" if success else "failed",current_ts,int(success),current_ts,code,int(success)),
    )
    conn.commit()


def _latest_metric_rows(conn, start: int, end: int):
    names = tuple(REALTIME_METRICS.values())
    placeholders = ",".join("?" for _ in names)
    rows = conn.execute(
        f"""
        WITH ranked AS (
            SELECT metric_name, ts, value,
                   ROW_NUMBER() OVER (PARTITION BY metric_name, ts ORDER BY id DESC) AS rank
            FROM metrics INDEXED BY idx_metrics_name_ts_value_id
            WHERE metric_name IN ({placeholders}) AND ts >= ? AND ts < ?
              AND (
                series_id IN (
                  SELECT id FROM series WHERE metric_name IN ({placeholders}) AND tags_json='[]'
                )
                OR (series_id IS NULL AND tags='[]')
              )
        )
        SELECT metric_name, ts, value FROM ranked WHERE rank = 1 ORDER BY ts, metric_name
        """,
        (*names, start, end, *names),
    ).fetchall()
    by_timestamp = defaultdict(dict)
    reverse = {value: key for key, value in REALTIME_METRICS.items()}
    for metric_name, timestamp, value in rows:
        by_timestamp[int(timestamp)][reverse[metric_name]] = float(value)
    return by_timestamp


def _storage_buckets(conn, start: int, end: int):
    rows = conn.execute(
        """
        WITH ranked AS (
          SELECT ts, value, ROW_NUMBER() OVER (PARTITION BY ts ORDER BY id DESC) rank
          FROM metrics INDEXED BY idx_metrics_name_ts_value_id
          WHERE metric_name = ? AND ts >= ? AND ts < ?
            AND (
              series_id=(SELECT id FROM series WHERE metric_name=? AND tags_json='[]')
              OR (series_id IS NULL AND tags='[]')
            )
        )
        SELECT ts, value FROM ranked WHERE rank=1 ORDER BY ts
        """,
        (STORAGE_METRIC, start, end, STORAGE_METRIC),
    ).fetchall()
    buckets = defaultdict(list)
    for timestamp, value in rows:
        buckets[(int(timestamp) // 300) * 300].append(float(value))
    return {bucket: _mean(values) for bucket, values in buckets.items()}


def _actual_rows(conn, start: int, end: int):
    raw = _latest_metric_rows(conn, start - 10_800, end)
    buckets = defaultdict(list)
    for timestamp, values in raw.items():
        if set(values) != set(REALTIME_METRICS):
            continue
        bucket = (timestamp // 300) * 300
        derived = values["demand"] - values["wind"] - values["solar"]
        buckets[bucket].append(
            (
                values["demand"], values["wind"], values["solar"],
                derived, values["published"], derived - values["published"],
            )
        )
    storage = _storage_buckets(conn, start, end)
    values_by_target = {}
    for bucket, samples in buckets.items():
        values_by_target[bucket] = {
            "demand_mw": _mean([sample[0] for sample in samples]),
            "wind_mw": _mean([sample[1] for sample in samples]),
            "solar_mw": _mean([sample[2] for sample in samples]),
            "net_load_mw": _mean([sample[3] for sample in samples]),
            "published_average_net_load_mw": _mean([sample[4] for sample in samples]),
            "published_residual_mw": _mean([sample[5] for sample in samples]),
            "sample_count": len(samples),
        }
    rows = []
    for target in range(start, end, 300):
        values = values_by_target.get(target)
        if values is None:
            rows.append({
                "target_ts": target, "demand_mw": None, "wind_mw": None,
                "solar_mw": None, "net_load_mw": None,
                "published_average_net_load_mw": None, "published_residual_mw": None,
                "storage_net_output_mw": storage.get(target),
                "ramp_1h_mw": None, "ramp_3h_mw": None,
                "sample_count": 0, "missing_reason": "missing_same_timestamp_quartet",
            })
            continue
        one_hour = values_by_target.get(target - 3_600)
        three_hours = values_by_target.get(target - 10_800)
        rows.append({
            "target_ts": target,
            **values,
            "storage_net_output_mw": storage.get(target),
            "ramp_1h_mw": None if one_hour is None else values["net_load_mw"] - one_hour["net_load_mw"],
            "ramp_3h_mw": None if three_hours is None else values["net_load_mw"] - three_hours["net_load_mw"],
            "missing_reason": None,
        })
    return rows


def _select_load_publication(conn, start, end, as_of, dataset_cutoff):
    halo_start = start - 10_800
    expected = (end - halo_start) // 3_600
    return conn.execute(
        """
        SELECT p.id, p.vintage_key, p.issued_at, p.retrieved_at
        FROM forecast_publications p INDEXED BY idx_forecast_publication_issue
        WHERE p.source_id = ? AND p.product_id = ? AND p.issued_at <= ?
          AND p.retrieved_at <= ? AND (
              SELECT COUNT(DISTINCT r.target_ts) FROM forecast_np3_565_rows r
              WHERE r.publication_id = p.id AND r.target_ts >= ? AND r.target_ts < ?
          ) = ? AND NOT EXISTS (
              SELECT 1 FROM forecast_np3_565_rows r
              WHERE r.publication_id=p.id AND r.target_ts>=? AND r.target_ts<?
              GROUP BY r.target_ts
              HAVING SUM(CASE WHEN r.in_use_flag=1 THEN 1 ELSE 0 END) != 1
          )
        ORDER BY p.issued_at DESC, p.id DESC LIMIT 1
        """,
        (
            LOAD_SOURCE, LOAD_PRODUCT, as_of, dataset_cutoff,
            halo_start, end, expected, halo_start, end,
        ),
    ).fetchone()


def _select_renewable_publication(conn, source, product, start, end, as_of, dataset_cutoff):
    halo_start = start - 10_800
    expected = (end - halo_start) // 3_600
    return conn.execute(
        """
        SELECT p.id, p.vintage_key, p.issued_at, p.retrieved_at
        FROM renewable_forecast_publications p INDEXED BY idx_renewable_publications_issue
        WHERE p.source_id = ? AND p.product_id = ? AND p.issued_at <= ?
          AND p.retrieved_at <= ? AND (
              SELECT COUNT(DISTINCT r.target_ts) FROM renewable_forecast_rows r
              WHERE r.publication_id = p.id AND r.target_ts >= ? AND r.target_ts < ?
          ) = ?
        ORDER BY p.issued_at DESC, p.id DESC LIMIT 1
        """,
        (source, product, as_of, dataset_cutoff, halo_start, end, expected),
    ).fetchone()


def _forecast_rows(conn, start, end, horizon, dataset_cutoff, targets=None):
    policy_cutoff = start - HORIZONS[horizon]
    as_of = min(policy_cutoff, dataset_cutoff)
    expected_targets = list(range(start, end, 3_600)) if targets is None else list(targets)
    if not expected_targets:
        raise ValueError("invalid_net_load_target_window")
    visible_start = expected_targets[0]
    visible_end = expected_targets[-1] + 3_600
    load_pub = _select_load_publication(conn, visible_start, visible_end, as_of, dataset_cutoff)
    wind_pub = _select_renewable_publication(
        conn, WIND_SOURCE, WIND_PRODUCT, visible_start, visible_end, as_of, dataset_cutoff
    )
    solar_pub = _select_renewable_publication(
        conn, SOLAR_SOURCE, SOLAR_PRODUCT, visible_start, visible_end, as_of, dataset_cutoff
    )
    contributors = {
        name: None if row is None else {
            "vintage_key": row[1], "issued_at": int(row[2]), "retrieved_at": int(row[3])
        }
        for name, row in (("load", load_pub), ("wind", wind_pub), ("solar", solar_pub))
    }
    load = {}
    if load_pub is not None:
        source_rows = conn.execute(
            """
            SELECT target_ts,
                   SUM(CASE WHEN in_use_flag = 1 THEN 1 ELSE 0 END) active_count,
                   MAX(CASE WHEN in_use_flag = 1 THEN model END) active_model,
                   MAX(CASE WHEN in_use_flag = 1 THEN system_total END) system_total
            FROM forecast_np3_565_rows INDEXED BY idx_forecast_np3_565_target
            WHERE publication_id = ? AND target_ts >= ? AND target_ts < ?
            GROUP BY target_ts ORDER BY target_ts
            """,
            (load_pub[0], visible_start - 10_800, visible_end),
        ).fetchall()
        load = {int(row[0]): row for row in source_rows}

    def renewable_values(publication):
        if publication is None:
            return {}
        return {
            int(row[0]): float(row[1])
            for row in conn.execute(
                """
                SELECT target_ts, forecast_mw FROM renewable_forecast_rows
                INDEXED BY idx_renewable_forecast_target
                WHERE publication_id = ? AND target_ts >= ? AND target_ts < ?
                ORDER BY target_ts
                """,
                (publication[0], visible_start - 10_800, visible_end),
            )
        }

    wind = renewable_values(wind_pub)
    solar = renewable_values(solar_pub)
    net_by_target = {}
    for target, load_row in load.items():
        if (
            int(load_row[1]) == 1
            and _finite(load_row[3])
            and target in wind
            and target in solar
            and _finite(wind[target])
            and _finite(solar[target])
        ):
            net_by_target[target] = float(load_row[3]) - wind[target] - solar[target]
    rows = []
    for target in expected_targets:
        load_row = load.get(target)
        reason = None
        if load_pub is None:
            reason = "missing_load_publication"
        elif wind_pub is None:
            reason = "missing_wind_publication"
        elif solar_pub is None:
            reason = "missing_solar_publication"
        elif load_row is None:
            reason = "missing_common_target"
        elif int(load_row[1]) != 1:
            reason = "ambiguous_active_load_model"
        elif target not in wind or target not in solar:
            reason = "missing_common_target"
        demand = None if load_row is None or int(load_row[1]) != 1 else load_row[3]
        if reason is None and (not _finite(demand) or not _finite(wind[target]) or not _finite(solar[target])):
            reason = "invalid_value"
        net = None if reason else float(demand) - wind[target] - solar[target]
        rows.append({
            "target_ts": target,
            "demand_mw": None if demand is None else float(demand),
            "wind_mw": wind.get(target), "solar_mw": solar.get(target),
            "net_load_mw": net, "model": None if load_row is None else load_row[2],
            "ramp_1h_mw": None, "ramp_3h_mw": None, "missing_reason": reason,
        })
    for row in rows:
        target = row["target_ts"]
        if row["net_load_mw"] is None:
            continue
        if target - 3_600 in net_by_target:
            row["ramp_1h_mw"] = row["net_load_mw"] - net_by_target[target - 3_600]
        if target - 10_800 in net_by_target:
            row["ramp_3h_mw"] = row["net_load_mw"] - net_by_target[target - 10_800]
    return rows, contributors, policy_cutoff, as_of


def _daily_ramp(rows, start, end, expected_count=None):
    valid = [row for row in rows if row["net_load_mw"] is not None]
    if expected_count is None:
        targets = sorted({row["target_ts"] for row in rows})
        cadence = min(
            (right - left for left, right in zip(targets, targets[1:]) if right > left),
            default=end - start,
        )
        expected_count = (end - start) // cadence
    complete = len(valid) == expected_count
    evening = [
        row for row in valid
        if 16 <= datetime.fromtimestamp(row["target_ts"], CHICAGO).hour < 22
    ]
    if not evening:
        return None
    peak = min(evening, key=lambda row: (-row["net_load_mw"], row["target_ts"]))
    preceding = [row for row in valid if start <= row["target_ts"] <= peak["target_ts"]]
    if not preceding:
        return None
    minimum = min(preceding, key=lambda row: (row["net_load_mw"], row["target_ts"]))
    return {
        "policy": EVENING_POLICY,
        "complete_day": complete,
        "expected_point_count": expected_count,
        "observed_point_count": len(valid),
        "minimum_target_ts": minimum["target_ts"],
        "minimum_net_load_mw": minimum["net_load_mw"],
        "evening_peak_target_ts": peak["target_ts"],
        "evening_peak_net_load_mw": peak["net_load_mw"],
        "ramp_mw": peak["net_load_mw"] - minimum["net_load_mw"],
        "elapsed_seconds": peak["target_ts"] - minimum["target_ts"],
        "day_start": start, "day_end": end,
    }


def _semantic_key(series_key, horizon):
    if series_key == ACTUAL_SERIES_KEY and horizon == "actual":
        return ACTUAL_SERIES_KEY
    if series_key == FORECAST_SERIES_KEY and horizon in FORECAST_SEMANTIC_KEYS:
        return FORECAST_SEMANTIC_KEYS[horizon]
    raise ValueError("invalid_net_load_identity")


def _internal_identity(semantic_key):
    if semantic_key == ACTUAL_SERIES_KEY:
        return ACTUAL_SERIES_KEY, "actual"
    for horizon, key in FORECAST_SEMANTIC_KEYS.items():
        if semantic_key == key:
            return FORECAST_SERIES_KEY, horizon
    raise ValueError("invalid_net_load_identity")


def _daily_semantic_key(series_key, horizon):
    if series_key == ACTUAL_SERIES_KEY and horizon == "actual":
        return ACTUAL_SERIES_KEY
    if series_key == FORECAST_SERIES_KEY and horizon in DAILY_FORECAST_SEMANTIC_KEYS:
        return DAILY_FORECAST_SEMANTIC_KEYS[horizon]
    raise ValueError("invalid_net_load_identity")


def _internal_daily_identity(semantic_key):
    if semantic_key == ACTUAL_SERIES_KEY:
        return ACTUAL_SERIES_KEY, "actual"
    for horizon,key in DAILY_FORECAST_SEMANTIC_KEYS.items():
        if semantic_key == key:
            return FORECAST_SERIES_KEY,horizon
    raise ValueError("invalid_net_load_identity")


def _build_payload(conn, series_key, horizon, start, end, dataset_cutoff, *, kind):
    if series_key == ACTUAL_SERIES_KEY:
        if horizon != "actual":
            raise ValueError("invalid_net_load_horizon")
        rows = _actual_rows(conn, start, end)
        contributors = {"source_id": "ercot_realtime", "same_timestamp_required": True}
        description = "Actual demand minus actual wind and PVGR output"
    elif series_key == FORECAST_SERIES_KEY:
        if horizon not in HORIZONS:
            raise ValueError("invalid_net_load_horizon")
        targets = (
            range(start, end, 3_600)
            if kind == "net_load_tile"
            else range(start + 3_600, end + 1, 3_600)
        )
        policy_cutoff = start - HORIZONS[horizon]
        rows, contributors, policy_cutoff, effective_as_of = _forecast_rows(
            conn, start, end, horizon, dataset_cutoff, targets=targets
        )
        description = "NP3-565 demand minus NP4-732 STWPF and NP4-737 STPPF HSL-potential forecasts"
    else:
        raise ValueError("invalid_net_load_series")
    expected_count = (end - start) // (300 if series_key == ACTUAL_SERIES_KEY else 3_600)
    observed_count = sum(row["net_load_mw"] is not None for row in rows)
    exclusions = defaultdict(int)
    for row in rows:
        if row["missing_reason"] is not None:
            exclusions[row["missing_reason"]] += 1
    payload = {
        "kind": kind,
        "schema_version": RESOURCE_SCHEMA_VERSION,
        "methodology_version": METHODOLOGY_VERSION,
        "series_key": (
            _semantic_key(series_key, horizon)
            if kind == "net_load_tile"
            else _daily_semantic_key(series_key, horizon)
        ),
        "horizon": horizon,
        "day_start": start,
        "day_end": end,
        "timezone": "UTC" if kind == "net_load_tile" else "America/Chicago",
        "unit": "MW",
        "official_ercot_net_load": False,
        "description": description,
        "policy_cutoff": (
            None if series_key == ACTUAL_SERIES_KEY else policy_cutoff
        ),
        "finalized": (
            True if series_key == ACTUAL_SERIES_KEY else effective_as_of >= policy_cutoff
        ),
        "selection_policy": (
            None
            if series_key == ACTUAL_SERIES_KEY
            else (
                "coherent_whole_curve_latest_capped_before_utc_day"
                if kind == "net_load_tile"
                else "coherent_whole_curve_latest_capped_before_market_day"
            )
        ),
        "snapshot_lead_seconds": (
            None if series_key == ACTUAL_SERIES_KEY else HORIZONS[horizon]
        ),
        "contributors": contributors,
        "storage_policy": "context_only_not_in_formula",
        "ramp_policy": "exact_elapsed_no_interpolation_or_bridging",
        "expected_point_count": expected_count,
        "observed_point_count": observed_count,
        "complete": observed_count == expected_count,
        "exclusions": dict(sorted(exclusions.items())),
        "evening_policy": {
            "key": EVENING_POLICY,
            "timezone": "America/Chicago",
            "window": "[16:00,22:00)",
            "tie_policy": "earliest",
            "dashboard_defined": True,
        },
        "rows": rows,
    }
    if kind == "net_load_tile":
        payload.update(tile_span="1d", lod="native")
    else:
        payload["delivery_date"] = datetime.fromtimestamp(start, CHICAGO).date().isoformat()
        payload["daily_ramp"] = (
            _daily_ramp(rows, start, end, expected_count)
            if observed_count == expected_count
            else None
        )
        payload["daily_ramp_exclusion"] = (
            None if observed_count == expected_count else "incomplete_day"
        )
    digest = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    payload["content_version"] = "v1-" + digest
    return payload


def _resource_payload(conn, series_key, horizon, day_start, dataset_cutoff):
    if isinstance(day_start, bool) or not isinstance(day_start, int) or day_start < 0:
        raise ValueError("invalid_net_load_day_start")
    if day_start % 86_400:
        raise ValueError("invalid_net_load_day_start")
    return _build_payload(
        conn, series_key, horizon, day_start, day_start + 86_400,
        dataset_cutoff, kind="net_load_tile",
    )


def _daily_resource_payload(conn, series_key, horizon, delivery_date, dataset_cutoff):
    start, end = _delivery_bounds(delivery_date)
    return _build_payload(
        conn, series_key, horizon, start, end, dataset_cutoff,
        kind="net_load_daily_ramp",
    )


def recompute_net_load(
    conn, series_key, day_start, *, current_ts=None, dataset_cutoff=None, horizons=None
):
    current = int(time.time()) if current_ts is None else current_ts
    cutoff = current if dataset_cutoff is None else dataset_cutoff
    if isinstance(current, bool) or not isinstance(current, int) or current < 0:
        raise ValueError("invalid_net_load_current_time")
    if isinstance(cutoff, bool) or not isinstance(cutoff, int) or not 0 <= cutoff <= current:
        raise ValueError("invalid_net_load_dataset_cutoff")
    if isinstance(day_start, bool) or not isinstance(day_start, int) or day_start < 0 or day_start % 86_400:
        raise ValueError("invalid_net_load_day_start")
    end = day_start + 86_400
    if series_key == ACTUAL_SERIES_KEY and end > current:
        raise ValueError("incomplete_net_load_utc_day")
    allowed = ("actual",) if series_key == ACTUAL_SERIES_KEY else tuple(HORIZONS)
    selected = allowed if horizons is None else tuple(horizons)
    if not selected or len(set(selected)) != len(selected) or any(item not in allowed for item in selected):
        raise ValueError("invalid_net_load_horizons")
    nested = conn.in_transaction
    conn.execute("SAVEPOINT net_load_recompute" if nested else "BEGIN IMMEDIATE")
    results = []
    try:
        for horizon in selected:
            payload = _resource_payload(conn, series_key, horizon, day_start, cutoff)
            if series_key == FORECAST_SERIES_KEY and not payload["complete"]:
                continue
            content_version = payload["content_version"]
            payload_json = canonical_json(payload)
            conn.execute(
                """
                INSERT OR IGNORE INTO net_load_resources
                (series_key, methodology_version, content_version, horizon,
                 day_start, lod, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, 'native', ?, ?)
                """,
                (series_key, METHODOLOGY_VERSION, content_version, horizon,
                 day_start, payload_json, current),
            )
            conn.execute(
                """
                INSERT INTO net_load_current
                (series_key, methodology_version, horizon, day_start,
                 content_version, dataset_cutoff, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(series_key, methodology_version, horizon, day_start)
                DO UPDATE SET content_version=excluded.content_version,
                              dataset_cutoff=excluded.dataset_cutoff,
                              updated_at=CASE
                                WHEN excluded.content_version!=net_load_current.content_version
                                THEN excluded.updated_at ELSE net_load_current.updated_at END
                WHERE excluded.dataset_cutoff >= net_load_current.dataset_cutoff
                  AND (excluded.content_version != net_load_current.content_version
                       OR excluded.dataset_cutoff != net_load_current.dataset_cutoff)
                """,
                (series_key, METHODOLOGY_VERSION, horizon, day_start,
                 content_version, cutoff, current),
            )
            results.append({
                "series_key": series_key, "horizon": horizon,
                "day_start": day_start, "lod": "native", "content_version": content_version,
                "url": net_load_resource_url(
                    _semantic_key(series_key, horizon), METHODOLOGY_VERSION,
                    content_version, day_start, "native"
                ),
            })
            local_dates = {
                datetime.fromtimestamp(day_start, CHICAGO).date(),
                datetime.fromtimestamp(end - 1, CHICAGO).date(),
            }
            for local_date in sorted(local_dates):
                delivery_date = local_date.isoformat()
                _local_start, local_end = _delivery_bounds(delivery_date)
                if series_key == ACTUAL_SERIES_KEY and local_end > current:
                    continue
                daily = _daily_resource_payload(
                    conn, series_key, horizon, delivery_date, cutoff
                )
                if series_key == FORECAST_SERIES_KEY and not daily["complete"]:
                    continue
                daily_version = daily["content_version"]
                conn.execute(
                    """
                    INSERT OR IGNORE INTO net_load_daily_resources
                    (series_key,methodology_version,content_version,horizon,
                     delivery_date,payload_json,created_at)
                    VALUES(?,?,?,?,?,?,?)
                    """,
                    (series_key,METHODOLOGY_VERSION,daily_version,horizon,
                     delivery_date,canonical_json(daily),current),
                )
                conn.execute(
                    """
                    INSERT INTO net_load_daily_current
                    (series_key,methodology_version,horizon,delivery_date,
                     content_version,dataset_cutoff,updated_at)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(series_key,methodology_version,horizon,delivery_date)
                    DO UPDATE SET content_version=excluded.content_version,
                                  dataset_cutoff=excluded.dataset_cutoff,
                                  updated_at=CASE
                                    WHEN excluded.content_version!=net_load_daily_current.content_version
                                    THEN excluded.updated_at ELSE net_load_daily_current.updated_at END
                    WHERE excluded.dataset_cutoff>=net_load_daily_current.dataset_cutoff
                      AND (excluded.content_version!=net_load_daily_current.content_version
                           OR excluded.dataset_cutoff!=net_load_daily_current.dataset_cutoff)
                    """,
                    (series_key,METHODOLOGY_VERSION,horizon,delivery_date,
                     daily_version,cutoff,current),
                )
                results.append({
                    "series_key": _daily_semantic_key(series_key,horizon),
                    "delivery_date": delivery_date,
                    "content_version": daily_version,
                    "url": net_load_daily_resource_url(
                        _daily_semantic_key(series_key,horizon), METHODOLOGY_VERSION,
                        daily_version, delivery_date
                    ),
                })
        conn.execute("RELEASE SAVEPOINT net_load_recompute" if nested else "COMMIT")
    except Exception:
        if nested:
            conn.execute("ROLLBACK TO SAVEPOINT net_load_recompute")
            conn.execute("RELEASE SAVEPOINT net_load_recompute")
        else:
            conn.execute("ROLLBACK")
        raise
    return results


def net_load_resource_url(series_key, methodology, content_version, day_start, lod="native"):
    return (
        f"/api/v2/net-load/{series_key}/{methodology}/{content_version}/"
        f"1d/{day_start}/{lod}"
    )


def net_load_daily_resource_url(series_key, methodology, content_version, delivery_date):
    return f"/api/v2/net-load-daily/{series_key}/{methodology}/{content_version}/{delivery_date}"


def _validate_content_version(content_version):
    if not isinstance(content_version, str) or len(content_version) != 67 or not content_version.startswith("v1-"):
        raise ValueError("invalid_net_load_content_version")
    try:
        int(content_version[3:], 16)
    except ValueError as exc:
        raise ValueError("invalid_net_load_content_version") from exc


def net_load_resource(conn, series_key, methodology, content_version, day_start, lod="native"):
    if methodology != METHODOLOGY_VERSION:
        raise ValueError("invalid_net_load_methodology")
    base_key, horizon = _internal_identity(series_key)
    if lod != "native" or isinstance(day_start,bool) or not isinstance(day_start,int) or day_start<0 or day_start%86_400:
        raise ValueError("invalid_net_load_tile")
    _validate_content_version(content_version)
    row = conn.execute(
        """
        SELECT payload_json FROM net_load_resources
        WHERE series_key=? AND methodology_version=? AND content_version=?
          AND horizon=? AND day_start=? AND lod=?
        """,
        (base_key, methodology, content_version, horizon, day_start, lod),
    ).fetchone()
    return None if row is None else json.loads(row[0])


def net_load_daily_resource(conn, series_key, methodology, content_version, delivery_date):
    if methodology != METHODOLOGY_VERSION:
        raise ValueError("invalid_net_load_methodology")
    base_key, horizon = _internal_daily_identity(series_key)
    _delivery_bounds(delivery_date)
    _validate_content_version(content_version)
    row = conn.execute(
        """
        SELECT payload_json FROM net_load_daily_resources
        WHERE series_key=? AND methodology_version=? AND content_version=?
          AND horizon=? AND delivery_date=?
        """,
        (base_key,methodology,content_version,horizon,delivery_date),
    ).fetchone()
    return None if row is None else json.loads(row[0])


def net_load_manifest(conn, now=None):
    current = int(time.time()) if now is None else now
    completed_utc_day = (current // 86_400) * 86_400
    lower = completed_utc_day - MAX_MANIFEST_DAYS * 86_400
    rows = conn.execute(
        """
        SELECT c.series_key, c.horizon, c.day_start, c.content_version,
               c.dataset_cutoff, r.payload_json
        FROM net_load_current c JOIN net_load_resources r
          ON r.series_key=c.series_key AND r.methodology_version=c.methodology_version
         AND r.content_version=c.content_version AND r.horizon=c.horizon
         AND r.day_start=c.day_start AND r.lod='native'
        WHERE c.methodology_version=? AND c.day_start>=?
          AND ((c.series_key=? AND c.day_start<?)
            OR (c.series_key=? AND c.day_start<?))
        ORDER BY c.day_start, c.series_key, c.horizon LIMIT ?
        """,
        (
            METHODOLOGY_VERSION, lower,
            ACTUAL_SERIES_KEY, completed_utc_day,
            FORECAST_SERIES_KEY, completed_utc_day + 9*86_400,
            MAX_MANIFEST_DAYS * 4 + 27,
        ),
    ).fetchall()
    resources = []
    for series_key, horizon, day_start, content_version, dataset_cutoff, payload_json in rows:
        payload = json.loads(payload_json)
        valid_count = sum(row["net_load_mw"] is not None for row in payload["rows"])
        resources.append({
            "series_key": _semantic_key(series_key,horizon), "horizon": horizon,
            "day_start": day_start, "lod": "native", "content_version": content_version,
            "url": net_load_resource_url(
                _semantic_key(series_key,horizon), METHODOLOGY_VERSION,
                content_version, day_start, "native"
            ),
            "point_count": len(payload["rows"]), "valid_point_count": valid_count,
            "policy_cutoff": payload["policy_cutoff"],
            "effective_as_of": (
                None if payload["policy_cutoff"] is None
                else min(dataset_cutoff, payload["policy_cutoff"])
            ),
            "finalized": payload["finalized"],
        })
    daily_rows = conn.execute(
        """
        SELECT series_key,horizon,delivery_date,content_version,c.dataset_cutoff,payload_json
        FROM net_load_daily_current c JOIN net_load_daily_resources r
        USING(series_key,methodology_version,horizon,delivery_date,content_version)
        WHERE methodology_version=? AND delivery_date>=?
          AND ((series_key=? AND delivery_date<?)
            OR (series_key=? AND delivery_date<?))
        ORDER BY delivery_date DESC,series_key,horizon LIMIT ?
        """,
        (
            METHODOLOGY_VERSION,
            (datetime.fromtimestamp(current,CHICAGO).date()-timedelta(days=MAX_MANIFEST_DAYS)).isoformat(),
            ACTUAL_SERIES_KEY,
            datetime.fromtimestamp(current,CHICAGO).date().isoformat(),
            FORECAST_SERIES_KEY,
            (datetime.fromtimestamp(current,CHICAGO).date()+timedelta(days=9)).isoformat(),
            MAX_MANIFEST_DAYS*4+27,
        ),
    ).fetchall()
    daily_resources = []
    for series_key,horizon,delivery_date,content_version,dataset_cutoff,payload_json in daily_rows:
        payload=json.loads(payload_json)
        daily_resources.append({
            "series_key":_daily_semantic_key(series_key,horizon),
            "delivery_date":delivery_date,"content_version":content_version,
            "url":net_load_daily_resource_url(
                _daily_semantic_key(series_key,horizon),METHODOLOGY_VERSION,
                content_version,delivery_date),
            "complete":payload["complete"],"daily_ramp":payload["daily_ramp"],
            "policy_cutoff":payload["policy_cutoff"],
            "effective_as_of": (
                None if payload["policy_cutoff"] is None
                else min(dataset_cutoff,payload["policy_cutoff"])
            ),
            "finalized":payload["finalized"],
        })
    health = [
        {
            "pipeline":row[0],"state":row[1],"last_attempt_ts":row[2],
            "last_success_ts":row[3],"last_error_code":row[4],
        }
        for row in conn.execute(
            "SELECT pipeline,state,last_attempt_ts,last_success_ts,last_error_code "
            "FROM net_load_materialization_health ORDER BY pipeline"
        )
    ]
    return {
        "kind": "net_load_manifest", "schema_version": 1,
        "methodology_version": METHODOLOGY_VERSION,
        "window_days": MAX_MANIFEST_DAYS,
        "catalog": [
            {"series_key": ACTUAL_SERIES_KEY, "horizon": "actual", "native_interval_seconds": 300, "supported_lods":["native"], "display_name":"Dashboard-derived actual net load", "selection_policy":None},
            *[
                {"series_key": key,"horizon": horizon,"native_interval_seconds":3600,"supported_lods":["native"], "display_name":f"Latest coherent forecast capped {horizon} before UTC day", "selection_policy":"coherent_whole_curve_latest_capped_before_utc_day"}
                for horizon,key in FORECAST_SEMANTIC_KEYS.items()
            ],
        ],
        "formula": "demand_mw - wind_mw - solar_mw",
        "storage_policy": "context_only_not_in_formula",
        "official_ercot_net_load": False,
        "resources": resources,
        "daily_resources": daily_resources,
        "materialization_health": health,
    }
