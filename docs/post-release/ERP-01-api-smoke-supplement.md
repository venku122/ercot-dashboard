# ERP-01 bounded API smoke supplement

The six allowlisted GET observations validate their receiver response shapes;
HTTP 200 and decoded JSON alone cannot pass. Transport, schema, availability,
reported source health, and bounded API acceptance are separate fields. Empty
optional Outlook/geography publications remain schema-valid and unavailable.
An empty local receiver reports schema PASS and release NOT_PROVEN.

The limited populated API gate additionally requires normalized populated
status, a healthy `supply_demand` source attempt (the exact SOURCE_ID declared in
`ercot-collector/supply_demand.ts`), and bounded Houston pricing data within the
frozen 30-minute cursor age. Source timestamps and ages remain explicit; future,
stale, failed, missing, and optional degraded observations cannot turn into
healthy zero values. The pricing API uses average bucket anchors, including a
partial left boundary; their conservative age does not prove native coverage.
This API gate does not certify browser behavior or an entire application release.

A monotonic deadline limits each request and the whole observation. Standard
CPython HTTPResponse.read1 consumes capped chunks with socket timeouts set to the
remaining deadline. A short-lived read worker is killed and reaped at the parent
deadline, covering DNS, headers, and regular body/chunk trickles that evade
inactivity timeouts. The fixed production host, GET/path allowlist, redirect
prohibition, six-request ceiling, 2 MB per response, and bounded history query
remain enforced before networking and again in the worker.

All supplemental tests use loopback fixtures. Existing production 403 evidence
is unchanged: denied transport leaves application schemas unobserved, rather
than proving application outage. No production requests were made for this fix.

Independent follow-up found a stale cached health snapshot could retain healthy classification when ages were computed at its old `as_of`. A real-loopback regression reproduces this false release PASS. Source and collection ages now use the current observation clock; original reported ages and `as_of` remain visible evidence. An old snapshot cannot establish fresh collection.
