# ERCOT Receiver

Local metrics receiver + SQLite store + dashboard UI.

## Run

```bash
python3 server.py
```

Defaults to `http://0.0.0.0:8080`.

Optional environment variables:
- `PORT` (default `8080`)
- `HOST` (default `0.0.0.0`)
- `METRICS_API_KEY` (if set, require `X-API-Key` on ingest)

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
# optional
export METRICS_API_KEY="local-key"
```

## Dashboard

Open `http://localhost:8080/`.
