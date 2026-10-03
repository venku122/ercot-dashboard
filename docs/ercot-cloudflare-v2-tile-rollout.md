# Cloudflare v2 tile cache rollout

This is a preparation and rollback runbook. It does not authorize a production
deployment or a Cloudflare mutation. The v2 rule and same-PoP `MISS` to `HIT`
acceptance remain pending explicit human approval.

## Read-only audit on 2026-08-18

Public requests confirm that `ercot.tarazevits.io` is proxied through
Cloudflare. Two requests from LAX for the existing sealed v1 canonical chunk
both returned `CF-Cache-Status: HIT`, `Age: 18718`, the deployed sealed policy,
and the same strong ETag:

```text
Cache-Control: public, max-age=3600, s-maxage=86400, immutable
ETag: "214086f096d4e238aed49ac28487423310dfabe43a2df8dc27dadf6f4a44fa11"
```

This is current public evidence that the v1 rule is still effective. The
`immutable` token is an unsafe age-based historical classification because
corrections remain possible; it is recorded here as observed legacy behavior,
not as the v2 target and not as proof of immutable bytes. It is not a reason to
replace or reorder that rule during this unapproved preparation.

Production returned `404` and `CF-Cache-Status: DYNAMIC` for both
`/api/v2/tile-catalog` and a canonical-looking `/api/v2/tiles/...` request.
`/api/status` remained `200`, `Cache-Control: no-store`, and
`CF-Cache-Status: DYNAMIC`. This is consistent with v2 not being deployed and
no effective v2 tile eligibility rule. Public headers cannot prove the complete
control-plane ruleset or rule precedence.

The homelab 1Password service-account credential was present, but every
authenticated vault metadata read hung without returning a vault or item. No
secret was printed or copied elsewhere. Therefore the active zone identifier,
ruleset version, rule IDs, and token policy were not re-confirmed from the
Cloudflare API on 2026-08-18.

The most recent authenticated snapshot, recorded on 2026-08-17, was zone
`tarazevits.io`, Cache Rules entrypoint version 3, in this order:

1. `ERCOT canonical historical chunks` for the exact v1 chunk path;
2. `ERCOT immutable static assets` for `/assets/*`;
3. `SPEXcast Admin Panel` for paths starting `/ghost`;
4. `Bypass cache for DoH endpoint` for `dns.tarazevits.io/dns-query`.

Treat that list as a last-known snapshot, not current control-plane evidence.
Cloudflare says Cache Rules are stackable and the last matching rule wins for
the same setting, so the operator must fetch and review the entrypoint again
immediately before activation. See [Cache Rules order and
priority](https://developers.cloudflare.com/cache/how-to/cache-rules/order/).

The v1 rule in that snapshot used this contract. It is rollback-critical and
must remain unchanged and enabled throughout the v2 migration:

```json
{
  "action": "set_cache_settings",
  "action_parameters": {
    "browser_ttl": { "mode": "respect_origin" },
    "cache": true,
    "edge_ttl": { "mode": "respect_origin" },
    "respect_strong_etags": true
  },
  "description": "ERCOT canonical historical chunks",
  "enabled": true,
  "expression": "(http.host eq \"ercot.tarazevits.io\" and http.request.method eq \"GET\" and http.request.uri.path eq \"/api/v1/series/chunk\")"
}
```

## Exact proposed rule

Add one rule; do not replace the ruleset and do not edit the v1 rule.

```json
{
  "action": "set_cache_settings",
  "action_parameters": {
    "browser_ttl": {
      "mode": "respect_origin"
    },
    "cache": true,
    "edge_ttl": {
      "mode": "respect_origin"
    },
    "respect_strong_etags": true
  },
  "description": "ERCOT canonical v2 tiles",
  "enabled": true,
  "expression": "(http.host eq \"ercot.tarazevits.io\" and http.request.method eq \"GET\" and starts_with(http.request.uri.path, \"/api/v2/tiles/\"))"
}
```

Deploy it to the zone `http_request_cache_settings` entrypoint. Cloudflare's
[Rulesets API instructions](https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/)
identify `set_cache_settings` and that phase as the Cache Rules contract.

The prefix expression is intentional and portable across Cloudflare plans. The
origin accepts only four canonical path segments after `/tiles/`, rejects query
strings, and sends `no-store` for malformed paths, unknown series, incomplete
backfills, rate limits, and generation errors. With origin-respecting policy,
those responses remain uncacheable. The expression cannot match ingest,
checkpoint, status, catalog, batch, or any other private or mutable endpoint.

Do not configure a custom cache key. The canonical v2 identity is already the
path:

```text
/api/v2/tiles/{series_key}/{1h|1d}/{aligned_start}/{lod}
```

Cloudflare's [default cache key](https://developers.cloudflare.com/cache/how-to/cache-keys/)
includes scheme, host, and URI including query string. A custom key would add
complexity and can impair single-file purge. The origin rejects query strings,
so a valid v2 tile has exactly one URL identity. Do not ignore query strings:
doing so could make an invalid request alias a valid cached object.

Cloudflare documents `respect_strong_etags: true` as the byte-equivalence
setting. Its [ETag reference](https://developers.cloudflare.com/cache/reference/etag-headers/)
also notes that content re-encoding can still weaken an ETag in some cases, so
acceptance must inspect the actual response header rather than only the rule
configuration.

## Precedence and placement

After fetching the current entrypoint, place the v2 rule immediately after the
existing `ERCOT canonical historical chunks` v1 rule and before the immutable
assets rule. The intended ERCOT order is:

1. existing v1 chunks — unchanged and enabled;
2. new v2 tiles;
3. existing immutable assets — unchanged and enabled.

The v1 and v2 path expressions are disjoint, so their relative order does not
change either result. The last-known `/ghost` and DoH rules are also disjoint.
The important activation precondition is that no later current rule matches
`ercot.tarazevits.io/api/v2/tiles/*` and overrides eligibility, origin TTL, the
browser TTL, or strong-ETag handling. If such a rule exists, stop and review the
combined result; do not guess based on rule names. Use Cloudflare Trace after
the draft is positioned and again after deployment.

Do not submit a `PUT` body containing only the new rule. Cloudflare explicitly
warns that whole-ruleset updates delete existing rules omitted from the request.
Activation instead uses Cloudflare's [add-one-rule
endpoint](https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/),
which creates a new ruleset version and returns the complete ruleset. Rule
maintenance and rollback use the documented [single-rule
`PATCH`](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/)
and [single-rule
`DELETE`](https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/)
operations, never a partial whole-ruleset replacement.

## Origin policy to preserve

The receiver classifies on the half-open tile end at request time:

| Class  | Classification                                     | Receiver TTL | Browser | Shared edge | Exact origin policy                                           |
| ------ | -------------------------------------------------- | -----------: | ------: | ----------: | ------------------------------------------------------------- |
| live   | ends less than 5 minutes ago or in the future      |   10 seconds |   5 sec |      15 sec | `public, max-age=5, s-maxage=15, stale-while-revalidate=30`   |
| recent | ends at least 5 minutes but less than 24 hours ago |    5 minutes |  60 sec |       5 min | `public, max-age=60, s-maxage=300, stale-while-revalidate=60` |
| sealed | ends at least 24 hours ago                         |    5 minutes |  60 sec |       5 min | `public, max-age=60, s-maxage=300, must-revalidate`           |

The proposed rule uses `edge_ttl.mode=respect_origin` and
`browser_ttl.mode=respect_origin`; it must not override these class-specific
headers. Cloudflare's [Origin Cache Control
documentation](https://developers.cloudflare.com/cache/concepts/cache-control/)
states that `s-maxage` controls shared-cache freshness while `max-age` controls
browser freshness. Free, Pro, and Business zones have Origin Cache Control on
by default; an Enterprise zone must also be checked for an overriding setting.

`sealed` is only an operational age label, not proof that corrections are
impossible and not an immutable cache class. Receiver invalidation does not
purge Cloudflare, so v2 keeps a finite five-minute shared-cache freshness bound
until a separately reviewed purge or content-version URL design exists.
Cloudflare distinguishes configurable freshness from non-configurable LRU
retention; a fresh object can still be evicted. See
[Retention versus freshness](https://developers.cloudflare.com/cache/concepts/retention-vs-freshness/).

## Credential and control-plane preflight

Use a secret injector backed by the 1Password homelab vault. Never place the
token in a command argument, shell trace, repository file, report, or captured
terminal transcript.

Before any change, perform only these reads:

1. verify the token with `GET /user/tokens/verify` and require `active`;
2. fetch the configured zone and require its name to be exactly
   `tarazevits.io`;
3. fetch
   `GET /zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint`;
4. record its version, last-updated time, descriptions, expressions, actions,
   parameters, enabled flags, and exact order without recording the token;
5. confirm the v1 rule is present, enabled, and unchanged;
6. save the complete pre-change entrypoint response outside the repository as
   the rollback input.

The least-privilege audit identity should be limited to this zone with `Zone
Read` and `Cache Rules Read`. Cloudflare's current [permission
catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
defines those read permissions. Do not infer token policy merely from a
successful token verification: the verify endpoint reports token status, while
successful zone and entrypoint reads prove the required effective access. A
separate short-lived activation credential must have the edit permission
required by Cloudflare and be scoped to the target zone.

If the zone, entrypoint, expected v1 rule, or token scope cannot be confirmed,
stop before mutation.

## Human-authorized activation

Only after the v2 application revision has passed review and a human explicitly
authorizes production promotion:

1. Capture the current application revision, image digests, Cloudflare
   entrypoint version, and the complete rollback snapshots.
2. Deploy the reviewed application while preserving the Portainer stack
   environment and existing v1 compatibility.
3. Directly validate a live, recent, and sealed v2 tile: status 200, canonical
   path, expected class header, exact `Cache-Control`, deterministic body,
   stable strong ETag, conditional 304, and no unexpected SQLite generation on
   a receiver LRU hit.
4. Repeat the control-plane preflight with a fresh entrypoint `GET`. Compare the
   complete identity and order with the reviewed pre-change snapshot: ruleset
   ID, version, each rule ID, version, action, parameters, expression,
   description, enabled flag, and position. Abort on any difference. Resolve the
   current v1 rule ID from that response; never reuse a stale or description-only
   lookup.
5. Add only `ERCOT canonical v2 tiles` with the documented single-rule request:

   ```text
   POST /zones/{zone_id}/rulesets/{ruleset_id}/rules
   ```

   Submit this exact body, resolving the position from the fresh read:

   ```json
   {
     "action": "set_cache_settings",
     "action_parameters": {
       "browser_ttl": { "mode": "respect_origin" },
       "cache": true,
       "edge_ttl": { "mode": "respect_origin" },
       "respect_strong_etags": true
     },
     "description": "ERCOT canonical v2 tiles",
     "enabled": true,
     "expression": "(http.host eq \"ercot.tarazevits.io\" and http.request.method eq \"GET\" and starts_with(http.request.uri.path, \"/api/v2/tiles/\"))",
     "position": { "after": "{fresh_current_v1_rule_id}" }
   }
   ```

   Do not use a whole-ruleset `PUT`. Cloudflare does not document a ruleset
   version precondition for this operation, so the fresh comparison reduces but
   does not eliminate the concurrent-change window.

6. Require the `POST` response to contain the complete ruleset and a new ruleset
   version. Compare it with the immediately preceding snapshot and require the
   only change to be the one new, enabled v2 rule immediately after the same v1
   rule. Require every prior rule's identity, definition, enabled state, and
   relative order to remain unchanged. Save the returned v2 rule ID.
7. Immediately fetch the entrypoint again. Require its ruleset ID, version,
   complete rule definitions, and exact order to equal the successful `POST`
   response. If the response or fresh read contains any unexpected change, stop
   and use the narrow rollback procedure below; do not attempt a compensating
   whole-ruleset write.
8. Use Cloudflare Trace for representative valid and invalid v2 paths. Confirm
   the v2 rule matches the intended GET prefix, later rules do not override its
   settings, and invalid origin responses remain uncacheable because they are
   `no-store`.
9. Check `/api/status`, writes, v1 chunks, the catalog, and invalid v2 requests
   remain non-cacheable or retain their prior intended behavior.
10. Proceed to the deferred same-PoP acceptance below.

## Deferred same-PoP acceptance

This was not run because production v2 code and the v2 Cache Rule are not
authorized for deployment. After activation, select one sealed canonical v2
URL that has not been warmed in the test PoP and capture receiver counters
before the request:

```text
tile_origin_requests_total
tile_sqlite_generations_total
tile_receiver_lru_hits_total
tile_receiver_lru_misses_total
tile_singleflight_waits_total
tile_responses_200_total
tile_responses_304_total
```

Request that exact URL twice from the same client and confirm the `CF-Ray`
suffix identifies the same PoP. Required evidence:

```text
first:  CF-Cache-Status: MISS or an explained equivalent cold fill
second: CF-Cache-Status: HIT
second: Age present and nondecreasing on another immediate HIT
both:   identical strong ETag and expected sealed Cache-Control
origin: first request may increment origin/generation counters
origin: edge HIT increments neither origin-request nor SQLite-generation counters
```

Cloudflare defines `MISS` as eligible but absent, `HIT` as served from cache,
and `Age` as seconds resident in cache in its [cache response
reference](https://developers.cloudflare.com/cache/concepts/cache-responses/).
An already warm first request may be `HIT`; choose another sealed URL instead
of purging production broadly. Different PoPs have independent cache state and
do not satisfy this scenario.

Also verify one recent and one live tile honor their shorter `s-maxage` values.
Do not claim the gate passed from a v1 URL, a direct-receiver LRU hit, a 304
alone, or two requests served by different PoPs.

## Rollback

Rollback is narrow and preserves v1 compatibility:

1. Record the failing URL, `CF-Ray`, `CF-Cache-Status`, `Age`, ETag, response
   policy, application revision, receiver counters, and ruleset version.
2. Fetch the current entrypoint immediately before rollback and compare its
   complete rule identities, definitions, and order with the post-activation
   snapshot. Require exactly one rule with the saved v2 rule ID and expected
   definition. Stop for human review if there are unrelated changes or the
   target identity is ambiguous; a description match alone is insufficient.
3. Remove only that saved v2 rule ID with Cloudflare's single-rule operation:

   ```text
   DELETE /zones/{zone_id}/rulesets/{ruleset_id}/rules/{v2_rule_id}
   ```

   If the reviewed rollback policy requires disabling instead of deletion, use
   `PATCH` on that exact rule ID with its complete intended rule definition and
   `enabled: false`. Cloudflare documents both operations as creating a new
   ruleset state and returning the complete ruleset; it does not document an
   atomic ruleset-version compare-and-swap precondition for them.

4. Verify the returned full ruleset has a new version and differs only by the
   reviewed deletion or disable. Immediately fetch the entrypoint again and
   require exact equality with the returned ruleset, including rule definitions
   and order. Confirm v1 and every unrelated rule remain unchanged.
5. Confirm a v2 request is no longer edge eligible (`DYNAMIC`, or `BYPASS` when
   the origin response itself prevents caching) and that v1 still returns its
   prior cache behavior.
6. If the application itself is faulty, restore the reviewed prior images and
   stack environment separately. A Cloudflare rollback does not roll back the
   receiver or database.
7. Purge only specifically reviewed v2 URLs if stale data must be removed.
   Avoid zone-wide purge. Because this rule uses the default URL key and valid
   tiles have no query string, an exact URL identifies one tile object.
8. Re-run status, v1, private/write, and frontend smoke checks and retain the
   rollback evidence outside the repository.

Disabling the rule stops intentional v2 eligibility; cached objects may remain
resident but are not a reason to delete the preserved v1 rule. Re-enable only
after the cause is fixed and the human-authorized activation sequence is
repeated.
