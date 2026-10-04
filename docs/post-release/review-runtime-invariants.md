# Disposable synthetic review receiver invariants

The local review receiver seeds genuine receiver tables with clearly labeled artificial examples. It does not run a collector, fetch external feeds, populate optional publication archives or replace receiver API responses.

Storage charging remains negative and discharging positive. At every native epoch, the seeded net output now equals their exact sum, matching the supported source balance contract. The initial independent per-series phases incorrectly produced inconsistent storage values. A SQL join over all 2,017 seven-day storage epochs verifies signed balance without using the generator as its oracle.

The fixture manifest reports the actual SQL minimum and maximum stored timestamps. It separately reports `requested_start_ts` and `requested_end_ts`, so flooring hourly and fifteen-minute source slots cannot hide that some bounded source observations precede the requested start. The regression uses a five-minute end offset to expose the original 300-second earliest-timestamp discrepancy, and compares the manifest's bounds and count with direct SQL.

These checks establish synthetic fixture consistency. They do not establish live source availability, production correctness, or populated optional-domain acceptance. The runtime remains bound to loopback, uses a process-owned temporary SQLite database and copies built assets into its temporary directory. Stop with Ctrl-C for normal cleanup; abrupt process termination may leave a temporary directory.
