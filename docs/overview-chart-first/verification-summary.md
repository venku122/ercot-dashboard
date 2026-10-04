> Historical evidence: preserved as originally measured. For current revisions, campaign acceptance, deployment unknowns and architecture precedence, see [Current status](../CURRENT_STATUS.md). Pointer added October 3, 2026.

# Homepage verification

Application revision tested: `8aadcf8cc240e91893d65f5b8dd76fe76bf5be62`.
Base PR #55 remains at `5ba7a130a221ab6b8707c2da2502976acc601ba8`.
The subsequent evidence commit changes only tests and review artifacts, not application code.

## Completed checks

- Type checking, lint and formatting: passed.
- Frontend unit tests: 441 passed.
- Receiver tests: 267 passed.
- Contract tests: 20 passed.
- Collector Docker test target: 156 passed; no running collector changed.
- Chromium regression run without snapshot updates: 70 passed.
- Mobile P0 run: 17 passed after updating the price heading assertion to include its mobile units.
- Production performance harness: 1 passed; numeric acceptance is reported below, independently of harness success.
- Local receiver-backed preview and desktop/mobile screenshots inspected. LAN preview returned HTTP 200.

## Measured performance

Five production-build cold runs at 1440×900, DPR 1, 4× CPU slowdown, 1.6 Mb/s and 150 ms latency produced a **2,948 ms median**, versus **2,551 ms** on the carried-forward cleanup baseline. The 2,500 ms target is **not met**. API responses use deterministic route-fulfilled fixtures; this is not a production API benchmark.

For 200 unthrottled cursor samples, p95 was **35 ms**, with **zero hover history requests**. Timing spans the event through two animation frames and is a conservative proxy, not a compositor paint timestamp. Raw measurements and browser version are in `performance.json` and `performance-baseline.json`.

## Remaining review items

- Improve cold-load performance before claiming full directive acceptance.
- Seven-day coarse headroom needs source-paired aggregation; incompatible aggregates are currently withheld.
- Legacy price collection does not preserve settlement intervals. Rankings are explicitly collection snapshots, not verified settlement-interval comparisons.
- Inline future Outlook, the full new adversarial seven-day image matrix, manual screen-reader review and independent review remain incomplete.
- macOS Chromium screenshots do not certify Linux or WebKit rendering.

The preview is local, not a deployment. No main merge, production deployment, database migration, collector activation or credential change was performed. See `acceptance-report.md` for the source matrix and item-level acceptance status.
