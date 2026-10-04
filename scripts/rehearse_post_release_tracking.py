"""Deterministic tracking protocol rehearsal. No network or external-write adapter.

The caller supplies an all-state issue inventory (PRs may be present), create,
and body-update operations. This module's CLI uses only a copied memory store.
Equivalent numbers and closed assessments are explicit caller scope decisions.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

CAMPAIGN = "ercot-post-release-2026-10"
REPOSITORY = "venku122/ercot-dashboard"


def delimiters(stable_id):
    base = f"<!-- {CAMPAIGN}:managed:{stable_id}"
    return base + ":start -->", base + ":end -->"


def managed_bounds(body, stable_id):
    start, end = delimiters(stable_id)
    if start not in body and end not in body:
        return None
    if body.count(start) != 1 or body.count(end) != 1:
        raise ValueError("invalid_managed_section")
    first, last = body.index(start), body.index(end)
    if last < first:
        raise ValueError("invalid_managed_section")
    return first, last + len(end)


def replace_managed(body, seed, mapping):
    stable_id = seed["stable_id"]
    start, end = delimiters(stable_id)
    lines = [start, seed["idempotency_marker"], f"### Managed campaign: {stable_id}"]
    if stable_id != "ERP-00":
        lines.append(f"Parent: https://github.com/{REPOSITORY}/issues/{mapping['ERP-00']}")
    dependencies = seed.get("dependency_ids", [])
    if dependencies:
        lines.append("Dependencies: " + ", ".join(
            f"[{item}](https://github.com/{REPOSITORY}/issues/{mapping[item]})"
            for item in dependencies))
    if seed.get("managed_body"):
        lines.append(seed["managed_body"])
    lines.extend(["Draft work does not close this issue; final human review is required.", end])
    section = "\n".join(lines)
    bounds = managed_bounds(body, stable_id)
    if bounds is not None:
        first, last = bounds
        return body[:first] + section + body[last:]
    return body + ("\n\n" if body and not body.endswith("\n\n") else "") + section


def reconcile(adapter, seeds, *, equivalents=None, assessed_closed=()):
    """Return canonical actual numbers after resolving all links; never change state.

    On an ambiguous create timeout, re-read all states before doing anything else.
    If no persisted issue is found, stop; a later rerun reuses partial progress.
    """
    equivalents = equivalents or {}
    expected = {f"ERP-{i:02d}" for i in range(13)}
    by_id = {row["stable_id"]: row for row in seeds}
    if len(seeds) != 13 or set(by_id) != expected:
        raise ValueError("invalid_campaign_seeds")
    if set(equivalents) - expected:
        raise ValueError("unknown_equivalent")
    for stable_id, seed in by_id.items():
        if seed["idempotency_marker"] != f"<!-- {CAMPAIGN}:{stable_id} -->":
            raise ValueError("invalid_idempotency_marker")
        if set(seed.get("dependency_ids", [])) - expected:
            raise ValueError("unknown_dependency")
        content = seed.get("managed_body", "")
        if not isinstance(content, str) or len(content.encode()) > 256_000 or any(
                delimiter in content for delimiter in delimiters(stable_id)):
            raise ValueError("invalid_prepared_managed_body")

    def inventory():
        rows = [r for r in adapter.list_all_issues() if "pull_request" not in r]
        numbers = [r["number"] for r in rows]
        if len(numbers) != len(set(numbers)):
            raise ValueError("duplicate_issue_number")
        mapping = {}
        for stable_id, seed in by_id.items():
            hits = [r for r in rows if seed["idempotency_marker"] in (r.get("body") or "")]
            if len(hits) > 1:
                raise ValueError("duplicate_issue_marker")
            equivalent = equivalents.get(stable_id)
            if equivalent is not None:
                match = [r for r in rows if r["number"] == equivalent]
                if len(match) != 1 or (hits and hits[0]["number"] != equivalent):
                    raise ValueError("conflicting_equivalent")
                hits = match
            if hits:
                row = hits[0]
                if row.get("state", "OPEN").upper() == "CLOSED" and row["number"] not in assessed_closed:
                    raise ValueError("closed_equivalent_requires_assessment")
                managed_bounds(row.get("body") or "", stable_id)
                mapping[stable_id] = row["number"]
        if len(set(mapping.values())) != len(mapping):
            raise ValueError("equivalent_shared_by_multiple_ids")
        return rows, mapping

    # Validate every existing equivalent before making any creation/body change.
    rows, mapping = inventory()
    for stable_id in sorted(expected):
        if stable_id in mapping:
            continue
        seed = by_id[stable_id]
        try:
            adapter.create_issue(seed["title"], seed["idempotency_marker"])
        except TimeoutError:
            rows, mapping = inventory()
            if stable_id not in mapping:
                raise
        else:
            rows, mapping = inventory()
            if stable_id not in mapping:
                raise ValueError("created_issue_missing_marker")
    # All numbers now exist; resolve parent/dependencies once, preserving human text.
    for stable_id in sorted(expected):
        row = next(r for r in rows if r["number"] == mapping[stable_id])
        original = row.get("body") or ""
        updated = replace_managed(original, by_id[stable_id], mapping)
        if updated != original:
            adapter.update_body(row["number"], updated)
    return mapping


class MemoryIssues:
    """CLI-only synthetic store: copies input; records no changes outside memory."""
    def __init__(self, rows=(), lost_response_at=None):
        self.rows = copy.deepcopy(list(rows))
        self.created = 0
        self.edited = 0
        self.lost_response_at = lost_response_at

    def list_all_issues(self):
        return copy.deepcopy(self.rows)

    def create_issue(self, title, body):
        self.created += 1
        row = {"number": max([r["number"] for r in self.rows] + [59]) + 1,
               "title": title, "body": body, "state": "OPEN", "comments": []}
        self.rows.append(row)
        if self.created == self.lost_response_at:
            raise TimeoutError("injected lost response after persistence")
        return copy.deepcopy(row)

    def update_body(self, number, body):
        self.edited += 1
        next(r for r in self.rows if r["number"] == number)["body"] = body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--issue-map", type=Path,
                        default=Path(__file__).resolve().parents[1] / "docs/post-release/issue-map.json")
    parser.add_argument("--specification-directory", type=Path,
                        help="Explicit prepared directive pack; copied into simulated managed sections only")
    args = parser.parse_args()
    payload = args.issue_map.read_bytes()
    seeds = json.loads(payload)["issues"]
    if args.specification_directory:
        directory = args.specification_directory.resolve()
        for seed in seeds:
            source = (directory / seed["body_file"]).resolve()
            if not source.is_relative_to(directory):
                raise ValueError("specification_path_outside_pack")
            seed["managed_body"] = source.read_text()
    marker = next(r for r in seeds if r["stable_id"] == "ERP-01")["idempotency_marker"]
    human = {"number": 10_000, "title": "Synthetic pre-existing human title",
             "body": "Synthetic human prefix\n" + marker, "state": "CLOSED",
             "comments": [{"id": 1, "body": "Synthetic preserved discussion"}]}
    store = MemoryIssues([human], lost_response_at=5)
    mapping = reconcile(store, seeds, assessed_closed={10_000})
    first = copy.deepcopy(store.rows)
    writes = (store.created, store.edited)
    rerun = reconcile(store, seeds, assessed_closed={10_000})
    preserved = next(r for r in store.rows if r["number"] == 10_000)
    assert mapping == rerun and first == store.rows and writes == (store.created, store.edited)
    assert preserved["body"].startswith(human["body"])
    assert all(preserved[key] == human[key] for key in ["title", "state", "comments"])
    print(json.dumps({"mode": "SIMULATED_PROTOCOL_REHEARSAL", "external_requests": 0,
                      "external_writes": 0, "historical_bootstrap_proof": "UNAVAILABLE",
                      "historical_human_text_preservation": "UNPROVEN_WITHOUT_BEFORE_SNAPSHOT",
                      "seeds_sha256": hashlib.sha256(payload).hexdigest(),
                      "prepared_managed_specifications": sum(bool(s.get("managed_body")) for s in seeds),
                      "managed_specification_sha256": {s["stable_id"]: hashlib.sha256(
                          s["managed_body"].encode()).hexdigest() for s in seeds if s.get("managed_body")},
                      "canonical_issue_count": len(mapping), "synthetic_mapping": mapping,
                      "lost_create_response_recovered": True, "rerun_writes": 0,
                      "synthetic_human_body_title_state_comments_preserved": True}, indent=2))


if __name__ == "__main__":
    main()
