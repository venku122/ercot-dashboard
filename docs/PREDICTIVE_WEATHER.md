# Predictive weather

PR18 adds optional National Weather Service forecast context to the existing Outlook view. It is a
representative-point product, not a weather-zone forecast, statewide model, ERCOT declaration, or
load-causality model.

## Sources and identity

The versioned `representative-airport-points-v1` registry contains exactly four WGS84 airport
points: KDFW, KAUS, KHOU, and KSAT. The collector resolves each point through the NWS `/points`
endpoint and validates the linked `forecastGridData` URL before collecting these raw-grid layers:

- `temperature`, `apparentTemperature`, `heatIndex`, and `windChill` in `wmoUnit:degC`
- `windSpeed` and `windGust` in `wmoUnit:km_h-1`

Native ISO-8601 validity intervals and null gaps are preserved. The receiver accepts intervals up to
10 days as an application safety bound; this is not a claim about the forecast horizon. Values are
never interpolated, forward-filled, or borrowed from an adjacent interval.

Texas alerts come from the NWS active-alert collection with `area=TX&status=actual`. Coverage is
explicitly `texas_statewide_not_ercot_footprint`. NWS severity is never translated into an ERCOT
grid alert, EEA, or conservation status.

## Runtime

Collection is disabled by default. A reviewed deployment opts in with:

```dotenv
NWS_WEATHER_INGEST_ENABLED=true
NWS_WEATHER_ENDPOINT=http://receiver:8080/api/predictive-weather/ingest
NWS_WEATHER_USER_AGENT=ercot-dashboard-observatory/1 (+https://github.com/venku122/ercot-dashboard)
```

NWS requires a stable identifying User-Agent. The collector sends no ERCOT credentials or receiver
key to NWS, follows only exact `https://api.weather.gov` links, rejects redirects, bounds bodies and
cardinality, honors origin cache headers, uses conditional validation, and retains stale mappings for
at most 24 hours after a failed refresh.

The authenticated receiver route is `POST /api/predictive-weather/ingest` with independent
`forecast` and `alerts` streams. The queryless public current resource is
`GET /api/v1/predictive-weather`. Current pointers are monotonic by source update and retrieval time;
same-clock byte conflicts fail closed. Each stream retains at most eight content-addressed current
snapshot versions. The public response has strong ETag/304 behavior, short revalidation caching,
singleflight generation, and generation-aware invalidation.

## Outlook behavior

The panel is collapsed by default and makes no predictive-weather request until expanded. It reuses
the already-loaded Outlook target timestamp and current METAR context. A forecast value is related to
the Outlook peak only when the exact half-open NWS interval contains that timestamp. The UI labels
official NWS evidence and dashboard-derived context separately and states that temporal overlap does
not establish attribution.

Four points do not represent West, Far West, East, or Southern ERCOT weather-zone conditions, Texas
extrema, or area averages. ERCOT-footprint alert filtering, maps, forecast history, and skill scoring
remain deferred until their source and geometry contracts are reviewed.
