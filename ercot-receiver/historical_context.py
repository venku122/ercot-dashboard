#!/usr/bin/env python3
"""Correction-aware, dashboard-derived historical demand context."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from datetime import date, datetime, time as datetime_time, timedelta
from zoneinfo import ZoneInfo


SCHEMA = 1
METHODOLOGY = "v1"
SERIES_KEY = "supply-demand.demand"
METRIC = "ercot.supply_demand.demand_mw"
TAGS_JSON = '["source:supply_demand"]'
POLICY = "collection_history_season_and_local_hour_context_not_forecast_or_all_time_record"
CHICAGO = ZoneInfo("America/Chicago")
CADENCE_SECONDS = 300
MIN_COVERAGE = 0.8
MAX_PRIOR_DAYS = 400
MAX_STORED_DAYS = MAX_PRIOR_DAYS + 1
MAX_BACKFILL_ROWS = MAX_STORED_DAYS * 300
CONTENT_VERSION_RE = re.compile(r"hc1-[0-9a-f]{64}")


def _canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def init_historical_context_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS historical_context_state (
          series_key TEXT PRIMARY KEY,
          generation INTEGER NOT NULL,
          dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
          dirty_from INTEGER,
          dirty_to INTEGER
        );
        CREATE TABLE IF NOT EXISTS historical_context_dirty_days (
          market_date TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS historical_demand_hours (
          market_date TEXT NOT NULL,
          local_hour INTEGER NOT NULL CHECK(local_hour BETWEEN 0 AND 23),
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          occurrence_count INTEGER NOT NULL,
          expected_count INTEGER NOT NULL,
          observed_count INTEGER NOT NULL,
          first_observed_ts INTEGER,
          last_observed_ts INTEGER,
          minimum REAL,
          minimum_ts INTEGER,
          maximum REAL,
          maximum_ts INTEGER,
          qualified INTEGER NOT NULL CHECK(qualified IN (0,1)),
          generation INTEGER NOT NULL,
          PRIMARY KEY(market_date,local_hour)
        );
        CREATE INDEX IF NOT EXISTS idx_historical_demand_hours_lookup
          ON historical_demand_hours(local_hour,market_date);
        CREATE TABLE IF NOT EXISTS historical_demand_days (
          market_date TEXT PRIMARY KEY,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          expected_count INTEGER NOT NULL,
          observed_count INTEGER NOT NULL,
          first_observed_ts INTEGER,
          last_observed_ts INTEGER,
          minimum REAL,
          minimum_ts INTEGER,
          maximum REAL,
          maximum_ts INTEGER,
          qualified INTEGER NOT NULL CHECK(qualified IN (0,1)),
          generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS historical_context_resources (
          series_key TEXT NOT NULL,
          methodology TEXT NOT NULL,
          content_version TEXT NOT NULL,
          as_of INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY(series_key,methodology,content_version,as_of)
        );
        """
    )
    conn.execute(
        """INSERT OR IGNORE INTO historical_context_state
           (series_key,generation,dirty,dirty_from,dirty_to)
           VALUES (?,0,1,NULL,NULL)""",
        (SERIES_KEY,),
    )
    conn.commit()


def mark_demand_history_changes(conn: sqlite3.Connection, timestamps) -> None:
    changed = sorted({int(ts) for ts in timestamps})
    if not changed:
        return
    conn.execute(
        """UPDATE historical_context_state
           SET generation=generation+1,dirty=1,
               dirty_from=CASE WHEN dirty_from IS NULL THEN ? ELSE min(dirty_from,?) END,
               dirty_to=CASE WHEN dirty_to IS NULL THEN ? ELSE max(dirty_to,?) END
           WHERE series_key=?""",
        (changed[0], changed[0], changed[-1], changed[-1], SERIES_KEY),
    )
    conn.executemany(
        "INSERT OR IGNORE INTO historical_context_dirty_days(market_date) VALUES (?)",
        [(datetime.fromtimestamp(timestamp, CHICAGO).date().isoformat(),) for timestamp in changed],
    )


def _date_bounds(day: date) -> tuple[int, int]:
    start = int(datetime.combine(day, datetime_time(), CHICAGO).timestamp())
    end = int(datetime.combine(day + timedelta(days=1), datetime_time(), CHICAGO).timestamp())
    if end - start not in (23 * 3600, 24 * 3600, 25 * 3600):
        raise ValueError("invalid_chicago_day")
    return start, end


def _hour_starts(day: date, hour: int) -> list[int]:
    start, end = _date_bounds(day)
    matches = []
    cursor = start
    while cursor < end:
        local = datetime.fromtimestamp(cursor, CHICAGO)
        if local.date() == day and local.hour == hour:
            matches.append(cursor)
        cursor += 3600
    return matches


def _hour_bounds(day: date, hour: int) -> tuple[int, int, int] | None:
    starts = _hour_starts(day, hour)
    if not starts:
        return None
    return starts[0], starts[-1] + 3600, len(starts)


def _season(day: date) -> str:
    if day.month in (12, 1, 2):
        return "DJF"
    if day.month in (3, 4, 5):
        return "MAM"
    if day.month in (6, 7, 8):
        return "JJA"
    return "SON"


def _type7(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (position - lower) * (ordered[upper] - ordered[lower])


def _demand_series_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute(
        "SELECT id FROM series WHERE metric_name=? AND tags_json=?",
        (METRIC, TAGS_JSON),
    ).fetchone()
    return None if row is None else int(row[0])


def _raw_bounds(conn: sqlite3.Connection, series_id: int | None):
    if series_id is None:
        return None, None
    row = conn.execute(
        "SELECT min(ts),max(ts) FROM metrics WHERE series_id=?", (series_id,)
    ).fetchone()
    return row if row else (None, None)


def _rebuild(conn: sqlite3.Connection, generation: int) -> dict[str, object]:
    series_id = _demand_series_id(conn)
    raw_start, raw_end = _raw_bounds(conn, series_id)
    conn.execute("DELETE FROM historical_demand_hours")
    conn.execute("DELETE FROM historical_demand_days")
    if raw_start is None:
        return {"raw_start": None, "raw_end": None, "backfill_complete": True}
    final_day = datetime.fromtimestamp(raw_end, CHICAGO).date()
    first_raw_day = datetime.fromtimestamp(raw_start, CHICAGO).date()
    first_day = max(first_raw_day, final_day - timedelta(days=MAX_STORED_DAYS - 1))
    scan_start, _ = _date_bounds(first_day)
    _, scan_end = _date_bounds(final_day)
    rows = conn.execute(
        """SELECT ts,value FROM metrics
           WHERE series_id=? AND ts>=? AND ts<? ORDER BY ts,id LIMIT ?""",
        (series_id, scan_start, scan_end, MAX_BACKFILL_ROWS + 1),
    ).fetchall()
    row_limited = len(rows) > MAX_BACKFILL_ROWS
    rows = rows[:MAX_BACKFILL_ROWS]
    by_timestamp = {}
    for timestamp, value in rows:
        if int(timestamp) % CADENCE_SECONDS == 0:
            by_timestamp[int(timestamp)] = float(value)
    points = sorted(by_timestamp.items())
    day = first_day
    while day <= final_day:
        day_start, day_end = _date_bounds(day)
        day_points = [(ts, value) for ts, value in points if day_start <= ts < day_end]
        expected_day = (day_end - day_start) // CADENCE_SECONDS
        day_qualified = len(day_points) >= math.ceil(expected_day * MIN_COVERAGE)
        minimum = min(day_points, key=lambda point: (point[1], point[0])) if day_points else None
        maximum = max(day_points, key=lambda point: (point[1], -point[0])) if day_points else None
        conn.execute(
            """INSERT INTO historical_demand_days VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                day.isoformat(), day_start, day_end, expected_day, len(day_points),
                None if not day_points else day_points[0][0],
                None if not day_points else day_points[-1][0],
                None if minimum is None else minimum[1], None if minimum is None else minimum[0],
                None if maximum is None else maximum[1], None if maximum is None else maximum[0],
                int(day_qualified), generation,
            ),
        )
        for hour in range(24):
            bounds = _hour_bounds(day, hour)
            if bounds is None:
                continue
            hour_start, hour_end, occurrences = bounds
            hour_points = [(ts, value) for ts, value in day_points if hour_start <= ts < hour_end]
            expected = 12 * occurrences
            qualified = len(hour_points) >= math.ceil(expected * MIN_COVERAGE)
            minimum = min(hour_points, key=lambda point: (point[1], point[0])) if hour_points else None
            maximum = max(hour_points, key=lambda point: (point[1], -point[0])) if hour_points else None
            conn.execute(
                """INSERT INTO historical_demand_hours VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    day.isoformat(), hour, hour_start, hour_end, occurrences, expected,
                    len(hour_points), None if not hour_points else hour_points[0][0],
                    None if not hour_points else hour_points[-1][0],
                    None if minimum is None else minimum[1],
                    None if minimum is None else minimum[0],
                    None if maximum is None else maximum[1],
                    None if maximum is None else maximum[0], int(qualified), generation,
                ),
            )
        day += timedelta(days=1)
    return {
        "raw_start": int(raw_start), "raw_end": int(raw_end),
        "backfill_complete": first_day == first_raw_day and not row_limited,
    }


def _rebuild_one_day(
    conn: sqlite3.Connection, series_id: int, day: date, generation: int
) -> None:
    day_start, day_end = _date_bounds(day)
    rows = conn.execute(
        """SELECT ts,value FROM metrics
           WHERE series_id=? AND ts>=? AND ts<? ORDER BY ts,id LIMIT 301""",
        (series_id, day_start, day_end),
    ).fetchall()
    if len(rows) > 300:
        raise ValueError("historical_context_day_row_bound")
    by_timestamp = {
        int(timestamp): float(value)
        for timestamp, value in rows
        if int(timestamp) % CADENCE_SECONDS == 0
    }
    points = sorted(by_timestamp.items())
    conn.execute("DELETE FROM historical_demand_hours WHERE market_date=?", (day.isoformat(),))
    conn.execute("DELETE FROM historical_demand_days WHERE market_date=?", (day.isoformat(),))
    expected_day = (day_end - day_start) // CADENCE_SECONDS
    minimum = min(points, key=lambda point: (point[1], point[0])) if points else None
    maximum = max(points, key=lambda point: (point[1], -point[0])) if points else None
    conn.execute(
        "INSERT INTO historical_demand_days VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            day.isoformat(), day_start, day_end, expected_day, len(points),
            None if not points else points[0][0], None if not points else points[-1][0],
            None if minimum is None else minimum[1], None if minimum is None else minimum[0],
            None if maximum is None else maximum[1], None if maximum is None else maximum[0],
            int(len(points) >= math.ceil(expected_day * MIN_COVERAGE)), generation,
        ),
    )
    for hour in range(24):
        bounds = _hour_bounds(day, hour)
        if bounds is None:
            continue
        hour_start, hour_end, occurrences = bounds
        hour_points = [(ts, value) for ts, value in points if hour_start <= ts < hour_end]
        expected = 12 * occurrences
        minimum = min(hour_points, key=lambda point: (point[1], point[0])) if hour_points else None
        maximum = max(hour_points, key=lambda point: (point[1], -point[0])) if hour_points else None
        conn.execute(
            "INSERT INTO historical_demand_hours VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                day.isoformat(), hour, hour_start, hour_end, occurrences, expected,
                len(hour_points), None if not hour_points else hour_points[0][0],
                None if not hour_points else hour_points[-1][0],
                None if minimum is None else minimum[1],
                None if minimum is None else minimum[0],
                None if maximum is None else maximum[1],
                None if maximum is None else maximum[0],
                int(len(hour_points) >= math.ceil(expected * MIN_COVERAGE)), generation,
            ),
        )


def _rebuild_dirty_days(conn, generation: int, dirty_days: list[str]):
    series_id = _demand_series_id(conn)
    raw_start, raw_end = _raw_bounds(conn, series_id)
    if series_id is None or raw_start is None:
        conn.execute("DELETE FROM historical_demand_hours")
        conn.execute("DELETE FROM historical_demand_days")
        return {"raw_start": None, "raw_end": None, "backfill_complete": True}
    final_day = datetime.fromtimestamp(raw_end, CHICAGO).date()
    first_raw_day = datetime.fromtimestamp(raw_start, CHICAGO).date()
    first_day = max(first_raw_day, final_day - timedelta(days=MAX_STORED_DAYS - 1))
    conn.execute("DELETE FROM historical_demand_hours WHERE market_date<? OR market_date>?", (first_day.isoformat(), final_day.isoformat()))
    conn.execute("DELETE FROM historical_demand_days WHERE market_date<? OR market_date>?", (first_day.isoformat(), final_day.isoformat()))
    for raw_day in dirty_days:
        day = date.fromisoformat(raw_day)
        if first_day <= day <= final_day:
            _rebuild_one_day(conn, series_id, day, generation)
    return {
        "raw_start": int(raw_start), "raw_end": int(raw_end),
        "backfill_complete": first_day == first_raw_day,
    }


def ensure_materialized(conn: sqlite3.Connection) -> tuple[int, dict[str, object]]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        generation, dirty = conn.execute(
            "SELECT generation,dirty FROM historical_context_state WHERE series_key=?",
            (SERIES_KEY,),
        ).fetchone()
        raw = _raw_bounds(conn, _demand_series_id(conn))
        metadata = {
            "raw_start": raw[0], "raw_end": raw[1], "backfill_complete": True
        }
        if dirty:
            dirty_days = [row[0] for row in conn.execute(
                "SELECT market_date FROM historical_context_dirty_days ORDER BY market_date"
            )]
            has_summaries = conn.execute(
                "SELECT 1 FROM historical_demand_days LIMIT 1"
            ).fetchone() is not None
            metadata = (
                _rebuild_dirty_days(conn, int(generation), dirty_days)
                if has_summaries and dirty_days
                else _rebuild(conn, int(generation))
            )
            conn.execute(
                """UPDATE historical_context_state
                   SET dirty=0,dirty_from=NULL,dirty_to=NULL
                   WHERE series_key=? AND generation=?""",
                (SERIES_KEY, generation),
            )
            conn.execute("DELETE FROM historical_context_dirty_days")
        else:
            first = conn.execute("SELECT min(start_ts) FROM historical_demand_days").fetchone()[0]
            metadata["backfill_complete"] = raw[0] is None or first is None or first <= raw[0]
        conn.commit()
        return int(generation), metadata
    except Exception:
        conn.rollback()
        raise


def historical_context_as_of_bounds(conn: sqlite3.Connection, current: int):
    upper = (int(current) // 3600) * 3600
    raw_start, _raw_end = _raw_bounds(conn, _demand_series_id(conn))
    lower = upper - MAX_PRIOR_DAYS * 86400
    if raw_start is not None:
        lower = max(lower, (int(raw_start) // 3600) * 3600)
    else:
        lower = upper
    return max(0, lower), upper


def _coverage(row, expected_if_missing=0) -> dict[str, object]:
    if row is None:
        return {"state": "unavailable", "expected_count": expected_if_missing, "observed_count": 0, "ratio": 0.0, "first_observed_at": None, "last_observed_at": None}
    expected, observed, qualified = int(row[5]), int(row[6]), bool(row[13])
    return {
        "state": "qualified" if qualified else ("partial" if observed else "unavailable"),
        "expected_count": expected, "observed_count": observed,
        "ratio": observed / expected if expected else 0.0,
        "first_observed_at": row[7], "last_observed_at": row[8],
    }


def _hour_row(conn, day: date, hour: int):
    return conn.execute(
        """SELECT market_date,local_hour,start_ts,end_ts,occurrence_count,
                  expected_count,observed_count,first_observed_ts,last_observed_ts,
                  minimum,minimum_ts,maximum,maximum_ts,qualified
           FROM historical_demand_hours WHERE market_date=? AND local_hour=?""",
        (day.isoformat(), hour),
    ).fetchone()


def _hour_value(row):
    return None if row is None or not row[13] else {"value": row[11], "timestamp": row[12]}


def _shift_year(day: date) -> date | None:
    try:
        return day.replace(year=day.year - 1)
    except ValueError:
        return None


def _intervals(day: date, hour: int) -> list[dict[str, int]]:
    return [{"start": start, "end": start + 3600} for start in _hour_starts(day, hour)]


def _comparison(conn, day: date | None, hour: int, *, anniversary=False) -> dict[str, object]:
    if day is None:
        return {"state": "unavailable", "reason": "unavailable_no_calendar_anniversary" if anniversary else "nonexistent_local_hour", "market_date": None, "local_hour": hour, "utc_intervals": [], "coverage": None, "value": None}
    bounds = _hour_bounds(day, hour)
    if bounds is None:
        return {"state": "unavailable", "reason": "nonexistent_local_hour", "market_date": day.isoformat(), "local_hour": hour, "utc_intervals": [], "coverage": {"state": "unavailable", "expected_count": 0, "observed_count": 0, "ratio": 0.0, "first_observed_at": None, "last_observed_at": None}, "value": None}
    row = _hour_row(conn, day, hour)
    coverage = _coverage(row, 12 * bounds[2])
    return {
        "state": "available" if _hour_value(row) else coverage["state"],
        "reason": None if _hour_value(row) else "insufficient_coverage",
        "market_date": day.isoformat(), "local_hour": hour,
        "utc_intervals": _intervals(day, hour),
        "coverage": coverage, "value": _hour_value(row),
    }


def _latest_completed_hour(as_of: int) -> tuple[date, int, tuple[int, int, int]]:
    local_day = datetime.fromtimestamp(as_of, CHICAGO).date()
    candidates = []
    for delta in range(3):
        day = local_day - timedelta(days=delta)
        for hour in range(24):
            bounds = _hour_bounds(day, hour)
            if bounds is not None and bounds[1] <= as_of:
                candidates.append((bounds[1], day, hour, bounds))
    if not candidates:
        raise ValueError("no_completed_local_hour")
    _end, day, hour, bounds = max(candidates)
    return day, hour, bounds


def _extrema(conn, start: int | None, end: int, label: str, complete: bool):
    if start is None:
        return {"window": label, "state": "unavailable", "start": None, "end": end, "minimum": None, "maximum": None, "coverage": None}
    rows = conn.execute(
        """SELECT expected_count,observed_count,first_observed_ts,last_observed_ts,
                  minimum,minimum_ts,maximum,maximum_ts
           FROM historical_demand_hours WHERE end_ts>? AND end_ts<=? ORDER BY start_ts""",
        (start, end),
    ).fetchall()
    expected = sum(row[0] for row in rows)
    observed = sum(row[1] for row in rows)
    first_observed = [row[2] for row in rows if row[2] is not None]
    last_observed = [row[3] for row in rows if row[3] is not None]
    minima = [(row[4], row[5]) for row in rows if row[4] is not None]
    maxima = [(row[6], row[7]) for row in rows if row[6] is not None]
    ratio = observed / expected if expected else 0.0
    qualified = complete and expected > 0 and ratio >= MIN_COVERAGE
    return {
        "window": label, "state": "qualified" if qualified else ("partial" if observed else "unavailable"),
        "start": start, "end": end,
        "minimum": None if not minima else {"value": min(minima)[0], "timestamp": min(minima)[1]},
        "maximum": None if not maxima else {"value": max(maxima, key=lambda item: (item[0], -item[1]))[0], "timestamp": max(maxima, key=lambda item: (item[0], -item[1]))[1]},
        "coverage": {
            "expected_count": expected, "observed_count": observed, "ratio": ratio,
            "first_observed_at": None if not first_observed else min(first_observed),
            "last_observed_at": None if not last_observed else max(last_observed),
        },
    }


def build_summary(conn: sqlite3.Connection, as_of: int, generation: int, metadata) -> dict[str, object]:
    day, hour, bounds = _latest_completed_hour(as_of)
    selected = _hour_row(conn, day, hour)
    prior_dates = []
    cursor = day - timedelta(days=1)
    while len(prior_dates) < 400:
        prior_dates.append(cursor)
        cursor -= timedelta(days=1)
    cohort_candidates = [
        candidate for candidate in prior_dates if _season(candidate) == _season(day)
    ]
    cohort_candidate_rows = [
        (candidate, _hour_row(conn, candidate, hour)) for candidate in cohort_candidates
    ]
    cohort_rows = [
        row for _candidate, row in cohort_candidate_rows
        if row is not None and row[13]
    ]
    cohort_values = [float(row[11]) for row in cohort_rows]
    percentile_available = len(cohort_values) >= 30
    completed_day = day if _date_bounds(day)[1] <= as_of else day - timedelta(days=1)
    selected_day = conn.execute(
        """SELECT maximum,maximum_ts,qualified,expected_count,observed_count,
                  first_observed_ts,last_observed_ts
           FROM historical_demand_days WHERE market_date=?""",
        (completed_day.isoformat(),),
    ).fetchone()
    all_rank_rows = conn.execute(
        """SELECT market_date,maximum,qualified FROM historical_demand_days
           WHERE market_date<? AND market_date>=?""",
        (completed_day.isoformat(), (completed_day - timedelta(days=364)).isoformat()),
    ).fetchall()
    rank_rows = [row for row in all_rank_rows if row[2] and row[1] is not None]
    rank_available = bool(selected_day and selected_day[2])
    rank_complete = rank_available and len(all_rank_rows) == 364 and len(rank_rows) == 364
    rank = None if not rank_available else 1 + sum(row[1] > selected_day[0] for row in rank_rows)
    raw_start, raw_end = metadata["raw_start"], metadata["raw_end"]
    extrema = {}
    _, completed_end = _date_bounds(completed_day)
    for days in (7, 30, 365):
        start, _ = _date_bounds(completed_day - timedelta(days=days - 1))
        complete = raw_start is not None and raw_start <= start and raw_end is not None and raw_end >= completed_end - CADENCE_SECONDS
        extrema[f"{days}d"] = _extrema(conn, start, completed_end, f"{days}d", complete)
    extrema["since_collection"] = _extrema(conn, raw_start, completed_end, "since_collection", bool(metadata["backfill_complete"]) and raw_end is not None and raw_end >= completed_end - CADENCE_SECONDS)
    summary = {
        "schema": SCHEMA, "policy": POLICY, "methodology": METHODOLOGY,
        "series_key": SERIES_KEY, "unit": "MW", "statistic": "maximum_observed_5m_demand",
        "time_basis": "America/Chicago civil hour; fall 01 combines both folds",
        "as_of": as_of,
        "selected_hour": {
            "market_date": day.isoformat(), "local_hour": hour,
            "start": bounds[0], "end": bounds[1], "occurrence_count": bounds[2],
            "utc_intervals": _intervals(day, hour),
            "coverage": _coverage(selected, 12 * bounds[2]), "value": _hour_value(selected),
        },
        "comparisons": {
            "previous_day": _comparison(conn, day - timedelta(days=1), hour),
            "previous_week": _comparison(conn, day - timedelta(days=7), hour),
            "previous_year": _comparison(conn, _shift_year(day), hour, anniversary=True),
        },
        "seasonal_local_hour_percentiles": {
            "state": "available" if percentile_available else "unavailable",
            "reason": None if percentile_available else "minimum_30_qualified_hours",
            "season": _season(day), "local_hour": hour,
            "lookback_completed_local_dates": 400, "method": "type7",
            "unit": "MW", "qualification_threshold": MIN_COVERAGE,
            "eligible_date_count": len(cohort_candidates),
            "sample_count": len(cohort_values),
            "excluded_date_count": len(cohort_candidates) - len(cohort_values),
            "first_cohort_date": None if not cohort_candidates else cohort_candidates[-1].isoformat(),
            "last_cohort_date": None if not cohort_candidates else cohort_candidates[0].isoformat(),
            "p10": _type7(cohort_values, .1) if percentile_available else None,
            "p50": _type7(cohort_values, .5) if percentile_available else None,
            "p90": _type7(cohort_values, .9) if percentile_available else None,
        },
        "completed_day_peak_rank": {
            "state": ("available" if rank_complete else "partial") if rank_available else "unavailable",
            "reason": (None if rank_complete else "incomplete_or_unqualified_365_day_cohort") if rank_available else "selected_day_insufficient_coverage",
            "market_date": completed_day.isoformat(), "window_days": 365,
            "rank": rank, "denominator": len(rank_rows) + (1 if rank_available else 0),
            "cohort_start_date": (completed_day - timedelta(days=364)).isoformat(),
            "cohort_end_date": completed_day.isoformat(),
            "qualification_threshold": MIN_COVERAGE,
            "unit": "MW",
            "expected_date_count": 365,
            "qualified_prior_count": len(rank_rows),
            "excluded_prior_count": 364 - len(rank_rows),
            "observed_prior_summary_count": len(all_rank_rows),
            "ties": "competition", "peak": None if selected_day is None else {"value": selected_day[0], "timestamp": selected_day[1]},
            "coverage": (
                {"state": "unavailable", "expected_count": 0, "observed_count": 0,
                 "ratio": 0.0, "first_observed_at": None, "last_observed_at": None}
                if selected_day is None else
                {"state": "qualified" if selected_day[2] else ("partial" if selected_day[4] else "unavailable"),
                 "expected_count": selected_day[3], "observed_count": selected_day[4],
                 "ratio": selected_day[4] / selected_day[3] if selected_day[3] else 0.0,
                 "first_observed_at": selected_day[5], "last_observed_at": selected_day[6]}
            ),
        },
        "observed_extrema": extrema,
        "retention": {
            "observed_start": raw_start, "observed_end": raw_end,
            "backfill_complete": bool(metadata["backfill_complete"]),
        },
    }
    return summary


def resolve_historical_context(conn: sqlite3.Connection, as_of: int):
    generation, metadata = ensure_materialized(conn)
    summary = build_summary(conn, as_of, generation, metadata)
    encoded = _canonical_json(summary)
    content_version = "hc1-" + hashlib.sha256(encoded.encode()).hexdigest()
    conn.execute(
        """INSERT OR IGNORE INTO historical_context_resources
           (series_key,methodology,content_version,as_of,generation,payload_json)
           VALUES (?,?,?,?,?,?)""",
        (SERIES_KEY, METHODOLOGY, content_version, as_of, generation, encoded),
    )
    conn.commit()
    state = summary["selected_hour"]["coverage"]["state"]
    return {
        "schema": SCHEMA, "policy": POLICY,
        "state": "available" if state == "qualified" else state,
        "summary": summary,
        "resource": {
            "content_version": content_version,
            "url": f"/api/v2/historical-context/{SERIES_KEY}/{METHODOLOGY}/{content_version}/{as_of}",
        },
    }


def historical_context_resource(conn, content_version: str, as_of: int):
    if CONTENT_VERSION_RE.fullmatch(content_version) is None:
        raise ValueError("invalid_historical_context_content_version")
    row = conn.execute(
        """SELECT payload_json FROM historical_context_resources
           WHERE series_key=? AND methodology=? AND content_version=? AND as_of=?""",
        (SERIES_KEY, METHODOLOGY, content_version, as_of),
    ).fetchone()
    return None if row is None else json.loads(row[0])
