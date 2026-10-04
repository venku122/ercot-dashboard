"""Validate the campaign issue/stack ledger without network writes."""
import json
from pathlib import Path


def check(root):
    directory = root / "docs/post-release"
    issues = json.loads((directory / "issue-map.json").read_text())["issues"]
    mapping = {row["stable_id"]: row for row in issues}
    expected = {f"ERP-{number:02d}" for number in range(13)}
    if len(issues) != 13 or set(mapping) != expected:
        raise ValueError("missing_or_duplicate_issue_identity")
    numbers = [row["github_issue_number"] for row in issues]
    if len(set(numbers)) != 13 or any(not isinstance(number, int) for number in numbers):
        raise ValueError("missing_or_duplicate_actual_issue")
    for row in issues:
        if row["github_issue_url"] != f'https://github.com/venku122/ercot-dashboard/issues/{row["github_issue_number"]}':
            raise ValueError("invalid_issue_link")
        if any(dependency not in mapping for dependency in row.get("dependency_ids", [])):
            raise ValueError("unmapped_dependency")
    stack = json.loads((directory / "stack.json").read_text())["stack"]
    if [row["slot"] for row in stack] != list(range(1, 13)):
        raise ValueError("invalid_stack_slots")
    if {row["primary_issue_id"] for row in stack} != expected - {"ERP-00"}:
        raise ValueError("invalid_primary_issue_mapping")
    seen = set()
    for index, row in enumerate(stack):
        if row["base_branch"] != ("main" if index == 0 else stack[index - 1]["branch"]):
            raise ValueError("invalid_stack_base")
        if any(dependency not in seen for dependency in row["logical_dependency_ids"]):
            raise ValueError("dependency_after_consumer")
        seen.add(row["primary_issue_id"])
    return len(issues), len(stack)


if __name__ == "__main__":
    print("Verified issues/stack:", check(Path(__file__).resolve().parents[1]))
