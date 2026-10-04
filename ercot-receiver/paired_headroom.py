"""Observed Supply and Demand pairing before any generic chart aggregation.

Only exact normalized source identities participate. Duplicate observations at
an epoch are ambiguous and withheld, rather than creating Cartesian pairs.
No generic derived resource is written to SQLite.
"""

POLICY = "supply-demand-observed-exact-epoch-v1"
METRIC = "ercot.supply_demand.paired_headroom_mw"
KEY = "supply-demand.paired-headroom"
CONTRIBUTORS = (
    {"metric": "ercot.supply_demand.available_capacity_mw", "tags": ["source:supply_demand"]},
    {"metric": "ercot.supply_demand.demand_mw", "tags": ["source:supply_demand"]},
)
CONTRACT = {"policy": POLICY, "contributors": list(CONTRIBUTORS)}

PAIRED_SQL = """
WITH capacity AS (
 SELECT ts, MIN(value) value, COUNT(*) n FROM metrics
 WHERE series_id=? AND ts>=? AND ts<? GROUP BY ts
), demand AS (
 SELECT ts, MIN(value) value, COUNT(*) n FROM metrics
 WHERE series_id=? AND ts>=? AND ts<? GROUP BY ts
), epochs AS (SELECT ts FROM capacity UNION SELECT ts FROM demand)
SELECT e.ts,c.value,d.value,COALESCE(c.n,0),COALESCE(d.n,0)
FROM epochs e LEFT JOIN capacity c ON c.ts=e.ts LEFT JOIN demand d ON d.ts=e.ts
ORDER BY e.ts
"""


def paired_points(conn, start, end, canonical_tags):
    ids = []
    for contributor in CONTRIBUTORS:
        row = conn.execute(
            "SELECT id FROM series WHERE metric_name=? AND tags_json=?",
            (contributor["metric"], canonical_tags(contributor["tags"])),
        ).fetchone()
        ids.append(None if row is None else int(row[0]))
    rows = conn.execute(PAIRED_SQL, (ids[0], start, end, ids[1], start, end)).fetchall()
    points = [[ts, capacity - demand, 0] for ts, capacity, demand, nc, nd in rows if nc == nd == 1]
    ambiguous = sum(nc > 1 or nd > 1 for _, _, _, nc, nd in rows)
    metadata = {
        "policy": POLICY,
        "paired_count": len(points),
        "expected_count": (end - start) // 300,
        "unpaired_count": len(rows) - len(points),
        "ambiguous_count": ambiguous,
        "first_observed_ts": points[0][0] if points else None,
        "last_observed_ts": points[-1][0] if points else None,
        "collection_history": "first_collection_time_not_recorded",
        "reason": "missing_compatible_contributor" if None in ids else ("no_matching_native_epochs" if not points else None),
    }
    return points, [identity for identity in ids if identity is not None], metadata
