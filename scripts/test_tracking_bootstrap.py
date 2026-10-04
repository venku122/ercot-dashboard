"""Protocol tests use a deterministic issue store; never a GitHub connection."""
import copy
import importlib.util
import unittest


def implementation():
    spec = importlib.util.find_spec("rehearse_post_release_tracking")
    assert spec is not None, "missing deterministic tracking reconciliation protocol"
    import rehearse_post_release_tracking
    return rehearse_post_release_tracking


def seeds():
    return [{"stable_id": f"ERP-{i:02d}", "title": f"Campaign {i}",
             "idempotency_marker": f"<!-- ercot-post-release-2026-10:ERP-{i:02d} -->",
             "dependency_ids": [] if i < 2 else ["ERP-01"]} for i in range(13)]


class IssueStore:
    """Remote semantics in memory, including a lost response after persistence."""
    def __init__(self, rows=(), fail_before=None, fail_after=None):
        self.rows = copy.deepcopy(list(rows))
        self.fail_before, self.fail_after = fail_before, fail_after
        self.creations = 0
        self.edits = 0
        self.lookups = 0

    def list_all_issues(self):
        self.lookups += 1
        return copy.deepcopy(self.rows)

    def create_issue(self, title, body):
        self.creations += 1
        if self.creations == self.fail_before:
            raise TimeoutError("request failed before persistence")
        row = {"number": max([r["number"] for r in self.rows] + [59]) + 1,
               "title": title, "body": body, "state": "OPEN", "comments": []}
        self.rows.append(row)
        if self.creations == self.fail_after:
            raise TimeoutError("response lost after persistence")
        return copy.deepcopy(row)

    def update_body(self, number, body):
        self.edits += 1
        next(row for row in self.rows if row["number"] == number)["body"] = body


class TrackingBootstrapTests(unittest.TestCase):
    def test_rerun_resolves_all_thirteen_links_without_duplicate_or_body_edits(self):
        module = implementation()
        store = IssueStore()
        first = module.reconcile(store, seeds())
        snapshot = copy.deepcopy(store.rows)
        edits = store.edits
        second = module.reconcile(store, seeds())
        self.assertEqual(first, second)
        self.assertEqual(store.rows, snapshot)
        self.assertEqual(store.creations, 13)
        self.assertEqual(store.edits, edits)
        child = next(row for row in store.rows if row["number"] == first["ERP-12"])
        self.assertIn(f'/issues/{first["ERP-00"]}', child["body"])
        self.assertIn(f'/issues/{first["ERP-01"]}', child["body"])

    def test_lost_create_response_looks_up_persisted_marker_before_continuing(self):
        module = implementation()
        store = IssueStore(fail_after=5)
        mapping = module.reconcile(store, seeds())
        self.assertEqual(len(mapping), 13)
        self.assertEqual(len(store.rows), 13)
        self.assertEqual(store.creations, 13)
        before = copy.deepcopy(store.rows)
        module.reconcile(store, seeds())
        self.assertEqual(store.rows, before)
        self.assertEqual(store.creations, 13)

    def test_failed_request_without_persistence_stops_and_rerun_reuses_partial_work(self):
        module = implementation()
        store = IssueStore(fail_before=5)
        with self.assertRaises(TimeoutError):
            module.reconcile(store, seeds())
        self.assertEqual(len(store.rows), 4)
        saved_numbers = [row["number"] for row in store.rows]
        mapping = module.reconcile(store, seeds())
        self.assertEqual(len(store.rows), 13)
        self.assertEqual([mapping[f"ERP-{i:02d}"] for i in range(4)], saved_numbers)
        self.assertEqual(store.creations, 14)  # One failed request, thirteen real creations.

    def test_managed_replacement_preserves_exact_human_prefix_suffix_title_state_comments(self):
        module = implementation()
        prefix = 'Human plan\nKeep $literal and `code`.\n\n'
        suffix = '\n\nHuman conclusion\n'
        start = '<!-- ercot-post-release-2026-10:managed:ERP-01:start -->'
        end = '<!-- ercot-post-release-2026-10:managed:ERP-01:end -->'
        row = {"number": 12, "title": "Human title", "body": prefix + start + '\n' +
               seeds()[1]["idempotency_marker"] + '\nold managed text\n' + end + suffix,
               "state": "CLOSED", "comments": [{"id": 9, "body": "Human discussion"}]}
        store = IssueStore([row])
        with self.assertRaisesRegex(ValueError, "closed_equivalent_requires_assessment"):
            module.reconcile(store, seeds())
        self.assertEqual(store.rows, [row])
        self.assertEqual(store.creations, 0)
        mapping = module.reconcile(store, seeds(), assessed_closed={12})
        updated = next(r for r in store.rows if r["number"] == 12)
        self.assertEqual(mapping["ERP-01"], 12)
        self.assertTrue(updated["body"].startswith(prefix))
        self.assertTrue(updated["body"].endswith(suffix))
        for key in ["title", "state", "comments"]:
            self.assertEqual(updated[key], row[key])

    def test_verified_unmarked_equivalent_is_reused_without_overwriting_human_body(self):
        module = implementation()
        row = {"number": 7, "title": "Existing equivalent", "body": "Human text\n",
               "state": "OPEN", "comments": ["Preserve me"]}
        store = IssueStore([row])
        mapping = module.reconcile(store, seeds(), equivalents={"ERP-03": 7})
        self.assertEqual(mapping["ERP-03"], 7)
        updated = next(r for r in store.rows if r["number"] == 7)
        self.assertTrue(updated["body"].startswith("Human text\n"))
        self.assertEqual(updated["comments"], ["Preserve me"])
        self.assertEqual(store.creations, 12)

    def test_duplicate_open_closed_markers_fail_before_any_write_and_pr_is_excluded(self):
        module = implementation()
        marker = seeds()[1]["idempotency_marker"]
        rows = [{"number": n, "body": marker, "state": state, "title": "Existing"}
                for n, state in [(7, "OPEN"), (8, "CLOSED")]]
        store = IssueStore(rows)
        with self.assertRaisesRegex(ValueError, "duplicate_issue_marker"):
            module.reconcile(store, seeds(), assessed_closed={8})
        self.assertEqual(store.rows, rows)
        self.assertEqual((store.creations, store.edits), (0, 0))
        store = IssueStore([dict(rows[0], pull_request={"url": "ignored"})])
        mapping = module.reconcile(store, seeds())
        self.assertNotEqual(mapping["ERP-01"], 7)
        self.assertEqual(store.rows[0]["body"], marker)

    def test_malformed_managed_section_fails_before_creation_or_human_changes(self):
        module = implementation()
        row = {"number": 7, "title": "Human", "state": "OPEN", "comments": [],
               "body": seeds()[1]["idempotency_marker"] + '\n' +
               '<!-- ercot-post-release-2026-10:managed:ERP-01:start -->\nHuman text'}
        store = IssueStore([row])
        with self.assertRaisesRegex(ValueError, "invalid_managed_section"):
            module.reconcile(store, seeds())
        self.assertEqual(store.rows, [row])
        self.assertEqual((store.creations, store.edits), (0, 0))

    def test_prepared_checklist_is_posted_inside_managed_section_without_losing_links(self):
        module = implementation()
        prepared = seeds()
        prepared[3]["managed_body"] = "### Approved specification\n\n- [ ] `ERP-03-A`: preserve source pairs.\n"
        store = IssueStore()
        mapping = module.reconcile(store, prepared)
        body = next(r["body"] for r in store.rows if r["number"] == mapping["ERP-03"])
        self.assertIn(prepared[3]["managed_body"], body)
        self.assertIn(f'/issues/{mapping["ERP-00"]}', body)
        self.assertIn(f'/issues/{mapping["ERP-01"]}', body)
        self.assertLess(body.index("### Approved specification"),
                        body.index("<!-- ercot-post-release-2026-10:managed:ERP-03:end -->"))

    def test_prepared_spec_cannot_inject_managed_delimiters_before_any_write(self):
        module = implementation()
        prepared = seeds()
        prepared[3]["managed_body"] = "<!-- ercot-post-release-2026-10:managed:ERP-03:end -->"
        store = IssueStore()
        with self.assertRaisesRegex(ValueError, "invalid_prepared_managed_body"):
            module.reconcile(store, prepared)
        self.assertEqual((store.creations, store.edits), (0, 0))


if __name__ == "__main__":
    unittest.main()
