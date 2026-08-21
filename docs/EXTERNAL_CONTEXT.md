# External context

PR22 adds external context without changing any ERCOT operational source. Its
public policy is
`external_context_not_ercot_operational_authority_or_live_emissions_measurement`.

The deployable no-key slice collects EPA eGRID's credential-free annual summary
workbook. Discovery is weekly and strict: five exact sheets, the reviewed Table
1 total-output block, exactly one `ERCT` / `ERCOT All` row, seven nonnegative
`lb/MWh` rates, and explicit data-year, revision, release-date, model-version,
artifact URL, and SHA-256 provenance. The collector discards workbook bytes and
all other table rows after parsing. eGRID factors are retrospective annual
averages, not current or marginal emissions, and are never converted into live
mass emissions.

EIA-930 and Henry Hub require an individual EIA key. When a non-DEMO key is
configured, the collector independently fetches a rolling 72-hour ERCO hourly
demand/total-interchange window and at most 25 Henry Hub daily spot-price
observations. The key is present only in the required outbound EIA query and is
never stored, logged, hashed, ingested, or served. Without that credential the
collector makes zero EIA requests and publishes `disabled /
eia_api_key_not_configured`. EPA CAMD remains `unavailable /
ercot_footprint_and_coverage_methodology_not_frozen`, regardless of whether a
CAM API credential exists.

Enable the collector only after receiver authentication is configured:

```dotenv
EXTERNAL_CONTEXT_INGEST_ENABLED=true
EXTERNAL_CONTEXT_ENDPOINT=http://receiver:8080/api/external-context/ingest
EIA_API_KEY=
```

The manifest is the queryless `GET /api/v1/external-context`. It contains small
fixed section states and current pointers. Exact data live in queryless,
content-versioned resources at
`/api/v2/external-context/{stream}/v1/{xc1-content-version}`. The resolver uses a
15-second shared-cache revalidation and strong ETag. Immutable resources have a
one-year public cache lifetime; retired eGRID publications remain addressable
for ten years, with at least the latest five retained.

EIA-930 values are hourly energy in MWh, not instantaneous MW. Positive total
interchange is EIA-defined net export/outflow and negative is import/inflow.
Henry Hub values are source market-date prices in USD/MMBtu; weekends and
holidays remain gaps and are never forward-filled. Neither source replaces an
ERCOT operational series or establishes price/load causality.
