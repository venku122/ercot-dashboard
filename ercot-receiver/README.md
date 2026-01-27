# ERCOT Receiver

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

## Ingest

POST metrics to `http://localhost:8080/api/ingest` with a JSON array of:

```json
[
  {
    "metric_name": "ercot.Real-Time_Data.Actual_System_Demand",
    "points": [{"value": 12345}],
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
