# ERCOT API live verification

Verified from the development machine on 2026-08-18. This record is intentionally sanitized; credentials and token material are never recorded.

## Result

```text
AUTH: PASS (HTTP 200, expires_in=3600)
PUBLIC API: PASS (HTTP 200)
PUBLIC PRODUCTS: 111 total, 111 active, 240 artifacts
REQUIRED PRODUCTS FOUND: 5/5
ESR API: PASS (HTTP 200)
ESR FIELD DEFINITIONS: 5
ESR ROWS IN TEST WINDOW: 0
```

The Public and ESR calls used their separate subscription keys. The current OAuth response's `access_token` is accepted by `api.ercot.com`; using the returned `id_token` produced an HTTP 302 instead of the API response.

The ESR endpoint accepted bounded `AGCExecTimeFrom` and `AGCExecTimeTo` parameters and returned its current five-field schema. Small windows ending 10 minutes, 1 hour, 6 hours, and 1 day before the test all returned HTTP 200 with zero rows. A server-bounded unfiltered request also reported zero total records. This proves authentication, subscription selection, endpoint reachability, and the current query contract, but it does not establish a non-zero ESR publication rate. PR 16 must measure that rate only after live rows are available.

## Endpoints exercised

- OAuth: `B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token`
- Public inventory: `GET https://api.ercot.com/api/public-reports`
- ESR: `GET https://api.ercot.com/api/public-data/rptesr-m/4_sec_esr_charging_mw`

## Reproduction

Run `pnpm run test:ercot-api:live` with these environment variables set in the process:

- `ERCOT_API_USERNAME`
- `ERCOT_API_PASSWORD`
- `ERCOT_PUBLIC_API_SUBSCRIPTION_KEY`
- `ERCOT_ESR_API_SUBSCRIPTION_KEY`

The command prints only pass/fail state, counts, and the bounded test window. It does not print credentials, tokens, request headers, or response rows.

## Deferred validation

- Re-run the bounded ESR query when ERCOT publishes non-empty data and record the measured row rate and observed schema before designing retention.
- Live ERCOT tests remain opt-in and are not part of deterministic credential-free CI.
- No production deployment or Cloudflare mutation was performed.
