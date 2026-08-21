import hashlib
import json
import math
import re
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo("America/Chicago")
DAY = 86_400
METHODOLOGY = "market-geography-v1"
RETENTION_SECONDS = 35 * DAY
MAX_CONSTRAINTS = 20

HEATMAP_POINTS = (
    ("HB_HOUSTON", "HU"),
    ("HB_NORTH", "HU"),
    ("HB_PAN", "HU"),
    ("HB_SOUTH", "HU"),
    ("HB_WEST", "HU"),
    ("LZ_AEN", "LZ"),
    ("LZ_CPS", "LZ"),
    ("LZ_HOUSTON", "LZ"),
    ("LZ_LCRA", "LZ"),
    ("LZ_NORTH", "LZ"),
    ("LZ_RAYBN", "LZ"),
    ("LZ_SOUTH", "LZ"),
    ("LZ_WEST", "LZ"),
)
REFERENCE_POINTS = (("HB_BUSAVG", "SH"), ("HB_HUBAVG", "AH"))
DISPLAY_POINTS = HEATMAP_POINTS + REFERENCE_POINTS
DISPLAY_POINT_SET = set(DISPLAY_POINTS)
LMP_POINT_SET = {point for point, _kind in DISPLAY_POINTS}

CONTRACTS = {
    "NP6-788-CD": {
        "source": "ercot_mis_np6_788",
        "report": 12300,
        "kind": "lmp",
        "fingerprint": "2ab04e739fba30bc2ee527b4927af212669c8932056745ddfe3bdad29e80ce9c",
        "parser": "ercot-market-geography-v1",
        "constructed": r"cdr\.00012300\.0{16}\.\d{8}\.\d{9}\.LMPSROSNODENP6788_\d{8}_\d{6}_csv\.zip",
        "maximum_rows": 5_000,
    },
    "NP6-905-CD": {
        "source": "ercot_mis_np6_905",
        "report": 12301,
        "kind": "price",
        "fingerprint": "4e6f1ec046967794271f9fd4c2f880b0382f561502c24e0f883aa0be0cc21974",
        "parser": "ercot-market-geography-v1",
        "constructed": r"cdr\.00012301\.0{16}\.\d{8}\.\d{9}\.SPPHLZNP6905_\d{8}_\d{4}_csv\.zip",
        "maximum_rows": 5_000,
    },
    "NP6-86-CD": {
        "source": "ercot_mis_np6_86",
        "report": 12302,
        "kind": "constraint",
        "fingerprint": "732f368c6be8e87cb0806a57c5ac510b4944011ea22c72bf354de0c48bd89ee7",
        "parser": "ercot-market-geography-v1",
        "constructed": r"cdr\.00012302\.0{16}\.\d{8}\.\d{9}\.SCEDBTCNP686_csv\.zip",
        "maximum_rows": 10_000,
    },
}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("invalid_market_geography_number")
    return 0.0 if value == 0 else float(value)


def _text(value, field, maximum=512):
    if not isinstance(value, str) or not value or value.strip() != value or len(value) > maximum:
        raise ValueError(f"invalid_market_geography_{field}")
    return value


def sced_target_ts(raw, repeated):
    if not isinstance(raw, str) or not isinstance(repeated, bool):
        raise ValueError("invalid_market_geography_timestamp")
    try:
        naive = datetime.strptime(raw, "%m/%d/%Y %H:%M:%S")
    except ValueError as exc:
        raise ValueError("invalid_market_geography_timestamp") from exc
    candidates = []
    for fold in (0, 1):
        local = naive.replace(tzinfo=CHICAGO, fold=fold)
        epoch = int(local.timestamp())
        if datetime.fromtimestamp(epoch, CHICAGO).replace(tzinfo=None) == naive:
            candidates.append(epoch)
    candidates = sorted(set(candidates))
    if not candidates or (repeated and len(candidates) != 2):
        raise ValueError("invalid_market_geography_timestamp")
    return candidates[-1] if repeated else candidates[0]


def market_interval_target_ts(raw_date, hour, interval, repeated):
    if (
        not isinstance(raw_date, str)
        or not isinstance(hour, int)
        or isinstance(hour, bool)
        or not 1 <= hour <= 24
        or not isinstance(interval, int)
        or isinstance(interval, bool)
        or not 1 <= interval <= 4
        or not isinstance(repeated, bool)
    ):
        raise ValueError("invalid_market_geography_interval")
    try:
        base = datetime.strptime(raw_date, "%m/%d/%Y")
    except ValueError as exc:
        raise ValueError("invalid_market_geography_interval") from exc
    naive = base + timedelta(minutes=(hour - 1) * 60 + interval * 15)
    candidates = []
    for fold in (0, 1):
        local = naive.replace(tzinfo=CHICAGO, fold=fold)
        epoch = int(local.timestamp())
        if datetime.fromtimestamp(epoch, CHICAGO).replace(tzinfo=None) == naive:
            candidates.append(epoch)
    candidates = sorted(set(candidates))
    if not candidates or (repeated and len(candidates) != 2):
        raise ValueError("invalid_market_geography_interval")
    return candidates[-1] if repeated else candidates[0]


def init_market_geography_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS market_geography_publications(
          id INTEGER PRIMARY KEY,
          source_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          publication_key TEXT NOT NULL,
          content_key TEXT NOT NULL UNIQUE,
          issued_at INTEGER NOT NULL,
          retrieved_at INTEGER NOT NULL,
          raw_publish_datetime TEXT NOT NULL,
          document_id TEXT NOT NULL,
          constructed_name TEXT NOT NULL,
          artifact_href TEXT NOT NULL,
          schema_fingerprint TEXT NOT NULL,
          parser_schema_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(source_id,product_id,publication_key)
        );
        CREATE INDEX IF NOT EXISTS idx_market_geography_publication_order
          ON market_geography_publications(product_id,issued_at,document_id);
        CREATE TABLE IF NOT EXISTS market_geography_lmp_rows(
          publication_id INTEGER NOT NULL,
          target_ts INTEGER NOT NULL,
          raw_sced_timestamp TEXT NOT NULL,
          repeated_hour_flag INTEGER NOT NULL,
          settlement_point TEXT NOT NULL,
          lmp REAL NOT NULL,
          PRIMARY KEY(publication_id,target_ts,settlement_point),
          FOREIGN KEY(publication_id) REFERENCES market_geography_publications(id)
        );
        CREATE INDEX IF NOT EXISTS idx_market_geography_lmp_target
          ON market_geography_lmp_rows(target_ts,settlement_point,publication_id);
        CREATE TABLE IF NOT EXISTS market_geography_price_rows(
          publication_id INTEGER NOT NULL,
          target_ts INTEGER NOT NULL,
          raw_delivery_date TEXT NOT NULL,
          delivery_hour INTEGER NOT NULL,
          delivery_interval INTEGER NOT NULL,
          raw_dst_flag TEXT NOT NULL,
          repeated_hour_flag INTEGER NOT NULL,
          settlement_point TEXT NOT NULL,
          settlement_point_type TEXT NOT NULL,
          settlement_point_price REAL NOT NULL,
          PRIMARY KEY(publication_id,target_ts,settlement_point,settlement_point_type),
          FOREIGN KEY(publication_id) REFERENCES market_geography_publications(id)
        );
        CREATE INDEX IF NOT EXISTS idx_market_geography_price_target
          ON market_geography_price_rows(target_ts,settlement_point,settlement_point_type,publication_id);
        CREATE TABLE IF NOT EXISTS market_geography_constraint_rows(
          publication_id INTEGER NOT NULL,
          target_ts INTEGER NOT NULL,
          raw_sced_timestamp TEXT NOT NULL,
          repeated_hour_flag INTEGER NOT NULL,
          constraint_id TEXT NOT NULL,
          constraint_name TEXT NOT NULL,
          contingency_name TEXT NOT NULL,
          shadow_price REAL NOT NULL,
          max_shadow_price REAL NOT NULL,
          limit_mw REAL NOT NULL,
          value_mw REAL NOT NULL,
          violated_mw REAL NOT NULL,
          from_station TEXT NOT NULL,
          to_station TEXT NOT NULL,
          from_station_kv REAL NOT NULL,
          to_station_kv REAL NOT NULL,
          cct_status TEXT NOT NULL,
          constraint_key TEXT NOT NULL,
          PRIMARY KEY(publication_id,target_ts,constraint_key),
          FOREIGN KEY(publication_id) REFERENCES market_geography_publications(id)
        );
        CREATE INDEX IF NOT EXISTS idx_market_geography_constraint_target
          ON market_geography_constraint_rows(target_ts,constraint_key,publication_id);
        CREATE TABLE IF NOT EXISTS market_geography_resources(
          kind TEXT NOT NULL,
          identity TEXT NOT NULL,
          day_start INTEGER NOT NULL,
          content_version TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          PRIMARY KEY(kind,identity,day_start,content_version)
        );
        CREATE TABLE IF NOT EXISTS market_geography_current(
          kind TEXT NOT NULL,
          identity TEXT NOT NULL,
          day_start INTEGER NOT NULL,
          content_version TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(kind,identity,day_start)
        );
        CREATE TABLE IF NOT EXISTS market_geography_materialization_health(
          id INTEGER PRIMARY KEY CHECK(id=1),
          last_attempt_ts INTEGER,
          last_success_ts INTEGER,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );
        """
    )
    conn.commit()


def _publication(payload, now):
    if not isinstance(payload, dict) or set(payload) != {"publication", "rows"}:
        raise ValueError("invalid_market_geography_payload")
    pub = payload["publication"]
    rows = payload["rows"]
    expected_pub = {
        "source_id",
        "product_id",
        "publication_key_kind",
        "publication_key",
        "issued_at",
        "retrieved_at",
        "raw_publish_datetime",
        "document_id",
        "constructed_name",
        "artifact_href",
        "schema_fingerprint",
        "parser_schema_version",
    }
    if not isinstance(pub, dict) or set(pub) != expected_pub or not isinstance(rows, list):
        raise ValueError("invalid_market_geography_publication")
    product = pub.get("product_id")
    contract = CONTRACTS.get(product)
    if contract is None or not 1 <= len(rows) <= contract["maximum_rows"]:
        raise ValueError("invalid_market_geography_contract")
    if (
        pub.get("source_id") != contract["source"]
        or pub.get("schema_fingerprint") != contract["fingerprint"]
        or pub.get("parser_schema_version") != contract["parser"]
        or pub.get("publication_key_kind") != "official_mis_document"
    ):
        raise ValueError("invalid_market_geography_contract")
    doc = pub.get("document_id")
    if (
        not isinstance(doc, str)
        or re.fullmatch(r"\d{1,20}", doc) is None
        or pub.get("publication_key") != doc
        or pub.get("artifact_href")
        != f"https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={doc}"
        or not isinstance(pub.get("constructed_name"), str)
        or re.fullmatch(contract["constructed"], pub["constructed_name"]) is None
    ):
        raise ValueError("invalid_market_geography_identity")
    issued = pub.get("issued_at")
    retrieved = pub.get("retrieved_at")
    raw_publish = pub.get("raw_publish_datetime")
    if (
        not isinstance(issued, int)
        or isinstance(issued, bool)
        or not isinstance(retrieved, int)
        or isinstance(retrieved, bool)
        or not issued <= retrieved <= now + 300
        or not isinstance(raw_publish, str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00", raw_publish)
        is None
    ):
        raise ValueError("invalid_market_geography_provenance")
    try:
        published = datetime.fromisoformat(raw_publish)
    except ValueError as exc:
        raise ValueError("invalid_market_geography_provenance") from exc
    if int(published.timestamp()) != issued:
        raise ValueError("invalid_market_geography_provenance")
    normalized = _normalize_rows(product, rows)
    immutable_pub = {
        key: pub[key]
        for key in (
            "source_id",
            "product_id",
            "publication_key",
            "issued_at",
            "raw_publish_datetime",
            "document_id",
            "constructed_name",
            "artifact_href",
            "schema_fingerprint",
            "parser_schema_version",
        )
    }
    digest = hashlib.sha256(_canonical({"publication": immutable_pub, "rows": normalized}).encode()).hexdigest()
    return pub, normalized, digest, "mgp1-" + digest


def _constraint_key(row):
    identity = [
        row["constraint_id"],
        row["constraint_name"],
        row["contingency_name"],
        row["from_station"],
        row["to_station"],
        row["from_station_kv"],
        row["to_station_kv"],
    ]
    return hashlib.sha256(_canonical(identity).encode()).hexdigest()[:24]


def _normalize_rows(product, rows):
    output = []
    seen = set()
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError("invalid_market_geography_row")
        if product == "NP6-788-CD":
            expected = {"raw_sced_timestamp", "repeated_hour_flag", "target_ts", "settlement_point", "lmp"}
            if set(raw) != expected or not isinstance(raw.get("repeated_hour_flag"), bool):
                raise ValueError("invalid_market_geography_row")
            target = sced_target_ts(raw.get("raw_sced_timestamp"), raw["repeated_hour_flag"])
            row = {
                "target_ts": target,
                "raw_sced_timestamp": raw["raw_sced_timestamp"],
                "repeated_hour_flag": raw["repeated_hour_flag"],
                "settlement_point": _text(raw.get("settlement_point"), "settlement_point", 256),
                "lmp": _finite(raw.get("lmp")),
            }
            identity = (target, row["settlement_point"])
        elif product == "NP6-905-CD":
            expected = {
                "raw_delivery_date",
                "delivery_hour",
                "delivery_interval",
                "raw_dst_flag",
                "repeated_hour_flag",
                "target_ts",
                "settlement_point",
                "settlement_point_type",
                "settlement_point_price",
            }
            if (
                set(raw) != expected
                or raw.get("raw_dst_flag") not in ("N", "Y")
                or not isinstance(raw.get("repeated_hour_flag"), bool)
                or raw["repeated_hour_flag"] != (raw["raw_dst_flag"] == "Y")
            ):
                raise ValueError("invalid_market_geography_row")
            target = market_interval_target_ts(
                raw.get("raw_delivery_date"),
                raw.get("delivery_hour"),
                raw.get("delivery_interval"),
                raw["repeated_hour_flag"],
            )
            row = {
                "target_ts": target,
                "raw_delivery_date": raw["raw_delivery_date"],
                "delivery_hour": raw["delivery_hour"],
                "delivery_interval": raw["delivery_interval"],
                "raw_dst_flag": raw["raw_dst_flag"],
                "repeated_hour_flag": raw["repeated_hour_flag"],
                "settlement_point": _text(raw.get("settlement_point"), "settlement_point", 256),
                "settlement_point_type": _text(raw.get("settlement_point_type"), "settlement_point_type", 32),
                "settlement_point_price": _finite(raw.get("settlement_point_price")),
            }
            identity = (target, row["settlement_point"], row["settlement_point_type"])
        else:
            expected = {
                "raw_sced_timestamp",
                "repeated_hour_flag",
                "target_ts",
                "constraint_id",
                "constraint_name",
                "contingency_name",
                "shadow_price",
                "max_shadow_price",
                "limit_mw",
                "value_mw",
                "violated_mw",
                "from_station",
                "to_station",
                "from_station_kv",
                "to_station_kv",
                "cct_status",
            }
            if (
                set(raw) != expected
                or not isinstance(raw.get("repeated_hour_flag"), bool)
                or raw.get("cct_status") not in ("COMP", "NONCOMP")
            ):
                raise ValueError("invalid_market_geography_row")
            target = sced_target_ts(raw.get("raw_sced_timestamp"), raw["repeated_hour_flag"])
            constraint_id = _text(raw.get("constraint_id"), "constraint_id", 64)
            if re.fullmatch(r"-?\d+(?:\.\d+)?", constraint_id) is None:
                raise ValueError("invalid_market_geography_constraint_id")
            row = {
                "target_ts": target,
                "raw_sced_timestamp": raw["raw_sced_timestamp"],
                "repeated_hour_flag": raw["repeated_hour_flag"],
                "constraint_id": constraint_id,
                "constraint_name": _text(raw.get("constraint_name"), "constraint_name"),
                "contingency_name": _text(raw.get("contingency_name"), "contingency_name"),
                "shadow_price": _finite(raw.get("shadow_price")),
                "max_shadow_price": _finite(raw.get("max_shadow_price")),
                "limit_mw": _finite(raw.get("limit_mw")),
                "value_mw": _finite(raw.get("value_mw")),
                "violated_mw": _finite(raw.get("violated_mw")),
                "from_station": _text(raw.get("from_station"), "from_station", 256),
                "to_station": _text(raw.get("to_station"), "to_station", 256),
                "from_station_kv": _finite(raw.get("from_station_kv")),
                "to_station_kv": _finite(raw.get("to_station_kv")),
                "cct_status": raw["cct_status"],
            }
            row["constraint_key"] = _constraint_key(row)
            identity = (target, row["constraint_key"])
        if raw.get("target_ts") != target or identity in seen:
            raise ValueError("invalid_market_geography_target")
        seen.add(identity)
        output.append(row)
    if product in ("NP6-788-CD", "NP6-905-CD") and len({row["target_ts"] for row in output}) != 1:
        raise ValueError("invalid_market_geography_snapshot")
    return sorted(output, key=lambda row: tuple(str(value) for value in (row["target_ts"], *row.values())))


def _insert_rows(conn, publication_id, product, rows):
    if product == "NP6-788-CD":
        conn.executemany(
            "INSERT INTO market_geography_lmp_rows VALUES(?,?,?,?,?,?)",
            [
                (
                    publication_id,
                    row["target_ts"],
                    row["raw_sced_timestamp"],
                    int(row["repeated_hour_flag"]),
                    row["settlement_point"],
                    row["lmp"],
                )
                for row in rows
            ],
        )
    elif product == "NP6-905-CD":
        conn.executemany(
            "INSERT INTO market_geography_price_rows VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    publication_id,
                    row["target_ts"],
                    row["raw_delivery_date"],
                    row["delivery_hour"],
                    row["delivery_interval"],
                    row["raw_dst_flag"],
                    int(row["repeated_hour_flag"]),
                    row["settlement_point"],
                    row["settlement_point_type"],
                    row["settlement_point_price"],
                )
                for row in rows
            ],
        )
    else:
        conn.executemany(
            "INSERT INTO market_geography_constraint_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    publication_id,
                    row["target_ts"],
                    row["raw_sced_timestamp"],
                    int(row["repeated_hour_flag"]),
                    row["constraint_id"],
                    row["constraint_name"],
                    row["contingency_name"],
                    row["shadow_price"],
                    row["max_shadow_price"],
                    row["limit_mw"],
                    row["value_mw"],
                    row["violated_mw"],
                    row["from_station"],
                    row["to_station"],
                    row["from_station_kv"],
                    row["to_station_kv"],
                    row["cct_status"],
                    row["constraint_key"],
                )
                for row in rows
            ],
        )


def _source(pub, row):
    result = {
        "source_id": pub["source_id"],
        "product_id": pub["product_id"],
        "content_key": pub["content_key"],
        "document_id": pub["document_id"],
        "issued_at": pub["issued_at"],
        "retrieved_at": pub["retrieved_at"],
        "raw_publish_datetime": pub["raw_publish_datetime"],
        "repeated_hour_flag": bool(row["repeated_hour_flag"]),
    }
    if "raw_sced_timestamp" in row:
        result["raw_sced_timestamp"] = row["raw_sced_timestamp"]
    else:
        result.update(
            {
                "raw_delivery_date": row["raw_delivery_date"],
                "delivery_hour": row["delivery_hour"],
                "delivery_interval": row["delivery_interval"],
                "raw_dst_flag": row["raw_dst_flag"],
            }
        )
    return result


def _store_resource(conn, kind, identity, day_start, unit, rows, now, extra=None):
    payload = {
        "schema_version": 1,
        "kind": kind,
        "identity": identity,
        "methodology": METHODOLOGY,
        "tile_span": "1d",
        "tile_start": day_start,
        "tile_end": day_start + DAY,
        "lod": "native",
        "unit": unit,
        "rows": rows,
        **(extra or {}),
    }
    version = "mgr1-" + hashlib.sha256(_canonical(payload).encode()).hexdigest()
    payload["content_version"] = version
    serialized = _canonical(payload)
    conn.execute(
        "INSERT OR IGNORE INTO market_geography_resources VALUES(?,?,?,?,?,?,NULL)",
        (kind, identity, day_start, version, serialized, now),
    )
    prior = conn.execute(
        "SELECT content_version FROM market_geography_current WHERE kind=? AND identity=? AND day_start=?",
        (kind, identity, day_start),
    ).fetchone()
    if prior and prior[0] != version:
        conn.execute(
            "UPDATE market_geography_resources SET retired_at=COALESCE(retired_at,?) WHERE kind=? AND identity=? AND day_start=? AND content_version=?",
            (now, kind, identity, day_start, prior[0]),
        )
    conn.execute(
        """INSERT INTO market_geography_current VALUES(?,?,?,?,?)
           ON CONFLICT(kind,identity,day_start) DO UPDATE SET
             content_version=excluded.content_version,updated_at=excluded.updated_at""",
        (kind, identity, day_start, version, now),
    )
    return {"kind": kind, "identity": identity, "day_start": day_start, "content_version": version}


def _selected_lmp_rows(conn, day_start):
    rows = conn.execute(
        """SELECT target_ts,raw_sced_timestamp,repeated_hour_flag,settlement_point,lmp,
                  source_id,product_id,content_key,document_id,issued_at,retrieved_at,raw_publish_datetime
           FROM (
             SELECT r.target_ts,r.raw_sced_timestamp,r.repeated_hour_flag,r.settlement_point,r.lmp,
                    p.source_id,p.product_id,p.content_key,p.document_id,p.issued_at,p.retrieved_at,p.raw_publish_datetime,
                    ROW_NUMBER() OVER(PARTITION BY r.target_ts,r.settlement_point
                      ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC) rank
             FROM market_geography_lmp_rows r JOIN market_geography_publications p ON p.id=r.publication_id
             WHERE r.target_ts>=? AND r.target_ts<?
           ) WHERE rank=1 ORDER BY target_ts,settlement_point""",
        (day_start, day_start + DAY),
    ).fetchall()
    return [
        {
            "target_ts": row[0],
            "raw_sced_timestamp": row[1],
            "repeated_hour_flag": bool(row[2]),
            "settlement_point": row[3],
            "value": row[4],
            "source": {
                "source_id": row[5],
                "product_id": row[6],
                "content_key": row[7],
                "document_id": row[8],
                "issued_at": row[9],
                "retrieved_at": row[10],
                "raw_publish_datetime": row[11],
                "raw_sced_timestamp": row[1],
                "repeated_hour_flag": bool(row[2]),
            },
        }
        for row in rows
    ]


def _selected_price_rows(conn, day_start):
    rows = conn.execute(
        """SELECT target_ts,raw_delivery_date,delivery_hour,delivery_interval,raw_dst_flag,repeated_hour_flag,
                  settlement_point,settlement_point_type,settlement_point_price,
                  source_id,product_id,content_key,document_id,issued_at,retrieved_at,raw_publish_datetime
           FROM (
             SELECT r.*,p.source_id,p.product_id,p.content_key,p.document_id,p.issued_at,p.retrieved_at,p.raw_publish_datetime,
                    ROW_NUMBER() OVER(PARTITION BY r.target_ts,r.settlement_point,r.settlement_point_type
                      ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC) rank
             FROM market_geography_price_rows r JOIN market_geography_publications p ON p.id=r.publication_id
             WHERE r.target_ts>=? AND r.target_ts<?
           ) WHERE rank=1 ORDER BY target_ts,settlement_point,settlement_point_type""",
        (day_start, day_start + DAY),
    ).fetchall()
    return [
        {
            "target_ts": row[0],
            "raw_delivery_date": row[1],
            "delivery_hour": row[2],
            "delivery_interval": row[3],
            "raw_dst_flag": row[4],
            "repeated_hour_flag": bool(row[5]),
            "settlement_point": row[6],
            "settlement_point_type": row[7],
            "value": row[8],
            "source": {
                "source_id": row[9],
                "product_id": row[10],
                "content_key": row[11],
                "document_id": row[12],
                "issued_at": row[13],
                "retrieved_at": row[14],
                "raw_publish_datetime": row[15],
                "raw_delivery_date": row[1],
                "delivery_hour": row[2],
                "delivery_interval": row[3],
                "raw_dst_flag": row[4],
                "repeated_hour_flag": bool(row[5]),
            },
        }
        for row in rows
    ]


def _selected_constraint_rows(conn, day_start):
    columns = "target_ts,raw_sced_timestamp,repeated_hour_flag,constraint_id,constraint_name,contingency_name,shadow_price,max_shadow_price,limit_mw,value_mw,violated_mw,from_station,to_station,from_station_kv,to_station_kv,cct_status,constraint_key,source_id,product_id,content_key,document_id,issued_at,retrieved_at,raw_publish_datetime"
    rows = conn.execute(
        f"""SELECT {columns} FROM (
          SELECT r.*,p.source_id,p.product_id,p.content_key,p.document_id,p.issued_at,p.retrieved_at,p.raw_publish_datetime,
            ROW_NUMBER() OVER(PARTITION BY r.target_ts,r.constraint_key
              ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC) rank
          FROM market_geography_constraint_rows r JOIN market_geography_publications p ON p.id=r.publication_id
          WHERE r.target_ts>=? AND r.target_ts<?) WHERE rank=1 ORDER BY target_ts,constraint_key""",
        (day_start, day_start + DAY),
    ).fetchall()
    names = columns.split(",")
    output = []
    for values in rows:
        row = dict(zip(names, values))
        row["repeated_hour_flag"] = bool(row["repeated_hour_flag"])
        source = {
            key: row[key]
            for key in (
                "source_id",
                "product_id",
                "content_key",
                "document_id",
                "issued_at",
                "retrieved_at",
                "raw_publish_datetime",
                "raw_sced_timestamp",
                "repeated_hour_flag",
            )
        }
        for key in ("source_id", "product_id", "content_key", "document_id", "issued_at", "retrieved_at", "raw_publish_datetime"):
            del row[key]
        row["cct_status_label"] = (
            "competitive" if row["cct_status"] == "COMP" else "non-competitive"
        )
        row["source"] = source
        output.append(row)
    return output


def materialize_market_geography_day(conn, day_start, current_ts=None):
    now = int(time.time()) if current_ts is None else current_ts
    if not isinstance(day_start, int) or isinstance(day_start, bool) or day_start % DAY or day_start >= (now // DAY) * DAY:
        raise ValueError("invalid_market_geography_day")
    resources = []
    price_rows = _selected_price_rows(conn, day_start)
    for point, point_type in DISPLAY_POINTS:
        selected = [row for row in price_rows if row["settlement_point"] == point and row["settlement_point_type"] == point_type]
        if selected:
            resources.append(_store_resource(conn, "prices", f"{point}--{point_type}", day_start, "$/MWh", selected, now))
    lmp_rows = _selected_lmp_rows(conn, day_start)
    for point in sorted(LMP_POINT_SET):
        selected = [row for row in lmp_rows if row["settlement_point"] == point]
        if selected:
            resources.append(_store_resource(conn, "lmp", point, day_start, "$/MWh", selected, now))
    constraint_rows = _selected_constraint_rows(conn, day_start)
    maxima = {}
    for row in constraint_rows:
        maxima[row["constraint_key"]] = max(maxima.get(row["constraint_key"], 0), abs(row["shadow_price"]))
    selected_keys = [key for key, _value in sorted(maxima.items(), key=lambda item: (-item[1], item[0]))[:MAX_CONSTRAINTS]]
    for key in selected_keys:
        selected = [row for row in constraint_rows if row["constraint_key"] == key]
        resources.append(
            _store_resource(
                conn,
                "constraints",
                key,
                day_start,
                "mixed_reviewed_fields",
                selected,
                now,
                {
                    "attribution_status": "unavailable_without_shift_factors",
                    "attribution_policy": "coincident_constraint_not_point_price_attribution",
                },
            )
        )
    return resources


def _seal_previous_day(conn, now):
    day_start = (now // DAY - 1) * DAY
    has_pointer = conn.execute(
        "SELECT 1 FROM market_geography_current WHERE day_start=? LIMIT 1", (day_start,)
    ).fetchone()
    has_rows = any(
        conn.execute(f"SELECT 1 FROM {table} WHERE target_ts>=? AND target_ts<? LIMIT 1", (day_start, day_start + DAY)).fetchone()
        for table in (
            "market_geography_lmp_rows",
            "market_geography_price_rows",
            "market_geography_constraint_rows",
        )
    )
    return [] if has_pointer or not has_rows else materialize_market_geography_day(conn, day_start, now)


def _record_materialization(conn, now, success, error=None):
    conn.execute(
        """INSERT INTO market_geography_materialization_health
           (id,last_attempt_ts,last_success_ts,consecutive_failures,last_error) VALUES(1,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             last_attempt_ts=excluded.last_attempt_ts,
             last_success_ts=CASE WHEN excluded.last_success_ts IS NULL THEN market_geography_materialization_health.last_success_ts ELSE excluded.last_success_ts END,
             consecutive_failures=CASE WHEN excluded.last_success_ts IS NULL THEN market_geography_materialization_health.consecutive_failures+1 ELSE 0 END,
             last_error=excluded.last_error""",
        (now, now if success else None, 0 if success else 1, error),
    )


def ingest_market_geography_publication(conn, payload, current_ts=None):
    now = int(time.time()) if current_ts is None else current_ts
    pub, rows, digest, content_key = _publication(payload, now)
    conn.execute("BEGIN IMMEDIATE")
    materializing = False
    try:
        prior = conn.execute(
            "SELECT id,content_hash,row_count FROM market_geography_publications WHERE source_id=? AND product_id=? AND publication_key=?",
            (pub["source_id"], pub["product_id"], pub["publication_key"]),
        ).fetchone()
        status = "unchanged"
        if prior:
            if prior[1:] != (digest, len(rows)):
                raise ValueError("market_geography_publication_collision")
            publication_id = prior[0]
        else:
            cursor = conn.execute(
                """INSERT INTO market_geography_publications
                 (source_id,product_id,publication_key,content_key,issued_at,retrieved_at,raw_publish_datetime,
                  document_id,constructed_name,artifact_href,schema_fingerprint,parser_schema_version,
                  content_hash,row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    pub["source_id"],
                    pub["product_id"],
                    pub["publication_key"],
                    content_key,
                    pub["issued_at"],
                    pub["retrieved_at"],
                    pub["raw_publish_datetime"],
                    pub["document_id"],
                    pub["constructed_name"],
                    pub["artifact_href"],
                    pub["schema_fingerprint"],
                    pub["parser_schema_version"],
                    digest,
                    len(rows),
                    now,
                ),
            )
            publication_id = cursor.lastrowid
            _insert_rows(conn, publication_id, pub["product_id"], rows)
            status = "inserted"
        materializing = True
        resources = []
        completed = sorted({row["target_ts"] // DAY * DAY for row in rows if row["target_ts"] < (now // DAY) * DAY})
        for day_start in completed:
            resources.extend(materialize_market_geography_day(conn, day_start, now))
        resources.extend(_seal_previous_day(conn, now))
        _record_materialization(conn, now, True)
        prune_market_geography(conn, now, 250, in_transaction=True)
        conn.commit()
        return {
            "status": status,
            "publication_key": content_key,
            "row_count": len(rows),
            "resources": resources,
        }
    except Exception:
        conn.rollback()
        if materializing:
            _record_materialization(conn, now, False, "market_geography_materialization_failed")
            conn.commit()
        raise


def _publication_record(row):
    return {
        "source_id": row[0],
        "product_id": row[1],
        "content_key": row[2],
        "document_id": row[3],
        "issued_at": row[4],
        "retrieved_at": row[5],
        "raw_publish_datetime": row[6],
    }


def _latest_publication(conn, product):
    return conn.execute(
        """SELECT id,source_id,product_id,content_key,document_id,issued_at,retrieved_at,raw_publish_datetime
           FROM market_geography_publications WHERE product_id=?
           ORDER BY issued_at DESC,LENGTH(document_id) DESC,document_id DESC LIMIT 1""",
        (product,),
    ).fetchone()


def _current_price_snapshot(conn):
    publication = _latest_publication(conn, "NP6-905-CD")
    if publication is None:
        return {"state": "unavailable", "target_ts": None, "rows": [], "reference_prices": [], "missing": [f"{point}--{kind}" for point, kind in DISPLAY_POINTS]}
    rows = conn.execute(
        """SELECT target_ts,raw_delivery_date,delivery_hour,delivery_interval,raw_dst_flag,repeated_hour_flag,
                  settlement_point,settlement_point_type,settlement_point_price
           FROM market_geography_price_rows WHERE publication_id=?
           ORDER BY settlement_point,settlement_point_type""",
        (publication[0],),
    ).fetchall()
    source = _publication_record(publication[1:])
    target = rows[0][0] if rows else None
    selected = []
    references = []
    seen = set()
    for row in rows:
        identity = (row[6], row[7])
        if identity not in DISPLAY_POINT_SET:
            continue
        item = {
            "target_ts": row[0],
            "raw_delivery_date": row[1],
            "delivery_hour": row[2],
            "delivery_interval": row[3],
            "raw_dst_flag": row[4],
            "repeated_hour_flag": bool(row[5]),
            "settlement_point": row[6],
            "settlement_point_type": row[7],
            "value": row[8],
            "unit": "$/MWh",
        }
        seen.add(identity)
        (selected if identity in set(HEATMAP_POINTS) else references).append(item)
    missing = [f"{point}--{kind}" for point, kind in DISPLAY_POINTS if (point, kind) not in seen]
    return {
        "state": "available" if not missing else "partial",
        "target_ts": target,
        "source": source,
        "rows": selected,
        "reference_prices": references,
        "missing": missing,
        "coherence": "single_np6_905_publication_interval",
    }


def _current_lmp_snapshot(conn):
    publication = _latest_publication(conn, "NP6-788-CD")
    if publication is None:
        return {"state": "unavailable", "target_ts": None, "rows": [], "missing": sorted(LMP_POINT_SET)}
    rows = conn.execute(
        "SELECT target_ts,raw_sced_timestamp,repeated_hour_flag,settlement_point,lmp FROM market_geography_lmp_rows WHERE publication_id=? ORDER BY settlement_point",
        (publication[0],),
    ).fetchall()
    source = _publication_record(publication[1:])
    selected = [
        {
            "target_ts": row[0],
            "raw_sced_timestamp": row[1],
            "repeated_hour_flag": bool(row[2]),
            "settlement_point": row[3],
            "value": row[4],
            "unit": "$/MWh",
        }
        for row in rows
        if row[3] in LMP_POINT_SET
    ]
    seen = {row["settlement_point"] for row in selected}
    missing = sorted(LMP_POINT_SET - seen)
    return {
        "state": "available" if selected and not missing else ("partial" if selected else "unavailable"),
        "target_ts": rows[0][0] if rows else None,
        "source": source,
        "rows": selected,
        "missing": missing,
        "coherence": "single_np6_788_publication_sced",
    }


def _coincident_constraints(conn, target_ts):
    if target_ts is None:
        return {"state": "unavailable", "target_ts": None, "rows": [], "total_count": 0, "truncated": False}
    publication = conn.execute(
        """SELECT DISTINCT p.id,p.source_id,p.product_id,p.content_key,p.document_id,p.issued_at,p.retrieved_at,p.raw_publish_datetime
           FROM market_geography_publications p JOIN market_geography_constraint_rows r ON r.publication_id=p.id
           WHERE p.product_id='NP6-86-CD' AND r.target_ts=?
           ORDER BY p.issued_at DESC,LENGTH(p.document_id) DESC,p.document_id DESC LIMIT 1""",
        (target_ts,),
    ).fetchone()
    if publication is None:
        return {"state": "unavailable_no_exact_sced", "target_ts": target_ts, "rows": [], "total_count": 0, "truncated": False}
    rows = conn.execute(
        """SELECT constraint_key,constraint_id,constraint_name,contingency_name,shadow_price,max_shadow_price,
                  limit_mw,value_mw,violated_mw,from_station,to_station,from_station_kv,to_station_kv,cct_status,
                  raw_sced_timestamp,repeated_hour_flag
           FROM market_geography_constraint_rows WHERE publication_id=? AND target_ts=?
           ORDER BY ABS(shadow_price) DESC,constraint_key LIMIT ?""",
        (publication[0], target_ts, MAX_CONSTRAINTS + 1),
    ).fetchall()
    total = conn.execute(
        "SELECT COUNT(*) FROM market_geography_constraint_rows WHERE publication_id=? AND target_ts=?",
        (publication[0], target_ts),
    ).fetchone()[0]
    output = [
        {
            "constraint_key": row[0],
            "constraint_id": row[1],
            "constraint_name": row[2],
            "contingency_name": row[3],
            "shadow_price": row[4],
            "max_shadow_price": row[5],
            "limit_mw": row[6],
            "value_mw": row[7],
            "violated_mw": row[8],
            "from_station": row[9],
            "to_station": row[10],
            "from_station_kv": row[11],
            "to_station_kv": row[12],
            "cct_status": row[13],
            "cct_status_label": "competitive" if row[13] == "COMP" else "non-competitive",
            "raw_sced_timestamp": row[14],
            "repeated_hour_flag": bool(row[15]),
            "target_ts": target_ts,
        }
        for row in rows[:MAX_CONSTRAINTS]
    ]
    return {
        "state": "available" if output else "valid_empty",
        "target_ts": target_ts,
        "source": _publication_record(publication[1:]),
        "rows": output,
        "total_count": total,
        "truncated": total > MAX_CONSTRAINTS,
        "alignment": "exact_same_sced_as_lmp_snapshot",
        "attribution_status": "unavailable_without_shift_factors",
        "attribution_policy": "coincident_constraint_not_point_price_attribution",
    }


def _health(conn, now):
    source_ids = tuple(contract["source"] for contract in CONTRACTS.values())
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_sources'").fetchone():
        return [{"source_id": source_id, "state": "unavailable", "availability_status": "unavailable", "last_success_ts": None, "data_timestamp_ts": None, "data_age_seconds": None, "consecutive_failures": None, "gap_count": 0, "last_error": "never_reported"} for source_id in source_ids]
    placeholders = ",".join("?" for _ in source_ids)
    rows = conn.execute(
        f"SELECT source_id,last_success_ts,data_timestamp_ts,consecutive_failures,last_error,availability_status,expected_interval_seconds,diagnostics_json FROM collector_sources WHERE source_id IN ({placeholders}) ORDER BY source_id",
        source_ids,
    ).fetchall()
    output = []
    for source_id, success, data_ts, failures, error, availability, expected, diagnostics_json in rows:
        age = None if data_ts is None else max(0, now - data_ts)
        expected = int(expected or 300)
        try:
            diagnostics = {} if not diagnostics_json else json.loads(diagnostics_json)
        except (TypeError, ValueError):
            diagnostics = {}
        raw_gap_count = diagnostics.get("gap_count", 0) if isinstance(diagnostics, dict) else 0
        gap_count = raw_gap_count if isinstance(raw_gap_count, int) and not isinstance(raw_gap_count, bool) and 0 <= raw_gap_count <= 10_000 else 0
        state = "failed" if success is None or int(failures or 0) else ("stale" if age is None or age > expected * 4 else ("delayed" if gap_count else "healthy"))
        output.append({"source_id": source_id, "state": state, "availability_status": availability or "unavailable", "last_success_ts": success, "data_timestamp_ts": data_ts, "data_age_seconds": age, "consecutive_failures": int(failures or 0), "gap_count": gap_count, "last_error": "document_gap" if gap_count else error})
    present = {item["source_id"] for item in output}
    output.extend({"source_id": source_id, "state": "unavailable", "availability_status": "unavailable", "last_success_ts": None, "data_timestamp_ts": None, "data_age_seconds": None, "consecutive_failures": None, "gap_count": 0, "last_error": "never_reported"} for source_id in source_ids if source_id not in present)
    return sorted(output, key=lambda item: item["source_id"])


def market_geography_manifest(conn, now=None):
    current = int(time.time()) if now is None else now
    price = _current_price_snapshot(conn)
    lmp = _current_lmp_snapshot(conn)
    constraints = _coincident_constraints(conn, lmp.get("target_ts"))
    links = [
        {
            "kind": row[0],
            "identity": row[1],
            "tile_start": row[2],
            "content_version": row[3],
            "lod": "native",
            "url": f"/api/v2/market-geography/{row[0]}/{row[1]}/v1/{row[3]}/1d/{row[2]}/native",
        }
        for row in conn.execute(
            "SELECT kind,identity,day_start,content_version FROM market_geography_current WHERE day_start>=? AND day_start<? ORDER BY kind,identity,day_start",
            ((current // DAY - 35) * DAY, (current // DAY) * DAY),
        )
    ]
    materialization_row = conn.execute(
        "SELECT last_attempt_ts,last_success_ts,consecutive_failures,last_error FROM market_geography_materialization_health WHERE id=1"
    ).fetchone()
    materialization = (
        {"state": "unavailable", "last_attempt_ts": None, "last_success_ts": None, "consecutive_failures": None, "last_error": "never_run"}
        if materialization_row is None
        else {
            "state": "failed" if materialization_row[2] else "healthy",
            "last_attempt_ts": materialization_row[0],
            "last_success_ts": materialization_row[1],
            "consecutive_failures": materialization_row[2],
            "last_error": materialization_row[3],
        }
    )
    return {
        "schema_version": 1,
        "kind": "market_geography_manifest",
        "methodology": METHODOLOGY,
        "as_of": current,
        "visualization_policy": "settlement_price_matrix_not_geographic_boundaries",
        "attribution_status": "unavailable_without_shift_factors",
        "attribution_policy": "coincident_constraint_not_point_price_attribution",
        "settlement_interval": price,
        "lmp_snapshot": lmp,
        "constraints": constraints,
        "source_health": _health(conn, current),
        "materialization_health": materialization,
        "resources": links,
        "deferred": {
            "nodal_map": "no_reviewed_node_geometry",
            "constraint_lines": "no_reviewed_station_geometry",
        },
    }


def market_geography_resource(conn, kind, identity, version, content_version, day_start, lod):
    if (
        kind not in ("prices", "lmp", "constraints")
        or version != "v1"
        or lod != "native"
        or not isinstance(day_start, int)
        or day_start % DAY
        or re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", identity) is None
        or re.fullmatch(r"mgr1-[0-9a-f]{64}", content_version) is None
    ):
        raise ValueError("invalid_market_geography_resource")
    row = conn.execute(
        "SELECT payload_json FROM market_geography_resources WHERE kind=? AND identity=? AND day_start=? AND content_version=?",
        (kind, identity, day_start, content_version),
    ).fetchone()
    return None if row is None else json.loads(row[0])


def prune_market_geography(conn, now=None, batch_size=500, in_transaction=False):
    current = int(time.time()) if now is None else now
    if not isinstance(batch_size, int) or isinstance(batch_size, bool) or not 1 <= batch_size <= 1_000:
        raise ValueError("invalid_market_geography_prune")
    cutoff = current - RETENTION_SECONDS
    if not in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        pointers = conn.execute(
            "SELECT kind,identity,day_start,content_version FROM market_geography_current WHERE day_start<? ORDER BY day_start,kind,identity LIMIT ?",
            ((cutoff // DAY) * DAY, batch_size),
        ).fetchall()
        for kind, identity, day_start, version in pointers:
            conn.execute(
                "UPDATE market_geography_resources SET retired_at=COALESCE(retired_at,?) WHERE kind=? AND identity=? AND day_start=? AND content_version=?",
                (current, kind, identity, day_start, version),
            )
        conn.executemany(
            "DELETE FROM market_geography_current WHERE kind=? AND identity=? AND day_start=?",
            [(row[0], row[1], row[2]) for row in pointers],
        )
        resources = conn.execute(
            """SELECT kind,identity,day_start,content_version FROM market_geography_resources r
               WHERE retired_at IS NOT NULL AND retired_at<? AND NOT EXISTS(
                 SELECT 1 FROM market_geography_current c WHERE c.kind=r.kind AND c.identity=r.identity
                 AND c.day_start=r.day_start AND c.content_version=r.content_version)
               ORDER BY retired_at,kind,identity,day_start LIMIT ?""",
            (cutoff, batch_size),
        ).fetchall()
        conn.executemany(
            "DELETE FROM market_geography_resources WHERE kind=? AND identity=? AND day_start=? AND content_version=?",
            resources,
        )
        publications = conn.execute(
            "SELECT id,product_id FROM market_geography_publications WHERE created_at<? ORDER BY created_at,id LIMIT ?",
            (cutoff, batch_size),
        ).fetchall()
        for publication_id, product in publications:
            table = {
                "NP6-788-CD": "market_geography_lmp_rows",
                "NP6-905-CD": "market_geography_price_rows",
                "NP6-86-CD": "market_geography_constraint_rows",
            }[product]
            conn.execute(f"DELETE FROM {table} WHERE publication_id=?", (publication_id,))
            conn.execute("DELETE FROM market_geography_publications WHERE id=?", (publication_id,))
        if not in_transaction:
            conn.commit()
        return {"pointers": len(pointers), "resources": len(resources), "publications": len(publications)}
    except Exception:
        if not in_transaction:
            conn.rollback()
        raise
