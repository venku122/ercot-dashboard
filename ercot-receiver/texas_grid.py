import hashlib
import json
import math
import re

POLICY = "official_planning_snapshots_not_committed_capacity_or_realization_forecast"
KIND = "texas_grid_long_horizon"
VERSION = 1
CONTENT_RE = re.compile(r"^tg1-[0-9a-f]{64}$")
MONTH_RE = re.compile(r"^(19|20|21|22)\d\d-(0[1-9]|1[0-2])$")
PHASES = (
    "ss_started_fis_not_started_no_ia", "ss_started_fis_started_no_ia",
    "ss_completed_fis_not_started_no_ia", "ss_completed_fis_started_no_ia",
    "ss_completed_fis_completed_no_ia", "ss_started_fis_not_started_ia",
    "ss_started_fis_started_ia", "ss_completed_fis_not_started_ia",
    "ss_completed_fis_started_ia", "ss_completed_fis_completed_ia", "small_generator",
)
PHASE_LABELS = (
    "SS Started, FIS Not Started, No IA", "SS Started, FIS Started, No IA",
    "SS Completed, FIS Not Started, No IA", "SS Completed, FIS Started, No IA",
    "SS Completed, FIS Completed, No IA", "SS Started, FIS Not Started, IA",
    "SS Started, FIS Started, IA", "SS Completed, FIS Not Started, IA",
    "SS Completed, FIS Started, IA", "SS Completed, FIS Completed, IA", "Small Generator",
)
FUELS = (
    "biomass", "coal", "gas", "geothermal", "hydrogen", "nuclear",
    "fuel_oil", "other", "petcoke", "solar", "water", "wind",
)
FUEL_CODES = ("BIO", "COA", "GAS", "GEO", "HYD", "NUC", "OIL", "OTH", "PET", "SOL", "WAT", "WIN")
FUEL_LABELS = ("Biomass", "Coal", "Gas", "Geothermal", "Hydrogen", "Nuclear", "Fuel Oil", "Other", "Petcoke", "Solar", "Water", "Wind")
SERIES = ("wind", "solar", "battery", "gas_combined_cycle", "gas_other")
SERIES_LABELS = ("Wind", "Solar", "Battery", "Gas - Combined Cycle", "Gas - Other")
STREAMS = ("gis", "resource_capacity_trend", "long_term_load_forecast")
SOURCE_IDS = {
    "gis": "ercot_gis_report",
    "resource_capacity_trend": "ercot_resource_capacity_trend",
    "long_term_load_forecast": "ercot_long_term_load_forecast",
}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _exact(value, keys, error):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(error)


def _integer(value, minimum, maximum, error):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(error)
    return value


def _number(value, nullable=False, signed=False, maximum=10_000_000):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("invalid_texas_grid_number")
    if abs(value) > maximum or (not signed and value < 0):
        raise ValueError("invalid_texas_grid_number")
    return 0.0 if value == 0 else float(value)


def _source_url(value):
    if not isinstance(value, str) or not re.fullmatch(r"https://www\.ercot\.com/[^#]+", value):
        raise ValueError("invalid_texas_grid_source_url")
    return value


def _publication(value, stream, now):
    _exact(value, ("source_period", "published_at", "retrieved_at", "source_page_url", "workbooks"), "invalid_texas_grid_publication")
    period = value["source_period"]
    if not isinstance(period, str) or not MONTH_RE.fullmatch(period):
        raise ValueError("invalid_texas_grid_source_period")
    published = _integer(value["published_at"], 1, 4_102_444_800, "invalid_texas_grid_published_at")
    retrieved = _integer(value["retrieved_at"], published, now + 300, "invalid_texas_grid_retrieved_at")
    page = _source_url(value["source_page_url"])
    expected_page = {
        "gis": "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er",
        "resource_capacity_trend": "https://www.ercot.com/gridinfo/resource",
        "long_term_load_forecast": "https://www.ercot.com/gridinfo/load/forecast/index.html",
    }[stream]
    if page != expected_page:
        raise ValueError("invalid_texas_grid_source_url")
    expected_kinds = {
        "gis": ("gis",),
        "resource_capacity_trend": ("annual", "planned_monthly"),
        "long_term_load_forecast": ("monthly_forecast", "methodology_report"),
    }[stream]
    workbooks = value["workbooks"]
    if not isinstance(workbooks, list) or len(workbooks) != len(expected_kinds):
        raise ValueError("invalid_texas_grid_workbooks")
    normalized = []
    trend_url_parts = []
    month_names = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    for workbook, expected in zip(workbooks, expected_kinds):
        _exact(workbook, ("kind", "source_url", "sha256"), "invalid_texas_grid_workbook")
        if workbook["kind"] != expected or not isinstance(workbook["sha256"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", workbook["sha256"]):
            raise ValueError("invalid_texas_grid_workbook")
        source = workbook["source_url"]
        if source is not None:
            source = _source_url(source)
        if stream == "gis" and source is not None:
            raise ValueError("invalid_texas_grid_workbook")
        if stream == "resource_capacity_trend":
            suffix = "_PlannedMonthly" if expected == "planned_monthly" else ""
            match = re.fullmatch(
                rf"https://www\.ercot\.com/files/docs/(\d{{4}}/\d{{2}}/\d{{2}})/Capacity-Changes-by-Fuel-Type-Charts_([A-Z][a-z]+)_(\d{{4}}){suffix}\.xlsx",
                source or "",
            )
            if not match:
                raise ValueError("invalid_texas_grid_workbook")
            try:
                workbook_period = f"{int(match[3]):04d}-{month_names.index(match[2]) + 1:02d}"
            except ValueError as exc:
                raise ValueError("invalid_texas_grid_workbook") from exc
            if workbook_period != period:
                raise ValueError("invalid_texas_grid_workbook")
            trend_url_parts.append(match[1])
        if stream == "long_term_load_forecast":
            expected_url = {
                "monthly_forecast": "https://www.ercot.com/files/docs/2025/04/08/2025-ERCOT-Monthly-Peak-Demand-and-Energy-Forecast.xlsx",
                "methodology_report": "https://www.ercot.com/files/docs/2025/04/08/2025_LTLF_Report.docx",
            }[expected]
            if source != expected_url or period != "2025-04":
                raise ValueError("invalid_texas_grid_workbook")
        normalized.append({"kind": expected, "source_url": source, "sha256": workbook["sha256"]})
    if stream == "resource_capacity_trend" and len(set(trend_url_parts)) != 1:
        raise ValueError("invalid_texas_grid_workbook")
    return {"source_period": period, "published_at": published, "retrieved_at": retrieved, "source_page_url": page, "workbooks": normalized}


def _gis_resource(value):
    _exact(value, ("unit", "statistic", "phases", "fuels", "aggregates", "limits"), "invalid_texas_grid_gis")
    phases = [{"id": key, "label": label} for key, label in zip(PHASES, PHASE_LABELS)]
    fuels = [{"code": code, "label": label} for code, label in zip(FUEL_CODES, FUEL_LABELS)]
    if value["unit"] != "MW" or value["statistic"] != "project_count_and_source_capacity_sum" or value["phases"] != phases or value["fuels"] != fuels or value["limits"] != {"max_aggregates": 132}:
        raise ValueError("invalid_texas_grid_gis")
    rows = value["aggregates"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 132:
        raise ValueError("invalid_texas_grid_gis")
    normalized, seen = [], set()
    for row in rows:
        _exact(row, ("phase", "fuel", "count", "capacity_mw"), "invalid_texas_grid_gis_row")
        key = (row["phase"], row["fuel"])
        if key[0] not in PHASES or key[1] not in FUELS or key in seen:
            raise ValueError("invalid_texas_grid_gis_row")
        seen.add(key)
        normalized.append({"phase": key[0], "fuel": key[1], "count": _integer(row["count"], 0, 10_000, "invalid_texas_grid_gis_count"), "capacity_mw": _number(row["capacity_mw"], signed=True)})
    phase_order = {key: index for index, key in enumerate(PHASES)}
    fuel_order = {key: index for index, key in enumerate(FUELS)}
    normalized.sort(key=lambda row: (phase_order[row["phase"]], fuel_order[row["fuel"]]))
    return {"unit": "MW", "statistic": value["statistic"], "phases": phases, "fuels": fuels, "aggregates": normalized, "limits": {"max_aggregates": 132}}


def _capacity_row(row, monthly):
    period_key = "month" if monthly else "year"
    keys = (period_key, "official_total_mw", "operational_mw", "ia_financial_security_posted_mw", "ia_no_financial_security_mw", "other_planned_mw", "small_generator_mw")
    _exact(row, keys, "invalid_texas_grid_capacity_row")
    period = row[period_key]
    if monthly:
        if not isinstance(period, str) or not MONTH_RE.fullmatch(period):
            raise ValueError("invalid_texas_grid_capacity_period")
    else:
        period = _integer(period, 1900, 2200, "invalid_texas_grid_capacity_period")
    normalized = {period_key: period}
    for key in keys[1:]:
        normalized[key] = _number(row[key], nullable=(key == "other_planned_mw"))
    components = sum(normalized[key] or 0 for key in keys[2:])
    if abs(normalized["official_total_mw"] - components) > 1e-6:
        raise ValueError("invalid_texas_grid_capacity_rollup")
    return normalized


def _trend_resource(value):
    _exact(value, ("unit", "series", "limits"), "invalid_texas_grid_trend")
    limits = {"max_annual_rows_per_series": 100, "max_planned_monthly_rows_per_series": 120}
    if value["unit"] != "MW" or value["limits"] != limits or not isinstance(value["series"], list) or len(value["series"]) != 5:
        raise ValueError("invalid_texas_grid_trend")
    normalized = []
    for item, expected, label in zip(value["series"], SERIES, SERIES_LABELS):
        _exact(item, ("series_id", "label", "annual", "planned_monthly"), "invalid_texas_grid_series")
        if item["series_id"] != expected or item["label"] != label or not isinstance(item["annual"], list) or not isinstance(item["planned_monthly"], list) or not 1 <= len(item["annual"]) <= 100 or not 1 <= len(item["planned_monthly"]) <= 120:
            raise ValueError("invalid_texas_grid_series")
        annual = [_capacity_row(row, False) for row in item["annual"]]
        monthly = [_capacity_row(row, True) for row in item["planned_monthly"]]
        if [row["year"] for row in annual] != sorted(set(row["year"] for row in annual)) or [row["month"] for row in monthly] != sorted(set(row["month"] for row in monthly)):
            raise ValueError("invalid_texas_grid_capacity_order")
        normalized.append({"series_id": expected, "label": label, "annual": annual, "planned_monthly": monthly})
    return {"unit": "MW", "series": normalized, "limits": limits}


def _ltlf_resource(value):
    _exact(
        value,
        (
            "publication_status", "time_basis", "units", "unit_binding", "scenarios",
            "large_load_methodology", "limits",
        ),
        "invalid_texas_grid_ltlf",
    )
    if (
        value["publication_status"] != "official_published"
        or value["time_basis"] != "calendar_month"
        or value["units"] != {"monthly_peak": "MW", "monthly_energy": "MWh"}
        or value["unit_binding"] != "official_report_appendix_a_mw_twh_monthly_sum_v1"
        or value["limits"] != {"max_rows_per_scenario": 240}
    ):
        raise ValueError("invalid_texas_grid_ltlf")
    methodology = value["large_load_methodology"]
    _exact(
        methodology,
        ("scope", "tsp_provided", "ercot_adjusted", "current_process"),
        "invalid_texas_grid_ltlf_methodology",
    )
    expected_methodology = {
        "scope": "forecast_assumptions_not_project_status",
        "tsp_provided": "contracts_and_officer_letter_tsp_ramp_schedules",
        "ercot_adjusted": "tsp_forecast_with_documented_timing_and_realization_adjustments",
        "current_process": "batch_zero_documents_published_no_public_project_status_dataset",
    }
    if methodology != expected_methodology:
        raise ValueError("invalid_texas_grid_ltlf_methodology")
    scenarios = value["scenarios"]
    expected = (
        ("ercot_adjusted", "ERCOT Adjusted Forecast"),
        ("tsp_provided", "TSP Provided Forecast"),
    )
    if not isinstance(scenarios, list) or len(scenarios) != 2:
        raise ValueError("invalid_texas_grid_ltlf")
    normalized = []
    for scenario, (scenario_id, label) in zip(scenarios, expected):
        _exact(scenario, ("scenario_id", "label", "rows"), "invalid_texas_grid_ltlf_scenario")
        rows = scenario["rows"]
        if scenario["scenario_id"] != scenario_id or scenario["label"] != label or not isinstance(rows, list) or len(rows) != 240:
            raise ValueError("invalid_texas_grid_ltlf_scenario")
        parsed, previous = [], ""
        for row in rows:
            _exact(row, ("month", "monthly_peak_mw", "monthly_energy_mwh"), "invalid_texas_grid_ltlf_row")
            month = row["month"]
            if not isinstance(month, str) or not MONTH_RE.fullmatch(month) or month <= previous:
                raise ValueError("invalid_texas_grid_ltlf_row")
            previous = month
            parsed.append({
                "month": month,
                "monthly_peak_mw": _number(row["monthly_peak_mw"]),
                "monthly_energy_mwh": _number(row["monthly_energy_mwh"], maximum=1_000_000_000),
            })
        normalized.append({"scenario_id": scenario_id, "label": label, "rows": parsed})
    return {
        "publication_status": "official_published",
        "time_basis": "calendar_month",
        "units": {"monthly_peak": "MW", "monthly_energy": "MWh"},
        "unit_binding": value["unit_binding"],
        "scenarios": normalized,
        "large_load_methodology": expected_methodology,
        "limits": {"max_rows_per_scenario": 240},
    }


def init_texas_grid_schema(conn):
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS texas_grid_resources(
        stream TEXT NOT NULL, source_period TEXT NOT NULL, published_at INTEGER NOT NULL,
        retrieved_at INTEGER NOT NULL, content_version TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER,
        PRIMARY KEY(stream,source_period,published_at,retrieved_at)
      );
      CREATE TABLE IF NOT EXISTS texas_grid_current(
        stream TEXT PRIMARY KEY, source_period TEXT NOT NULL, published_at INTEGER NOT NULL,
        content_version TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_texas_grid_retention
        ON texas_grid_resources(stream,source_period,created_at);
      CREATE TABLE IF NOT EXISTS texas_grid_health(
        stream TEXT PRIMARY KEY, last_attempt_ts INTEGER, last_success_ts INTEGER,
        source_updated_at INTEGER, retrieved_at INTEGER, content_version TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        materialization_state TEXT NOT NULL DEFAULT 'unavailable',
        materialization_last_success_ts INTEGER,
        materialization_consecutive_failures INTEGER NOT NULL DEFAULT 0,
        materialization_last_error TEXT
      );
    """)
    conn.commit()


def ingest_texas_grid(conn, payload, current_ts):
    _exact(payload, ("schema", "kind", "stream", "publication", "resource"), "invalid_texas_grid_payload")
    if payload["schema"] != 1 or payload["kind"] != KIND or payload["stream"] not in STREAMS:
        raise ValueError("invalid_texas_grid_payload")
    stream = payload["stream"]
    publication = _publication(payload["publication"], stream, current_ts)
    body = (
        _gis_resource(payload["resource"])
        if stream == "gis"
        else _trend_resource(payload["resource"])
        if stream == "resource_capacity_trend"
        else _ltlf_resource(payload["resource"])
    )
    workbooks = publication.pop("workbooks")
    if stream == "gis":
        immutable_publication = {**publication, "workbook_sha256": workbooks[0]["sha256"]}
    elif stream == "resource_capacity_trend":
        immutable_publication = {
            **publication,
            "annual_workbook_url": workbooks[0]["source_url"],
            "annual_workbook_sha256": workbooks[0]["sha256"],
            "planned_monthly_workbook_url": workbooks[1]["source_url"],
            "planned_monthly_workbook_sha256": workbooks[1]["sha256"],
        }
    else:
        immutable_publication = {
            **publication,
            "monthly_forecast_url": workbooks[0]["source_url"],
            "monthly_forecast_sha256": workbooks[0]["sha256"],
            "methodology_report_url": workbooks[1]["source_url"],
            "methodology_report_sha256": workbooks[1]["sha256"],
        }
    resource = {"schema": 1, "kind": KIND, "policy": POLICY, "stream": stream, "publication": immutable_publication, **body}
    encoded = _canonical(resource)
    version = "tg1-" + hashlib.sha256(encoded.encode()).hexdigest()
    conn.execute("SAVEPOINT texas_grid_ingest")
    try:
        existing = conn.execute("SELECT content_version FROM texas_grid_resources WHERE stream=? AND source_period=? AND published_at=? AND retrieved_at=?", (stream, publication["source_period"], publication["published_at"], publication["retrieved_at"])).fetchone()
        if existing:
            if existing[0] != version:
                raise ValueError("texas_grid_same_clock_collision")
            _record_success(conn, stream, publication, version, current_ts)
            conn.execute("RELEASE SAVEPOINT texas_grid_ingest")
            conn.commit()
            return {"schema": 1, "stream": stream, "status": "unchanged", "content_version": version}
        conn.execute("INSERT INTO texas_grid_resources VALUES(?,?,?,?,?,?,?,NULL)", (stream, publication["source_period"], publication["published_at"], publication["retrieved_at"], version, encoded, current_ts))
        current = conn.execute("SELECT c.source_period,c.published_at,r.retrieved_at,c.content_version FROM texas_grid_current c JOIN texas_grid_resources r ON r.content_version=c.content_version WHERE c.stream=?", (stream,)).fetchone()
        status = "inserted"
        if current is None or (publication["published_at"], publication["retrieved_at"]) > (current[1], current[2]):
            if current is not None:
                conn.execute("UPDATE texas_grid_resources SET retired_at=COALESCE(retired_at,?) WHERE content_version=?", (current_ts, current[3]))
            conn.execute("INSERT INTO texas_grid_current VALUES(?,?,?,?,?) ON CONFLICT(stream) DO UPDATE SET source_period=excluded.source_period,published_at=excluded.published_at,content_version=excluded.content_version,updated_at=excluded.updated_at", (stream, publication["source_period"], publication["published_at"], version, current_ts))
        else:
            status = "ignored_older"
        _record_success(conn, stream, publication, version, current_ts)
        prune_texas_grid(conn, current_ts)
        conn.execute("RELEASE SAVEPOINT texas_grid_ingest")
        conn.commit()
        return {"schema": 1, "stream": stream, "status": status, "content_version": version}
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT texas_grid_ingest")
        conn.execute("RELEASE SAVEPOINT texas_grid_ingest")
        raise


def _record_success(conn, stream, publication, version, now):
    conn.execute(
        """INSERT INTO texas_grid_health VALUES(?,?,?,?,?,?,0,NULL,'healthy',?,0,NULL)
           ON CONFLICT(stream) DO UPDATE SET last_attempt_ts=excluded.last_attempt_ts,
           last_success_ts=excluded.last_success_ts,source_updated_at=excluded.source_updated_at,
           retrieved_at=excluded.retrieved_at,content_version=excluded.content_version,
           consecutive_failures=0,last_error=NULL,materialization_state='healthy',
           materialization_last_success_ts=excluded.materialization_last_success_ts,
           materialization_consecutive_failures=0,materialization_last_error=NULL""",
        (stream, now, now, publication["published_at"], publication["retrieved_at"], version, now),
    )


def record_texas_grid_failure(conn, stream, error, now, materialization=False):
    if stream not in STREAMS:
        return "ignored_older"
    message = str(error)[:500]
    conn.execute("INSERT OR IGNORE INTO texas_grid_health(stream) VALUES(?)", (stream,))
    existing = conn.execute("SELECT last_attempt_ts,last_success_ts,last_error FROM texas_grid_health WHERE stream=?", (stream,)).fetchone()
    newest = max(value for value in existing[:2] if value is not None) if any(value is not None for value in existing[:2]) else None
    if newest is not None and now < newest:
        conn.commit()
        return "ignored_older"
    if newest is not None and now == newest:
        conn.commit()
        return "unchanged"
    if materialization:
        conn.execute("UPDATE texas_grid_health SET last_attempt_ts=?,consecutive_failures=consecutive_failures+1,last_error=?,materialization_state='failed',materialization_consecutive_failures=materialization_consecutive_failures+1,materialization_last_error=? WHERE stream=?", (now, message, message, stream))
    else:
        conn.execute("UPDATE texas_grid_health SET last_attempt_ts=?,consecutive_failures=consecutive_failures+1,last_error=? WHERE stream=?", (now, message, stream))
    conn.commit()
    return "recorded"


def prune_texas_grid(conn, now):
    cutoff = now - 365 * 86_400
    for stream in STREAMS:
        periods = [row[0] for row in conn.execute("SELECT DISTINCT source_period FROM texas_grid_resources WHERE stream=? ORDER BY source_period DESC", (stream,))]
        keep_periods = set(periods[:120])
        rows = conn.execute("SELECT content_version,source_period,published_at,retrieved_at,retired_at FROM texas_grid_resources WHERE stream=? ORDER BY source_period DESC,published_at DESC,retrieved_at DESC", (stream,)).fetchall()
        ranks = {}
        for version, period, _published, _retrieved, retired in rows:
            ranks[period] = ranks.get(period, 0) + 1
            if retired is not None and retired <= cutoff and (period not in keep_periods or ranks[period] > 4):
                conn.execute("DELETE FROM texas_grid_resources WHERE content_version=?", (version,))


def texas_grid_resource(conn, stream, content_version):
    if stream not in STREAMS or not isinstance(content_version, str) or not CONTENT_RE.fullmatch(content_version):
        raise ValueError("invalid_texas_grid_resource_key")
    row = conn.execute("SELECT payload_json FROM texas_grid_resources WHERE stream=? AND content_version=?", (stream, content_version)).fetchone()
    return None if row is None else json.loads(row[0])


def texas_grid_manifest(conn, now):
    selected = {}
    health = []
    for stream in STREAMS:
        row = conn.execute("SELECT c.source_period,c.published_at,c.content_version,r.retrieved_at,r.payload_json FROM texas_grid_current c JOIN texas_grid_resources r ON r.content_version=c.content_version WHERE c.stream=?", (stream,)).fetchone()
        health_row = conn.execute("SELECT last_attempt_ts,last_success_ts,source_updated_at,retrieved_at,content_version,consecutive_failures,last_error,materialization_state,materialization_last_success_ts,materialization_consecutive_failures,materialization_last_error FROM texas_grid_health WHERE stream=?", (stream,)).fetchone()
        if row is None:
            failed = health_row is not None and health_row[5] > 0
            selected[stream] = {"state": "failed" if failed else "unavailable", "selected": None}
            values = health_row or (None, None, None, None, None, 0, None, "unavailable", None, 0, None)
            health.append({"source_id": SOURCE_IDS[stream], "state": "failed" if failed else "unavailable", "availability_status": "unavailable", "content_version": values[4], "last_attempt_ts": values[0], "last_success_ts": values[1], "source_updated_at": values[2], "retrieved_at": values[3], "cache_fresh_until": None if values[3] is None else values[3] + 45 * 86_400, "consecutive_failures": values[5], "last_error": values[6], "materialization": {"state": values[7], "last_success_ts": values[8], "consecutive_failures": values[9], "last_error": values[10]}})
            continue
        resource = json.loads(row[4])
        item = {"source_period": row[0], "published_at": row[1], "retrieved_at": row[3], "content_version": row[2], "url": f"/api/v2/texas-grid/{stream}/v1/{row[2]}", "source_page_url": resource["publication"]["source_page_url"]}
        fresh_until = row[3] + 45 * 86_400
        state = "available" if now <= fresh_until else "stale"
        selected[stream] = {"state": state, "selected": item}
        values = health_row or (row[3], row[3], row[1], row[3], row[2], 0, None, "healthy", row[3], 0, None)
        health_state = "failed" if values[5] else ("healthy" if state == "available" else "stale")
        health.append({"source_id": SOURCE_IDS[stream], "state": health_state, "availability_status": "available", "content_version": row[2], "last_attempt_ts": values[0], "last_success_ts": values[1], "source_updated_at": values[2], "retrieved_at": values[3], "cache_fresh_until": fresh_until, "consecutive_failures": values[5], "last_error": values[6], "materialization": {"state": values[7], "last_success_ts": values[8], "consecutive_failures": values[9], "last_error": values[10]}})
    return {"schema": 1, "kind": KIND, "policy": POLICY, "generated_at": now, "generator_interconnection": selected["gis"], "resource_capacity_trend": selected["resource_capacity_trend"], "long_term_load_forecast": selected["long_term_load_forecast"], "large_load": {"state": "available_context" if selected["long_term_load_forecast"]["selected"] else "unavailable", "scope": "forecast_methodology_not_project_status", "reason": None if selected["long_term_load_forecast"]["selected"] else "no_stable_public_machine_readable_status_source"}, "retirements": {"state": "unavailable", "reason": "no_verified_gross_retirement_source"}, "source_health": health}
