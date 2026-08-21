import hashlib
import json
import math
import re
from datetime import date, datetime, timezone

POLICY = "external_context_not_ercot_operational_authority_or_live_emissions_measurement"
KIND = "external_context"
RESOURCE_KIND = "external_context_resource"
STREAMS = ("eia930_demand", "henry_hub_daily", "epa_egrid")
CONTENT_RE = re.compile(r"^xc1-[0-9a-f]{64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PERIOD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}$")
METRICS = (
    ("co2", "CO₂"), ("ch4", "CH₄"), ("n2o", "N₂O"), ("co2e", "CO₂e"),
    ("annual_nox", "Annual NOₓ"), ("ozone_season_nox", "Ozone Season NOₓ"), ("so2", "SO₂"),
)
SOURCE_IDS = {"eia930_demand": "eia930_erco", "henry_hub_daily": "eia_henry_hub", "epa_egrid": "epa_egrid_erct"}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _exact(value, keys, error):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(error)


def _integer(value, minimum, maximum, error):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(error)
    return value


def _https(value, pattern, error):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(error)
    return value


def _egrid(payload, now):
    _exact(payload, ("schema", "kind", "stream", "publication", "resource"), "invalid_external_context_payload")
    if payload["schema"] != 1 or payload["kind"] != KIND or payload["stream"] != "epa_egrid":
        raise ValueError("invalid_external_context_payload")
    publication = payload["publication"]
    _exact(publication, ("artifact_url", "data_year", "released_on", "revision", "retrieved_at", "source_page_url", "workbook_sha256", "table_title", "production_model", "production_version"), "invalid_external_context_publication")
    year = _integer(publication["data_year"], 2000, 2200, "invalid_external_context_year")
    revision = _integer(publication["revision"], 0, 100, "invalid_external_context_revision")
    released = publication["released_on"]
    if not isinstance(released, str) or not DATE_RE.fullmatch(released):
        raise ValueError("invalid_external_context_release")
    try:
        date.fromisoformat(released)
    except ValueError as exc:
        raise ValueError("invalid_external_context_release") from exc
    retrieved = _integer(publication["retrieved_at"], 1, now + 300, "invalid_external_context_retrieved_at")
    source_page = _https(publication["source_page_url"], r"https://www\.epa\.gov/egrid/summary-data", "invalid_external_context_source_url")
    suffix = f"_rev{revision}" if revision else ""
    artifact = _https(publication["artifact_url"], rf"https://www\.epa\.gov/system/files/documents/\d{{4}}-\d{{2}}/summary_tables{suffix}\.xlsx", "invalid_external_context_artifact_url")
    sha = publication["workbook_sha256"]
    if not isinstance(sha, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", sha):
        raise ValueError("invalid_external_context_sha256")
    expected_title = f"1. Subregion Output Emission Rates (eGRID{year})"
    if publication["table_title"] != expected_title:
        raise ValueError("invalid_external_context_table")
    for key in ("production_model", "production_version"):
        if publication[key] is not None and (not isinstance(publication[key], str) or len(publication[key]) > 500):
            raise ValueError("invalid_external_context_production")
    resource = payload["resource"]
    _exact(resource, ("subregion", "subregion_name", "rates"), "invalid_external_context_resource")
    if resource["subregion"] != "ERCT" or resource["subregion_name"] != "ERCOT All" or not isinstance(resource["rates"], list) or len(resource["rates"]) != 7:
        raise ValueError("invalid_external_context_resource")
    rates = []
    for raw, (metric_id, header) in zip(resource["rates"], METRICS):
        _exact(raw, ("metric_id", "source_header", "value", "unit"), "invalid_external_context_rate")
        value = raw["value"]
        if raw["metric_id"] != metric_id or raw["source_header"] != header or raw["unit"] != "lb_mwh" or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or value > 10_000_000:
            raise ValueError("invalid_external_context_rate")
        rates.append({"metric_id": metric_id, "source_header": header, "value": 0.0 if value == 0 else float(value), "unit": "lb_mwh"})
    immutable_publication = dict(publication)
    resource_out = {"schema": 1, "kind": RESOURCE_KIND, "policy": POLICY, "stream": "epa_egrid", "publication": immutable_publication, "subregion": "ERCT", "subregion_name": "ERCOT All", "rates": rates}
    semantic = dict(resource_out)
    semantic["publication"] = {key: value for key, value in immutable_publication.items() if key != "retrieved_at"}
    version = "xc1-" + hashlib.sha256(_canonical(semantic).encode()).hexdigest()
    return resource_out, version, (year, revision, released), retrieved


def _decimal(value, error):
    if not isinstance(value, str) or not re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?", value):
        raise ValueError(error)
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(error)
    return 0.0 if parsed == 0 else parsed


def _eia930(payload, now):
    error = "invalid_external_context_eia930"
    _exact(payload, ("schema", "kind", "stream", "publication", "resource"), error)
    if payload["schema"] != 1 or payload["kind"] != KIND or payload["stream"] != "eia930_demand":
        raise ValueError(error)
    publication = payload["publication"]
    _exact(publication, ("retrieved_at", "source_url"), error)
    retrieved = _integer(publication["retrieved_at"], 1, now + 300, error)
    source_url = _https(publication["source_url"], r"https://api\.eia\.gov/v2/electricity/rto/region-data/data/", error)
    resource = payload["resource"]
    _exact(resource, ("interval_basis", "rows"), error)
    if resource["interval_basis"] != "hour_ending_utc_half_open" or not isinstance(resource["rows"], list) or len(resource["rows"]) > 146:
        raise ValueError(error)
    rows, identities = [], set()
    for raw in resource["rows"]:
        _exact(raw, ("period", "interval_start", "interval_end", "type", "type_name", "value_decimal", "value_mwh"), error)
        period, kind = raw["period"], raw["type"]
        if not isinstance(period, str) or not PERIOD_RE.fullmatch(period) or kind not in ("D", "TI") or not isinstance(raw["type_name"], str) or not raw["type_name"] or len(raw["type_name"].encode()) > 120:
            raise ValueError(error)
        start = _integer(raw["interval_start"], 1, 4_102_444_800, error)
        end = _integer(raw["interval_end"], 1, 4_102_444_800, error)
        parsed = _decimal(raw["value_decimal"], error)
        numeric = raw["value_mwh"]
        if end - start != 3600 or isinstance(numeric, bool) or not isinstance(numeric, (int, float)) or not math.isfinite(numeric) or numeric != parsed or (kind == "D" and numeric < 0):
            raise ValueError(error)
        identity = (period, kind)
        if identity in identities:
            raise ValueError(error)
        identities.add(identity)
        rows.append({"period": period, "interval_start": start, "interval_end": end, "type": kind, "type_name": raw["type_name"], "value_decimal": raw["value_decimal"], "value_mwh": parsed})
    if rows != sorted(rows, key=lambda row: (row["interval_end"], row["type"])):
        raise ValueError(error)
    output = {"schema": 1, "kind": RESOURCE_KIND, "policy": POLICY, "stream": "eia930_demand", "publication": {"retrieved_at": retrieved, "source_url": source_url}, "interval_basis": "hour_ending_utc_half_open", "rows": rows}
    semantic = dict(output); semantic["publication"] = {"source_url": source_url}
    version = "xc1-" + hashlib.sha256(_canonical(semantic).encode()).hexdigest()
    return output, version, f"eia930:{retrieved}", retrieved


def _henry(payload, now):
    error = "invalid_external_context_henry_hub"
    _exact(payload, ("schema", "kind", "stream", "publication", "resource"), error)
    if payload["schema"] != 1 or payload["kind"] != KIND or payload["stream"] != "henry_hub_daily":
        raise ValueError(error)
    publication = payload["publication"]
    _exact(publication, ("retrieved_at", "series_id", "source_url", "source_page_url", "source_unit"), error)
    retrieved = _integer(publication["retrieved_at"], 1, now + 300, error)
    if publication["series_id"] != "NG.RNGWHHD.D" or publication["source_unit"] != "dollars per million Btu":
        raise ValueError(error)
    source_url = _https(publication["source_url"], r"https://api\.eia\.gov/v2/seriesid/NG\.RNGWHHD\.D", error)
    source_page = _https(publication["source_page_url"], r"https://www\.eia\.gov/dnav/ng/hist/rngwhhdd\.htm", error)
    resource = payload["resource"]
    _exact(resource, ("unit", "date_basis", "rows"), error)
    if resource["unit"] != "usd_per_mmbtu" or resource["date_basis"] != "source_market_date_no_timezone" or not isinstance(resource["rows"], list) or len(resource["rows"]) > 25:
        raise ValueError(error)
    rows, dates = [], set()
    for raw in resource["rows"]:
        _exact(raw, ("market_date", "value_decimal", "price"), error)
        market_date = raw["market_date"]
        if not isinstance(market_date, str) or not DATE_RE.fullmatch(market_date) or market_date in dates:
            raise ValueError(error)
        try: date.fromisoformat(market_date)
        except ValueError as exc: raise ValueError(error) from exc
        parsed = _decimal(raw["value_decimal"], error)
        if isinstance(raw["price"], bool) or not isinstance(raw["price"], (int, float)) or not math.isfinite(raw["price"]) or raw["price"] != parsed:
            raise ValueError(error)
        dates.add(market_date); rows.append({"market_date": market_date, "value_decimal": raw["value_decimal"], "price": parsed})
    if rows != sorted(rows, key=lambda row: row["market_date"]): raise ValueError(error)
    publication_out = {"retrieved_at": retrieved, "series_id": "NG.RNGWHHD.D", "source_url": source_url, "source_page_url": source_page, "source_unit": "dollars per million Btu"}
    output = {"schema": 1, "kind": RESOURCE_KIND, "policy": POLICY, "stream": "henry_hub_daily", "publication": publication_out, "unit": "usd_per_mmbtu", "date_basis": "source_market_date_no_timezone", "rows": rows}
    semantic = dict(output); semantic["publication"] = {key: value for key, value in publication_out.items() if key != "retrieved_at"}
    version = "xc1-" + hashlib.sha256(_canonical(semantic).encode()).hexdigest()
    return output, version, f"henry:{retrieved}", retrieved


def init_external_context_schema(conn):
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS external_context_resources(
        stream TEXT NOT NULL, identity TEXT NOT NULL, content_version TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL, retrieved_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        retired_at INTEGER, PRIMARY KEY(content_version));
      CREATE TABLE IF NOT EXISTS external_context_current(
        stream TEXT PRIMARY KEY, identity TEXT NOT NULL, content_version TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS external_context_health(
        stream TEXT PRIMARY KEY, last_attempt_ts INTEGER, last_success_ts INTEGER,
        source_updated_at INTEGER, retrieved_at INTEGER, content_version TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        materialization_state TEXT NOT NULL DEFAULT 'unavailable', materialization_last_success_ts INTEGER,
        materialization_consecutive_failures INTEGER NOT NULL DEFAULT 0, materialization_last_error TEXT);
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS external_context_resources_stream_identity ON external_context_resources(stream,identity)")
    conn.commit()


def ingest_external_context(conn, payload, now):
    if not isinstance(payload, dict) or payload.get("stream") not in STREAMS:
        raise ValueError("invalid_external_context_payload")
    if payload["stream"] == "eia930_demand":
        return _ingest_snapshot(conn, payload, now, _eia930)
    if payload["stream"] == "henry_hub_daily":
        return _ingest_snapshot(conn, payload, now, _henry)
    resource, version, ordering, retrieved = _egrid(payload, now)
    identity = f"egrid:{ordering[0]}:{ordering[1]}:ERCT"
    encoded = _canonical(resource)
    existing = conn.execute("SELECT content_version,payload_json FROM external_context_resources WHERE stream='epa_egrid' AND identity=?", (identity,)).fetchone()
    if existing:
        if existing[0] != version:
            raise ValueError("external_context_same_identity_collision")
        _success(conn, "epa_egrid", None, retrieved, existing[0], now)
        conn.commit()
        return {"schema": 1, "stream": "epa_egrid", "status": "unchanged", "content_version": existing[0]}
    current = conn.execute("SELECT identity,content_version FROM external_context_current WHERE stream='epa_egrid'").fetchone()
    current_order = None
    if current:
        parts = current[0].split(":")
        current_order = (int(parts[1]), int(parts[2]))
    status = "inserted"
    conn.execute("SAVEPOINT external_context_ingest")
    try:
        conn.execute("INSERT INTO external_context_resources VALUES(?,?,?,?,?,?,NULL)", ("epa_egrid", identity, version, encoded, retrieved, now))
        if current_order is None or ordering[:2] > current_order:
            if current:
                conn.execute("UPDATE external_context_resources SET retired_at=COALESCE(retired_at,?) WHERE content_version=?", (now, current[1]))
            conn.execute("INSERT INTO external_context_current VALUES(?,?,?,?) ON CONFLICT(stream) DO UPDATE SET identity=excluded.identity,content_version=excluded.content_version,updated_at=excluded.updated_at", ("epa_egrid", identity, version, now))
        else:
            status = "ignored_older"
        _success(conn, "epa_egrid", None, retrieved, version, now)
        prune_external_context(conn, now)
        conn.execute("RELEASE SAVEPOINT external_context_ingest")
        conn.commit()
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT external_context_ingest")
        conn.execute("RELEASE SAVEPOINT external_context_ingest")
        raise
    return {"schema": 1, "stream": "epa_egrid", "status": status, "content_version": version}


def _ingest_snapshot(conn, payload, now, parser):
    stream = payload["stream"]
    resource, version, identity, retrieved = parser(payload, now)
    encoded = _canonical(resource)
    current = conn.execute("SELECT r.retrieved_at,c.content_version FROM external_context_current c JOIN external_context_resources r ON r.content_version=c.content_version WHERE c.stream=?", (stream,)).fetchone()
    existing = conn.execute("SELECT payload_json,retrieved_at FROM external_context_resources WHERE content_version=?", (version,)).fetchone()
    if existing:
        if existing[0] != encoded and existing[1] == retrieved:
            raise ValueError("external_context_same_clock_collision")
        _success(conn, stream, resource["rows"][-1].get("interval_end") if stream == "eia930_demand" and resource["rows"] else None, retrieved, version, now)
        conn.commit(); return {"schema": 1, "stream": stream, "status": "unchanged", "content_version": version}
    if current and retrieved < current[0]:
        return {"schema": 1, "stream": stream, "status": "ignored_older", "content_version": current[1]}
    if current and retrieved == current[0]:
        raise ValueError("external_context_same_clock_collision")
    conn.execute("SAVEPOINT external_context_snapshot")
    try:
        conn.execute("INSERT INTO external_context_resources VALUES(?,?,?,?,?,?,NULL)", (stream, identity, version, encoded, retrieved, now))
        if current: conn.execute("UPDATE external_context_resources SET retired_at=COALESCE(retired_at,?) WHERE content_version=?", (now, current[1]))
        conn.execute("INSERT INTO external_context_current VALUES(?,?,?,?) ON CONFLICT(stream) DO UPDATE SET identity=excluded.identity,content_version=excluded.content_version,updated_at=excluded.updated_at", (stream, identity, version, now))
        latest = resource["rows"][-1].get("interval_end") if stream == "eia930_demand" and resource["rows"] else None
        _success(conn, stream, latest, retrieved, version, now)
        prune_external_context(conn, now)
        conn.execute("RELEASE SAVEPOINT external_context_snapshot"); conn.commit()
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT external_context_snapshot"); conn.execute("RELEASE SAVEPOINT external_context_snapshot"); raise
    return {"schema": 1, "stream": stream, "status": "inserted", "content_version": version}


def _success(conn, stream, source_updated_at, retrieved_at, version, now):
    conn.execute("""INSERT INTO external_context_health VALUES(?,?,?,?,?,?,0,NULL,'healthy',?,0,NULL)
      ON CONFLICT(stream) DO UPDATE SET last_attempt_ts=excluded.last_attempt_ts,last_success_ts=excluded.last_success_ts,
      source_updated_at=excluded.source_updated_at,retrieved_at=excluded.retrieved_at,content_version=excluded.content_version,
      consecutive_failures=0,last_error=NULL,materialization_state='healthy',materialization_last_success_ts=excluded.materialization_last_success_ts,
      materialization_consecutive_failures=0,materialization_last_error=NULL""", (stream, now, now, source_updated_at, retrieved_at, version, now))


def record_external_context_failure(conn, stream, reason, attempted_at):
    if stream not in STREAMS:
        raise ValueError("invalid_external_context_stream")
    conn.execute("INSERT OR IGNORE INTO external_context_health(stream) VALUES(?)", (stream,))
    row = conn.execute("SELECT last_attempt_ts,last_success_ts FROM external_context_health WHERE stream=?", (stream,)).fetchone()
    newest = max((value for value in row if value is not None), default=None)
    if newest is not None and attempted_at < newest:
        conn.commit(); return "ignored_older"
    if newest is not None and attempted_at == newest:
        conn.commit(); return "unchanged"
    error = str(reason)[:200]
    conn.execute("UPDATE external_context_health SET last_attempt_ts=?,consecutive_failures=consecutive_failures+1,last_error=?,materialization_state='failed',materialization_consecutive_failures=materialization_consecutive_failures+1,materialization_last_error=? WHERE stream=?", (attempted_at, error, error, stream))
    conn.commit(); return "recorded"


def prune_external_context(conn, now):
    """Keep advertised immutable bytes for at least one year; eGRID for ten."""
    for stream in STREAMS:
        cutoff = now - (10 if stream == "epa_egrid" else 1) * 365 * 86_400
        keep = 5 if stream == "epa_egrid" else 14
        rows = conn.execute("SELECT content_version,retired_at FROM external_context_resources WHERE stream=? ORDER BY created_at DESC,content_version DESC", (stream,)).fetchall()
        for index, (version, retired_at) in enumerate(rows):
            if index >= keep and retired_at is not None and retired_at <= cutoff:
                conn.execute("DELETE FROM external_context_resources WHERE content_version=?", (version,))


def external_context_resource(conn, stream, version):
    if stream not in STREAMS or not isinstance(version, str) or not CONTENT_RE.fullmatch(version):
        raise ValueError("invalid_external_context_resource_key")
    row = conn.execute("SELECT payload_json FROM external_context_resources WHERE stream=? AND content_version=?", (stream, version)).fetchone()
    return None if row is None else json.loads(row[0])


def _health(conn, stream, available):
    row = conn.execute("SELECT last_attempt_ts,last_success_ts,source_updated_at,retrieved_at,content_version,consecutive_failures,last_error,materialization_state,materialization_last_success_ts,materialization_consecutive_failures,materialization_last_error FROM external_context_health WHERE stream=?", (stream,)).fetchone()
    if row is None:
        state = "disabled" if stream != "epa_egrid" else "unavailable"
        availability = "disabled" if stream != "epa_egrid" else "unavailable"
        row = (None, None, None, None, None, 0, None, "unavailable", None, 0, None)
    else:
        state = "failed" if row[5] else ("healthy" if available else "unavailable")
        availability = "available" if available else "unavailable"
    return {"source_id": SOURCE_IDS[stream], "state": state, "availability_status": availability, "content_version": row[4], "last_attempt_ts": row[0], "last_success_ts": row[1], "source_updated_at": row[2], "retrieved_at": row[3], "cache_fresh_until": None, "consecutive_failures": row[5], "last_error": row[6], "materialization": {"state": row[7], "last_success_ts": row[8], "consecutive_failures": row[9], "last_error": row[10]}}


def external_context_manifest(conn, now):
    row = conn.execute("SELECT r.content_version,r.payload_json,r.retrieved_at FROM external_context_current c JOIN external_context_resources r ON r.content_version=c.content_version WHERE c.stream='epa_egrid'").fetchone()
    egrid = {"state": "unavailable", "reason": "source_not_collected", "freshness": None, "selected": None}
    if row:
        resource = json.loads(row[1]); publication = resource["publication"]
        egrid = {"state": "available", "reason": None, "freshness": "not_applicable", "selected": {"content_version": row[0], "url": f"/api/v2/external-context/epa_egrid/v1/{row[0]}", "data_year": publication["data_year"], "revision": publication["revision"], "released_on": publication["released_on"], "retrieved_at": row[2], "subregion": "ERCT", "subregion_name": "ERCOT All", "source_page_url": publication["source_page_url"], "artifact_url": publication["artifact_url"]}}
    elif (failure := conn.execute("SELECT consecutive_failures,last_error FROM external_context_health WHERE stream='epa_egrid'").fetchone()) and failure[0]:
        egrid = {"state": "failed", "reason": failure[1], "freshness": None, "selected": None}
    def snapshot_section(stream):
        current = conn.execute("SELECT r.content_version,r.payload_json,r.retrieved_at FROM external_context_current c JOIN external_context_resources r ON r.content_version=c.content_version WHERE c.stream=?", (stream,)).fetchone()
        if current:
            resource = json.loads(current[1]); rows = resource["rows"]
            if stream == "eia930_demand":
                demand = [item["interval_end"] for item in rows if item["type"] == "D"]
                interchange = [item["interval_end"] for item in rows if item["type"] == "TI"]
                selected = {"content_version": current[0], "url": f"/api/v2/external-context/{stream}/v1/{current[0]}", "retrieved_at": current[2], "latest_demand_interval_end": max(demand) if demand else None, "latest_interchange_interval_end": max(interchange) if interchange else None, "source_url": resource["publication"]["source_url"]}
                stale = (not demand or now - max(demand) > 3 * 3600) or (not interchange or now - max(interchange) > 60 * 3600)
            else:
                selected = {"content_version": current[0], "url": f"/api/v2/external-context/{stream}/v1/{current[0]}", "retrieved_at": current[2], "latest_market_date": rows[-1]["market_date"] if rows else None, "source_url": resource["publication"]["source_url"]}
                stale = not rows or (datetime.fromtimestamp(now, timezone.utc).date() - date.fromisoformat(rows[-1]["market_date"])).days > 7
            return {"state": "available", "reason": None, "freshness": "stale" if stale else "fresh", "selected": selected}
        failure = conn.execute("SELECT consecutive_failures,last_error FROM external_context_health WHERE stream=?", (stream,)).fetchone()
        return {"state": "failed", "reason": failure[1], "freshness": None, "selected": None} if failure and failure[0] else {"state": "disabled", "reason": "eia_api_key_not_configured", "freshness": None, "selected": None}
    eia = snapshot_section("eia930_demand"); gas = snapshot_section("henry_hub_daily")
    health = [_health(conn, stream, external_context_resource(conn, stream, conn.execute("SELECT content_version FROM external_context_current WHERE stream=?", (stream,)).fetchone()[0]) is not None if conn.execute("SELECT content_version FROM external_context_current WHERE stream=?", (stream,)).fetchone() else False) for stream in STREAMS]
    return {"schema": 1, "kind": KIND, "policy": POLICY, "generated_at": now, "eia_930": eia, "natural_gas": gas, "epa_egrid": egrid, "epa_camd": {"state": "unavailable", "reason": "ercot_footprint_and_coverage_methodology_not_frozen"}, "source_health": health}
