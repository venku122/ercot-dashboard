# ERCOT Receiver

## Texas Grid long-horizon snapshots

The long-horizon collector is disabled by default. Set
`ERCOT_LONG_HORIZON_INGEST_ENABLED=true` to poll the credential-free official
ERCOT GIS monthly XLSX listing, Resource Capacity Trend page, and reviewed
Long-Term Load Forecast workbook/report every six hours. It publishes only
phase/fuel and capacity-category aggregates plus the two official monthly LTLF
scenarios; project rows and live GIS document identifiers are discarded and
never stored or served. LTLF peak/energy units are bound to the official report
Appendix A. Large-load project status and gross retirements remain explicitly
unavailable.

The authenticated collector routes are `POST /api/texas-grid/ingest` and
`POST /api/texas-grid/source-attempt`. Public reads use the queryless resolver
`GET /api/v1/texas-grid` and content-versioned immutable resources under
`GET /api/v2/texas-grid/{gis|resource_capacity_trend|long_term_load_forecast}/v1/{content_version}`.
Resolver responses revalidate after 15 seconds. Retired immutable bytes remain
available for at least their advertised one-year cache lifetime; after that
grace, storage is bounded to 120 source months and four corrections per month.

Local metrics receiver + SQLite store + dashboard UI.

## Run

```bash
python3 server.py
```

Defaults to `http://0.0.0.0:8080`.

Environment variables:

- `PORT` (default `8080`)
- `HOST` (default `0.0.0.0`)
- `METRICS_API_KEY` (required for `/api/ingest`, sent as `X-API-Key`)
- `CACHE_TTL_SECONDS` (default `10`, in-memory cache TTL)
- `CACHE_CONTROL_MAX_AGE` (default `30`, browser cache TTL in seconds for series/latest)
- `CORS_ORIGINS_EXTRA` (comma-separated list of extra allowed origins)
- `TRUST_PROXY` (`1` to honor `X-Forwarded-For` for rate limiting)
- `RATE_LIMIT_INGEST_RPM` (default `600`)
- `RATE_LIMIT_SERIES_RPM` (default `300`)
- `RATE_LIMIT_LATEST_RPM` (default `300`)
- `RATE_LIMIT_STATUS_RPM` (default `120`)
- `RATE_LIMIT_METRICS_RPM` (default `120`)
- `SERIES_BACKFILL_BATCH_SIZE` (default `1000`, rows committed per normalized-series migration batch)
- `SERIES_BACKFILL_MAX_BATCHES` (default `10`, bounded batches per startup; `0` disables automatic backfill)

## Normalized series migration

The receiver retains `metrics.metric_name`, `metrics.tags`, and `metric_tags` while it incrementally assigns the internal `metrics.series_id`. Each startup processes at most `SERIES_BACKFILL_BATCH_SIZE * SERIES_BACKFILL_MAX_BATCHES` legacy rows and commits every batch. If any row for a requested metric remains unassigned, reads for that metric use the legacy selector so partial migration cannot hide samples.

Large databases may require multiple restarts or an operator-controlled call to `backfill_metric_series` before normalized reads become authoritative. Keep the old compatibility columns and indexes until the parity report in `docs/ercot-series-identity.md` has been reviewed. The internal integer ID is not part of any public API or cache identity.

Production migration is instead performed on a coherent offline working copy with
`scripts/series_migration.py`; see `docs/OFFLINE_SERIES_MIGRATION.md`. `/api/status` exposes
`normalized_series.ready`, the unassigned-row count, and blocked tile metrics so bounded startup
compatibility work cannot be mistaken for completed v2 readiness.

## Ingest

POST metrics to `http://localhost:8080/api/ingest` with a JSON array of:

```json
[
  {
    "metric_name": "ercot.Real-Time_Data.Actual_System_Demand",
    "points": [{ "value": 12345 }],
    "tags": ["source:ercot"],
    "interval": 60,
    "metric_type": "gauge"
  }
]
```

## Collector integration

Set the collector to send to the receiver:

```bash
export METRICS_ENDPOINT="http://localhost:8080/api/ingest"
export METRICS_API_KEY="local-key"
```

## Dashboard

Open `http://localhost:8080/`.

The dashboard assets are built from the repo root with:

```bash
pnpm install
pnpm run build
```

The production image builds the React frontend during the receiver Docker build, then serves the resulting static assets from `/app/web` with the existing Python server.
