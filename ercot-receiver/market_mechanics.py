import hashlib
import json
import math
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
DAY = 86_400
METHODOLOGY = "market-context-v1"
AS_TYPES = ("ECRS", "NSPIN", "REGDN", "REGUP", "RRS")
LAMBDA_PARITY_TOLERANCE = 0.00005
ADDER_FIELDS = ("SystemLambda","RTRDPA","RTRDPARUS","RTRDPARDS","RTRDPARRS","RTRDPAECRS","RTRDPANSS","RTRRUC","RTRRMR","RTDNCLR","RTDERS","RTDCTIEIMPORT","RTDCTIEEXPORT","RTBLTIMPORT","RTBLTEXPORT","RTOLLSL","RTOLHSL","RTDLL")
CAPABILITY_FIELDS = ("CapREGUPTotal","CapREGDNTotal","CapRRSTotal","CapECRSTotal","CapNSPINTotal","CapREGUP_RRSTotal","CapREGUP_RRS_ECRSTotal","CapREGUP_RRS_ECRS_NSPINTotal")
ADDER_SERIES = {
    "RTRDPA": ("market.sced.price-adder.energy", "$/MWh"),
    "RTRDPARUS": ("market.sced.price-adder.regup", "$/MW"),
    "RTRDPARDS": ("market.sced.price-adder.regdown", "$/MW"),
    "RTRDPARRS": ("market.sced.price-adder.rrs", "$/MW"),
    "RTRDPAECRS": ("market.sced.price-adder.ecrs", "$/MW"),
    "RTRDPANSS": ("market.sced.price-adder.nonspin", "$/MW"),
}
INPUT_SERIES = {
    "RTRRUC": "ruc-ldl-relaxed",
    "RTRRMR": "rmr-ldl-relaxed",
    "RTDNCLR": "deployed-load-resource",
    "RTDERS": "deployed-ers",
    "RTDCTIEIMPORT": "dc-tie-import",
    "RTDCTIEEXPORT": "dc-tie-export",
    "RTBLTIMPORT": "rtblt-import",
    "RTBLTEXPORT": "rtblt-export",
    "RTOLLSL": "online-lsl",
    "RTOLHSL": "online-hsl",
    "RTDLL": "rtdll",
}
CAPABILITY_SERIES = {
    "CapREGUPTotal": "regup",
    "CapREGDNTotal": "regdown",
    "CapRRSTotal": "rrs",
    "CapECRSTotal": "ecrs",
    "CapNSPINTotal": "nonspin",
    "CapREGUP_RRSTotal": "regup-rrs",
    "CapREGUP_RRS_ECRSTotal": "regup-rrs-ecrs",
    "CapREGUP_RRS_ECRS_NSPINTotal": "regup-rrs-ecrs-nonspin",
}
CONTRACTS = {
    "NP6-322-CD": {"source": "ercot_mis_np6_322", "kind": "lambda", "report": "13114", "fields": ("SystemLambda",), "fingerprint": "1f1e80cd151a9ee69ab84bb170d06d0142f4689758f11b6c74e0b4038295f4cf"},
    "NP6-323-CD": {"source": "ercot_mis_np6_323", "kind": "adders", "report": "13221", "fields": ADDER_FIELDS, "fingerprint": "2ed7613d5a98662cfbf7fa552faf9e6c753bb2d68fd254925a6df19c93ac372a"},
    "NP6-328-CD": {"source": "ercot_mis_np6_328", "kind": "capability", "report": "24887", "fields": CAPABILITY_FIELDS, "fingerprint": "e7ef7efcfd834c0df0c1d9bf2fb0dd0b3a9ce86f315c048113c26d1f7b26cd0e"},
    "NP6-332-CD": {"source": "ercot_mis_np6_332", "kind": "mcpc", "report": "24891", "fields": ("MCPC",), "fingerprint": "64f337f48540aa3d10a80c884eaa7514e94ed72c965cbc63390cac59bff5a8f7"},
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sced_timestamp(raw, repeated):
    if not isinstance(raw, str) or not isinstance(repeated, bool):
        raise ValueError("invalid_sced_timestamp")
    try:
        naive = datetime.strptime(raw, "%m/%d/%Y %H:%M:%S")
    except ValueError as exc:
        raise ValueError("invalid_sced_timestamp") from exc
    candidates = []
    for fold in (0, 1):
        local = naive.replace(tzinfo=CHICAGO, fold=fold)
        epoch = int(local.timestamp())
        if datetime.fromtimestamp(epoch, CHICAGO).replace(tzinfo=None) == naive:
            candidates.append(epoch)
    candidates = sorted(set(candidates))
    if not candidates or (repeated and len(candidates) != 2):
        raise ValueError("invalid_sced_timestamp")
    return candidates[-1] if repeated else candidates[0]


def init_market_mechanics_schema(conn):
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS market_mechanics_publications(
        id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, product_id TEXT NOT NULL,
        publication_key TEXT NOT NULL, vintage_key TEXT NOT NULL UNIQUE,
        issued_at INTEGER NOT NULL, retrieved_at INTEGER NOT NULL, raw_publish_datetime TEXT NOT NULL,
        document_id TEXT NOT NULL, constructed_name TEXT NOT NULL, artifact_href TEXT NOT NULL, schema_fingerprint TEXT NOT NULL,
        parser_schema_version TEXT NOT NULL, content_hash TEXT NOT NULL, row_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(source_id,product_id,publication_key));
      CREATE TABLE IF NOT EXISTS market_mechanics_rows(
        publication_id INTEGER NOT NULL, target_ts INTEGER NOT NULL, raw_sced_timestamp TEXT NOT NULL,
        repeated_hour_flag INTEGER NOT NULL, as_type TEXT NOT NULL DEFAULT '', values_json TEXT NOT NULL,
        PRIMARY KEY(publication_id,target_ts,as_type),
        FOREIGN KEY(publication_id) REFERENCES market_mechanics_publications(id));
      CREATE INDEX IF NOT EXISTS idx_market_mechanics_target
        ON market_mechanics_rows(target_ts,publication_id,as_type);
      CREATE INDEX IF NOT EXISTS idx_market_mechanics_product
        ON market_mechanics_publications(product_id,id,issued_at,document_id);
      CREATE TABLE IF NOT EXISTS market_mechanics_resources(
        series_key TEXT NOT NULL, day_start INTEGER NOT NULL, content_version TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER,
        PRIMARY KEY(series_key,day_start,content_version));
      CREATE TABLE IF NOT EXISTS market_mechanics_current(
        series_key TEXT NOT NULL, day_start INTEGER NOT NULL, content_version TEXT NOT NULL,
        issued_at INTEGER NOT NULL, document_id TEXT NOT NULL,
        PRIMARY KEY(series_key,day_start));
      CREATE TABLE IF NOT EXISTS market_mechanics_materialization_health(
        id INTEGER PRIMARY KEY CHECK(id=1), last_attempt_ts INTEGER,
        last_success_ts INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT);
    """)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(market_mechanics_publications)")}
    if "constructed_name" not in columns:
        conn.execute("ALTER TABLE market_mechanics_publications ADD COLUMN constructed_name TEXT NOT NULL DEFAULT ''")
    resource_columns = {row[1] for row in conn.execute("PRAGMA table_info(market_mechanics_resources)")}
    if "retired_at" not in resource_columns:
        conn.execute("ALTER TABLE market_mechanics_resources ADD COLUMN retired_at INTEGER")
    conn.commit()


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("invalid_market_value")
    if abs(value) > 1_000_000:
        raise ValueError("invalid_market_value")
    return 0.0 if value == 0 else float(value)


def _publication(payload, now):
    if not isinstance(payload, dict) or set(payload) != {"publication", "rows"}:
        raise ValueError("invalid_market_payload")
    pub, rows = payload["publication"], payload["rows"]
    if not isinstance(pub, dict) or not isinstance(rows, list) or not 1 <= len(rows) <= 10_000:
        raise ValueError("invalid_market_payload")
    publication_keys = {
        "source_id", "product_id", "publication_key_kind", "publication_key", "issued_at",
        "retrieved_at", "raw_publish_datetime", "document_id", "constructed_name", "artifact_href",
        "schema_fingerprint", "parser_schema_version",
    }
    if set(pub) != publication_keys:
        raise ValueError("invalid_market_publication_fields")
    product = pub.get("product_id")
    contract = CONTRACTS.get(product)
    if contract is None or pub.get("source_id") != contract["source"] or pub.get("schema_fingerprint") != contract["fingerprint"]:
        raise ValueError("invalid_market_contract")
    doc = pub.get("document_id")
    if pub.get("publication_key_kind") != "official_mis_document" or not isinstance(doc, str) or not re.fullmatch(r"\d{1,20}", doc) or pub.get("publication_key") != doc:
        raise ValueError("invalid_market_identity")
    href = f"https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={doc}"
    if pub.get("artifact_href") != href or pub.get("parser_schema_version") != "ercot-mis-market-v1":
        raise ValueError("invalid_market_contract")
    issued, retrieved = pub.get("issued_at"), pub.get("retrieved_at")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (issued, retrieved)) or not issued <= retrieved <= now + 300:
        raise ValueError("invalid_market_provenance")
    raw_publish = pub.get("raw_publish_datetime")
    if not isinstance(raw_publish, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00", raw_publish):
        raise ValueError("invalid_market_provenance")
    try:
        raw_issue = datetime.fromisoformat(raw_publish)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_market_provenance") from exc
    if raw_issue.utcoffset() is None or int(raw_issue.timestamp()) != issued or datetime.fromtimestamp(issued, CHICAGO).utcoffset() != raw_issue.utcoffset():
        raise ValueError("invalid_market_provenance")
    constructed = pub.get("constructed_name")
    name_patterns = {
        "NP6-322-CD": r"cdr\.00013114\.0{16}\.\d{8}\.\d{9}\.SCEDSYSLAMBDANP6322_[A-Za-z0-9_-]+_csv\.zip",
        "NP6-323-CD": r"cdr\.00013221\.0{16}\.\d{8}\.\d{9}\.RTSCEDpriceAdderNP6323_[A-Za-z0-9_-]+_csv\.zip",
        "NP6-328-CD": r"cdr\.00024887\.0{16}\.\d{8}\.\d{9}\.TotASResCapabilityNP6328_[A-Za-z0-9_-]+_csv\.zip",
        "NP6-332-CD": r"cdr\.00024891\.0{16}\.\d{8}\.\d{9}\.SCEDMCPCNP6332_csv\.zip",
    }
    if not isinstance(constructed, str) or not re.fullmatch(name_patterns[product], constructed):
        raise ValueError("invalid_market_constructed_name")
    expected_count = 5 if product == "NP6-332-CD" else (1 if product in ("NP6-323-CD", "NP6-328-CD") else None)
    if expected_count is not None and len(rows) != expected_count:
        raise ValueError("invalid_market_row_count")
    if product == "NP6-322-CD" and not 1 <= len(rows) <= 12:
        raise ValueError("invalid_market_row_count")
    normalized = []
    seen = set()
    for row in rows:
        expected_row_keys = {"target_ts", "raw_sced_timestamp", "repeated_hour_flag", "values"}
        if contract["kind"] == "mcpc":
            expected_row_keys.add("as_type")
        if not isinstance(row, dict) or set(row) != expected_row_keys or not isinstance(row.get("target_ts"), int) or isinstance(row.get("target_ts"), bool) or not isinstance(row.get("raw_sced_timestamp"), str) or not isinstance(row.get("repeated_hour_flag"), bool):
            raise ValueError("invalid_market_row")
        target = sced_timestamp(row["raw_sced_timestamp"], row["repeated_hour_flag"])
        if row.get("target_ts") != target:
            raise ValueError("invalid_market_target")
        as_type = row.get("as_type", "")
        if contract["kind"] == "mcpc" and as_type not in AS_TYPES:
            raise ValueError("invalid_market_as_type")
        if contract["kind"] != "mcpc" and as_type != "":
            raise ValueError("invalid_market_as_type")
        values = row.get("values")
        if not isinstance(values, dict) or set(values) != set(contract["fields"]):
            raise ValueError("invalid_market_row")
        values = {key: _finite(value) for key, value in sorted(values.items())}
        if contract["kind"] == "capability" and any(value < 0 for value in values.values()):
            raise ValueError("invalid_market_capability")
        key = (target, as_type)
        if key in seen:
            raise ValueError("duplicate_market_row")
        seen.add(key)
        normalized.append({"target_ts": target, "raw_sced_timestamp": row["raw_sced_timestamp"], "repeated_hour_flag": row["repeated_hour_flag"], "as_type": as_type, "values": values})
    normalized.sort(key=lambda row: (row["target_ts"], row["as_type"]))
    if product == "NP6-332-CD" and (
        {row["as_type"] for row in normalized} != set(AS_TYPES)
        or len({(row["target_ts"], row["repeated_hour_flag"]) for row in normalized}) != 1
    ):
        raise ValueError("invalid_market_as_membership")
    immutable = {key: pub.get(key) for key in ("source_id", "product_id", "publication_key", "issued_at", "raw_publish_datetime", "document_id", "constructed_name", "artifact_href", "schema_fingerprint", "parser_schema_version")}
    digest = hashlib.sha256(canonical({"publication": immutable, "rows": normalized}).encode()).hexdigest()
    return pub, normalized, contract, digest, "mm1-" + digest


def _series(contract, row):
    if contract["kind"] == "lambda":
        return [("market.sced.system-lambda", row["values"]["SystemLambda"], "$/MWh")]
    if contract["kind"] == "adders":
        return [
            (ADDER_SERIES[key][0], row["values"][key], ADDER_SERIES[key][1])
            for key in ADDER_SERIES
        ] + [
            (f"market.sced.adder-input.{name}", row["values"][key], "MW")
            for key, name in INPUT_SERIES.items()
        ]
    if contract["kind"] == "capability":
        return [
            (f"market.sced.as-capability.{name}", row["values"][key], "MW")
            for key, name in CAPABILITY_SERIES.items()
        ]
    return [(f"market.sced.as-mcpc.{row['as_type'].lower().replace('nspin', 'nonspin').replace('regdn', 'regdown')}", row["values"]["MCPC"], "$/MW")]


def _materialize(conn, publication_id, pub, rows, contract, now):
    outputs = []
    current_day = now // DAY * DAY
    for day in sorted({row["target_ts"] // DAY * DAY for row in rows if row["target_ts"] // DAY * DAY < current_day}):
        grouped = {}
        stored = conn.execute("""SELECT target_ts,as_type,values_json,vintage_key,issued_at,raw_publish_datetime,document_id,raw_sced_timestamp,repeated_hour_flag FROM (
          SELECT r.target_ts,r.as_type,r.values_json,p.vintage_key,p.issued_at,p.raw_publish_datetime,p.document_id,r.raw_sced_timestamp,r.repeated_hour_flag,
            ROW_NUMBER() OVER(PARTITION BY r.target_ts,r.as_type ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC) rank
          FROM market_mechanics_rows r JOIN market_mechanics_publications p ON p.id=r.publication_id
          WHERE p.product_id=? AND r.target_ts>=? AND r.target_ts<?) WHERE rank=1 ORDER BY target_ts,as_type""",
          (pub["product_id"], day, day + DAY)).fetchall()
        contributors = {}
        units = {}
        pointer = None
        for target, as_type, values_json, vintage_key, issued_at, raw_publish_datetime, document_id, raw_sced_timestamp, repeated_hour_flag in stored:
            contributors[vintage_key] = {"vintage_key": vintage_key, "issued_at": issued_at}
            candidate = (issued_at, len(document_id), document_id)
            if pointer is None or candidate > pointer:
                pointer = candidate
            row = {"target_ts": target, "as_type": as_type, "values": json.loads(values_json)}
            source = {
                "source_id": contract["source"],
                "product_id": pub["product_id"],
                "vintage_key": vintage_key,
                "document_id": document_id,
                "issued_at": issued_at,
                "raw_publish_datetime": raw_publish_datetime,
                "raw_sced_timestamp": raw_sced_timestamp,
                "repeated_hour_flag": bool(repeated_hour_flag),
            }
            for key, value, unit in _series(contract, row):
                units[key] = unit
                grouped.setdefault(key, []).append({"target_ts": row["target_ts"], "value": value, "source": source})
        for key, values in grouped.items():
            payload = {"schema_version": 1, "methodology": METHODOLOGY, "series_key": key,
                       "tile_span": "1d", "tile_start": day, "tile_end": day + DAY,
                       "lod": "native", "unit": units[key],
                       "source": {"product_id": pub["product_id"], "contributors": [contributors[key] for key in sorted(contributors)]},
                       "rows": values}
            version = "mmr1-" + hashlib.sha256(canonical(payload).encode()).hexdigest()
            payload["content_version"] = version
            conn.execute("""INSERT OR IGNORE INTO market_mechanics_resources
              (series_key,day_start,content_version,payload_json,created_at,retired_at) VALUES(?,?,?,?,?,NULL)""",
                         (key, day, version, canonical(payload), now))
            previous = conn.execute("SELECT content_version FROM market_mechanics_current WHERE series_key=? AND day_start=?",
                                    (key, day)).fetchone()
            if previous and previous[0] != version:
                conn.execute("""UPDATE market_mechanics_resources SET retired_at=COALESCE(retired_at,?)
                  WHERE series_key=? AND day_start=? AND content_version=?""", (now, key, day, previous[0]))
            conn.execute("""INSERT INTO market_mechanics_current VALUES(?,?,?,?,?)
              ON CONFLICT(series_key,day_start) DO UPDATE SET content_version=excluded.content_version,
              issued_at=excluded.issued_at,document_id=excluded.document_id""",
                         (key, day, version, pointer[0], pointer[2]))
            outputs.append({"series_key": key, "day_start": day, "content_version": version})
    return outputs


def _seal_previous_day(conn, now):
    day = (now // DAY - 1) * DAY
    outputs = []
    for product_id, contract in CONTRACTS.items():
        if contract["kind"] == "mcpc":
            expected_keys = [f"market.sced.as-mcpc.{value.lower().replace('nspin', 'nonspin').replace('regdn', 'regdown')}" for value in AS_TYPES]
        else:
            expected_keys = [item[0] for item in _series(contract, {"as_type": "", "values": {field: 0.0 for field in contract["fields"]}})]
        placeholders = ",".join("?" for _ in expected_keys)
        pointer_count = conn.execute(
            f"SELECT COUNT(*) FROM market_mechanics_current WHERE day_start=? AND series_key IN ({placeholders})",
            (day, *expected_keys),
        ).fetchone()[0]
        if pointer_count == len(expected_keys):
            continue
        exists = conn.execute("""SELECT 1 FROM market_mechanics_rows r
          JOIN market_mechanics_publications p ON p.id=r.publication_id
          WHERE p.product_id=? AND r.target_ts>=? AND r.target_ts<? LIMIT 1""",
          (product_id, day, day + DAY)).fetchone()
        if exists:
            outputs.extend(_materialize(conn, 0, {"product_id": product_id}, [{"target_ts": day}], contract, now))
    return outputs


def _record_materialization(conn, now, success, error=None):
    conn.execute("""INSERT INTO market_mechanics_materialization_health
      (id,last_attempt_ts,last_success_ts,consecutive_failures,last_error) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_attempt_ts=excluded.last_attempt_ts,
        last_success_ts=CASE WHEN excluded.last_success_ts IS NOT NULL THEN excluded.last_success_ts ELSE market_mechanics_materialization_health.last_success_ts END,
        consecutive_failures=CASE WHEN excluded.last_success_ts IS NOT NULL THEN 0 ELSE market_mechanics_materialization_health.consecutive_failures+1 END,
        last_error=excluded.last_error""", (now, now if success else None, 0 if success else 1, error))


def ingest_market_mechanics_publication(conn, payload, current_ts=None):
    now = int(time.time()) if current_ts is None else current_ts
    pub, rows, contract, digest, vintage = _publication(payload, now)
    conn.execute("BEGIN IMMEDIATE")
    materializing = False
    try:
        prior = conn.execute("SELECT id,content_hash,row_count FROM market_mechanics_publications WHERE source_id=? AND product_id=? AND publication_key=?",
                             (pub["source_id"], pub["product_id"], pub["publication_key"])).fetchone()
        if prior:
            if prior[1:] != (digest, len(rows)):
                raise ValueError("market_publication_collision")
            materializing = True
            resources = _materialize(conn, prior[0], dict(pub, content_hash=digest), rows, contract, now)
            resources.extend(_seal_previous_day(conn, now))
            _record_materialization(conn, now, True)
            conn.commit()
            return {"status": "unchanged", "vintage_key": vintage, "row_count": len(rows), "resources": resources}
        pub = dict(pub, content_hash=digest)
        cursor = conn.execute("""INSERT INTO market_mechanics_publications
          (source_id,product_id,publication_key,vintage_key,issued_at,retrieved_at,raw_publish_datetime,
           document_id,constructed_name,artifact_href,schema_fingerprint,parser_schema_version,content_hash,row_count,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
          (pub["source_id"],pub["product_id"],pub["publication_key"],vintage,pub["issued_at"],pub["retrieved_at"],
           pub["raw_publish_datetime"],pub["document_id"],pub["constructed_name"],pub["artifact_href"],pub["schema_fingerprint"],
           pub["parser_schema_version"],digest,len(rows),now))
        conn.executemany("INSERT INTO market_mechanics_rows VALUES(?,?,?,?,?,?)",
          [(cursor.lastrowid,row["target_ts"],row["raw_sced_timestamp"],int(row["repeated_hour_flag"]),row["as_type"],canonical(row["values"])) for row in rows])
        materializing = True
        resources = _materialize(conn, cursor.lastrowid, pub, rows, contract, now)
        resources.extend(_seal_previous_day(conn, now))
        _record_materialization(conn, now, True)
        conn.commit()
        return {"status": "inserted", "vintage_key": vintage, "row_count": len(rows), "resources": resources}
    except Exception as exc:
        conn.rollback()
        if materializing:
            _record_materialization(conn, now, False, "market_mechanics_materialization_failed")
            conn.commit()
        raise


def _selected_rows(conn, product_id, target_ts):
    return conn.execute("""SELECT as_type,values_json,vintage_key,issued_at,raw_publish_datetime,document_id,raw_sced_timestamp,repeated_hour_flag
      FROM (
        SELECT r.as_type,r.values_json,p.vintage_key,p.issued_at,p.raw_publish_datetime,p.document_id,
          r.raw_sced_timestamp,r.repeated_hour_flag,
          ROW_NUMBER() OVER(PARTITION BY r.as_type ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC) rank
        FROM market_mechanics_rows r JOIN market_mechanics_publications p ON p.id=r.publication_id
        WHERE p.product_id=? AND r.target_ts=?
      ) WHERE rank=1 ORDER BY as_type""", (product_id, target_ts)).fetchall()


def _coherent_snapshots(conn):
    candidates = [row[0] for row in conn.execute("""SELECT DISTINCT r.target_ts
      FROM market_mechanics_rows r JOIN market_mechanics_publications p ON p.id=r.publication_id
      WHERE p.product_id='NP6-322-CD'
        AND EXISTS (SELECT 1 FROM market_mechanics_rows r2 JOIN market_mechanics_publications p2 ON p2.id=r2.publication_id
                    WHERE p2.product_id='NP6-323-CD' AND r2.target_ts=r.target_ts)
        AND EXISTS (SELECT 1 FROM market_mechanics_rows r3 JOIN market_mechanics_publications p3 ON p3.id=r3.publication_id
                    WHERE p3.product_id='NP6-328-CD' AND r3.target_ts=r.target_ts)
        AND (SELECT COUNT(DISTINCT r4.as_type) FROM market_mechanics_rows r4 JOIN market_mechanics_publications p4 ON p4.id=r4.publication_id
             WHERE p4.product_id='NP6-332-CD' AND r4.target_ts=r.target_ts)=5
      ORDER BY r.target_ts DESC LIMIT 128""")]
    snapshots = []
    for target in candidates:
        selected = {product: _selected_rows(conn, product, target) for product in CONTRACTS}
        if len(selected["NP6-322-CD"]) != 1 or len(selected["NP6-323-CD"]) != 1 or len(selected["NP6-328-CD"]) != 1 or len(selected["NP6-332-CD"]) != 5:
            continue
        readings = {}
        sources = {}
        for product, rows in selected.items():
            contract = CONTRACTS[product]
            for as_type, values_json, vintage_key, issued_at, raw_publish_datetime, document_id, raw_sced_timestamp, repeated_hour_flag in rows:
                values = json.loads(values_json)
                source = {
                    "source_id": contract["source"], "product_id": product,
                    "vintage_key": vintage_key, "document_id": document_id,
                    "issued_at": issued_at, "raw_publish_datetime": raw_publish_datetime,
                    "raw_sced_timestamp": raw_sced_timestamp,
                    "repeated_hour_flag": bool(repeated_hour_flag),
                }
                sources[product] = source
                for key, value, unit in _series(contract, {"as_type": as_type, "values": values}):
                    readings[key] = {"value": value, "unit": unit, "source": source}
        lambda_322 = selected["NP6-322-CD"][0]
        lambda_323 = selected["NP6-323-CD"][0]
        lhs = json.loads(lambda_322[1])["SystemLambda"]
        rhs = json.loads(lambda_323[1])["SystemLambda"]
        delta = rhs - lhs
        snapshots.append({
            "target_ts": target,
            "alignment": "exact_same_sced_timestamp",
            "readings": readings,
            "sources": sources,
            "lambda_parity": {
                "state": "match" if abs(delta) <= LAMBDA_PARITY_TOLERANCE else "mismatch",
                "np6_322_value": lhs,
                "np6_323_value": rhs,
                "delta": delta,
                "tolerance": LAMBDA_PARITY_TOLERANCE,
                "unit": "$/MWh",
            },
        })
        if len(snapshots) == 2:
            break
    return snapshots


def _source_health(conn, source_ids, current):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_sources'").fetchone():
        return [{"source_id": source_id, "state": "unavailable", "collection_state": "failed",
                 "freshness_state": "unknown", "availability_status": "unavailable",
                 "expected_interval_seconds": 300, "last_attempt_ts": None, "last_success_ts": None,
                 "source_timestamp_ts": None, "data_timestamp_ts": None, "collection_age_seconds": None,
                 "data_age_seconds": None, "consecutive_failures": None, "gap_count": 0,
                 "last_error": "never_reported"}
                for source_id in source_ids]
    rows = conn.execute(f"""SELECT source_id,expected_interval_seconds,last_attempt_ts,last_success_ts,
      source_timestamp_ts,data_timestamp_ts,consecutive_failures,last_error,availability_status,diagnostics_json
      FROM collector_sources WHERE source_id IN ({','.join('?' for _ in source_ids)}) ORDER BY source_id""", source_ids).fetchall()
    output = []
    for source_id, expected, attempted, success, source_ts, data_ts, failures, error, availability, diagnostics_json in rows:
        expected = max(1, int(expected or 300))
        failures = int(failures or 0)
        collection_age = None if success is None else max(0, current - int(success))
        data_age = None if data_ts is None else max(0, current - int(data_ts))
        collection = "failed" if success is None or failures >= 3 else ("delayed" if failures or collection_age > expected * 2 else "healthy")
        freshness = "unknown" if data_age is None else ("stale" if data_age > expected * 4 else ("delayed" if data_age > expected * 2 else "fresh"))
        diagnostics = {} if not diagnostics_json else json.loads(diagnostics_json)
        gap_count = diagnostics.get("gap_count", 0) if isinstance(diagnostics, dict) else 0
        state = "failed" if collection == "failed" else ("stale" if freshness == "stale" else ("delayed" if collection == "delayed" or freshness in ("delayed", "unknown") or gap_count else "healthy"))
        output.append({"source_id": source_id, "state": state, "collection_state": collection,
                       "freshness_state": freshness, "availability_status": availability or "unavailable",
                       "expected_interval_seconds": expected, "last_attempt_ts": attempted,
                       "last_success_ts": success, "source_timestamp_ts": source_ts,
                       "data_timestamp_ts": data_ts, "collection_age_seconds": collection_age,
                       "data_age_seconds": data_age, "consecutive_failures": failures,
                       "gap_count": gap_count, "last_error": "document_gap" if gap_count else error})
    present = {item["source_id"] for item in output}
    output.extend({"source_id": source_id, "state": "unavailable", "collection_state": "failed",
                   "freshness_state": "unknown", "availability_status": "unavailable",
                   "expected_interval_seconds": 300, "last_attempt_ts": None, "last_success_ts": None,
                   "source_timestamp_ts": None, "data_timestamp_ts": None, "collection_age_seconds": None,
                   "data_age_seconds": None, "consecutive_failures": None, "gap_count": 0,
                   "last_error": "never_reported"}
                  for source_id in source_ids if source_id not in present)
    return sorted(output, key=lambda item: item["source_id"])


def market_mechanics_manifest(conn, now=None):
    current = int(time.time()) if now is None else now
    links = [{"series_key": row[0], "tile_start": row[1], "content_version": row[2], "lod": "native",
              "url": f"/api/v2/market-mechanics/{row[0]}/v1/{row[2]}/1d/{row[1]}/native"}
             for row in conn.execute("SELECT series_key,day_start,content_version FROM market_mechanics_current WHERE day_start>=? AND day_start<=? ORDER BY series_key,day_start",
                                     ((current // DAY - 35) * DAY, (current // DAY) * DAY))]
    latest = {}
    keys = [row[0] for row in conn.execute("SELECT DISTINCT series_key FROM market_mechanics_current ORDER BY series_key")]
    for key in keys:
        row = conn.execute("""SELECT r.payload_json FROM market_mechanics_current c JOIN market_mechanics_resources r
          ON r.series_key=c.series_key AND r.day_start=c.day_start AND r.content_version=c.content_version
          WHERE c.series_key=? ORDER BY c.day_start DESC LIMIT 1""", (key,)).fetchone()
        if row:
            resource = json.loads(row[0])
            points = resource["rows"]
            latest[key] = None if not points else {**points[-1], "unit": resource["unit"]}
    source_ids = tuple(contract["source"] for contract in CONTRACTS.values())
    health = _source_health(conn, source_ids, current)
    materialization_row = conn.execute("SELECT last_attempt_ts,last_success_ts,consecutive_failures,last_error FROM market_mechanics_materialization_health WHERE id=1").fetchone()
    materialization = ({"state": "unavailable", "last_attempt_ts": None, "last_success_ts": None,
                        "consecutive_failures": None, "last_error": "never_run"}
                       if materialization_row is None else
                       {"state": "failed" if materialization_row[2] else "healthy",
                        "last_attempt_ts": materialization_row[0], "last_success_ts": materialization_row[1],
                        "consecutive_failures": materialization_row[2], "last_error": materialization_row[3]})
    snapshots = _coherent_snapshots(conn)
    coherent = snapshots[0] if snapshots else None
    previous = snapshots[1] if len(snapshots) > 1 else None
    changes = ({key: {"delta": None if previous is None else reading["value"] - previous["readings"][key]["value"],
                      "unit": reading["unit"]}
                for key, reading in coherent["readings"].items()} if coherent else {})
    elapsed = None if previous is None else coherent["target_ts"] - previous["target_ts"]
    coherent_readings = {} if coherent is None else coherent["readings"]
    active_adders = [key for key, point in coherent_readings.items()
                     if key.startswith("market.sced.price-adder.") and point["value"] != 0]
    factors = ({"status": "unavailable_unaligned", "energy_signal": None,
                "active_price_adder_series": [], "target_ts": None,
                "binding_constraints": {"status": "unavailable_deferred_np6_86"}}
               if coherent is None else
               {"status": "aligned", "energy_signal": coherent_readings["market.sced.system-lambda"],
                "active_price_adder_series": active_adders, "target_ts": coherent["target_ts"],
                "binding_constraints": {"status": "unavailable_deferred_np6_86"}})
    return {"schema_version": 1, "kind": "market_mechanics_manifest", "methodology": METHODOLOGY,
            "explanation_policy": "time_adjacent_context_not_causal_decomposition",
            "deferred_products": ["NP6-331-CD", "NP6-86-CD"],
            "factors": factors,
            "current": coherent, "previous": previous, "changes": changes, "elapsed_seconds": elapsed,
            "source_health": health, "materialization_health": materialization,
            "latest": latest, "resources": links}


def market_mechanics_resource(conn, series_key, version, content_version, day_start, lod):
    if version != "v1" or lod != "native" or day_start % DAY:
        raise ValueError("invalid_market_resource")
    row = conn.execute("SELECT payload_json FROM market_mechanics_resources WHERE series_key=? AND day_start=? AND content_version=?",
                       (series_key, day_start, content_version)).fetchone()
    return None if row is None else json.loads(row[0])


def prune_market_mechanics(conn, now=None, batch_size=500):
    current = int(time.time()) if now is None else now
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or not 1 <= batch_size <= 1000:
        raise ValueError("invalid_market_prune_batch")
    cutoff = current - 35 * DAY
    conn.execute("BEGIN IMMEDIATE")
    try:
        old_pointers = conn.execute(
            "SELECT series_key,day_start FROM market_mechanics_current WHERE day_start<? ORDER BY day_start,series_key LIMIT ?",
            ((cutoff // DAY) * DAY, batch_size),
        ).fetchall()
        for series_key, day_start in old_pointers:
            conn.execute("""UPDATE market_mechanics_resources SET retired_at=COALESCE(retired_at,?)
              WHERE series_key=? AND day_start=? AND content_version=(
                SELECT content_version FROM market_mechanics_current WHERE series_key=? AND day_start=?)""",
                (current, series_key, day_start, series_key, day_start))
        conn.executemany("DELETE FROM market_mechanics_current WHERE series_key=? AND day_start=?", old_pointers)
        resources = conn.execute("""SELECT series_key,day_start,content_version FROM market_mechanics_resources r
          WHERE r.retired_at IS NOT NULL AND r.retired_at<? AND NOT EXISTS (
            SELECT 1 FROM market_mechanics_current c WHERE c.series_key=r.series_key AND c.day_start=r.day_start AND c.content_version=r.content_version)
          ORDER BY r.retired_at,series_key,day_start,content_version LIMIT ?""", (cutoff, batch_size)).fetchall()
        conn.executemany("DELETE FROM market_mechanics_resources WHERE series_key=? AND day_start=? AND content_version=?", resources)
        publications = conn.execute("""SELECT p.id FROM market_mechanics_publications p
          WHERE p.created_at<? AND NOT EXISTS (
            SELECT 1 FROM market_mechanics_rows r WHERE r.publication_id=p.id AND r.target_ts>=?)
          ORDER BY p.created_at,p.id LIMIT ?""", (cutoff, cutoff, batch_size)).fetchall()
        conn.executemany("DELETE FROM market_mechanics_rows WHERE publication_id=?", publications)
        conn.executemany("DELETE FROM market_mechanics_publications WHERE id=?", publications)
        conn.commit()
        return {"pointers": len(old_pointers), "resources": len(resources), "publications": len(publications)}
    except Exception:
        conn.rollback()
        raise
