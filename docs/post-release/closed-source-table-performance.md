# Defer closed source-table rows

The performance PR previously rendered source-table body rows even while their disclosure was closed. The exact Linux profile recorded 9,071 DOM nodes and 8,194 layout objects; the final accessibility PR, which already deferred those rows, recorded 1,978 nodes and 1,057 layout objects on the native host. Different hosts are not a controlled timing comparison; these counts identify avoidable closed-interface work.

The existing final behavior is now backported to the performance PR: opening the native details disclosure renders the same last 250 displayed points per series, and closing removes those DOM rows. Retained source arrays, native response bodies, statistics, plot points, cursor evidence and full CSV export are unchanged.

A genuine regression first failed with 524 rows in the closed balance table. With the deferral, the unchanged test verifies zero closed rows, more than 250 populated opened rows, the exact source epoch, and zero rows after closing. This test plus all four original warm-context tests and the non-extreme paired-envelope table/CSV test passed: six tests, zero skips. Strict Linux numeric acceptance still requires an exact-head rerun; prior 3,559 ms failure is retained.

Independent review found a state mismatch when an opened disclosure was removed by a genuine empty source window and then remounted with data. A second regression reproduced the closed disclosure with retained row state. Controlling the disclosure open state fixes that remount and retains user intent. Both regression cases, all four warm-context tests, and the paired-envelope table/CSV test now pass: seven tests, zero skips.
