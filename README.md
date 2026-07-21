# ERCOT Grid Monitor

Live ERCOT grid metrics with a self-hosted collector, receiver, and analytical dashboard UI.

Live site:

```
https://ercot.tarazevits.io
```

## What this is

Hello, I am a Texas resident and the health and status of the Texas power grid is of immense importance to me and my family. This project was originally created by @danopia and visualized in Datadog. This is a fork/reimplementation of that with self-hosted data collection and dashboards. Ironically, this site is hosted in Texas and if the Texas power grid goes down, so will this site!

## Quick start (Docker)

```bash
docker compose up -d
```

The dashboard will be available at:

```text
http://localhost:8080
```

The collector polls ERCOT's public dashboard resources and reports metrics, operations events, and structured source health to the receiver. The receiver stores data in SQLite WAL mode and serves the built React dashboard.

## Dashboard capabilities

- Global presets, custom ranges, live/pause, one-window navigation, and previous-period/day/week/custom-offset comparison.
- Inspect mode, bounded drag/wheel/pinch zoom, modified pan, a linked RAF-throttled cursor, and click-to-pin.
- Stable interactive legends with solo mode and latest/min/max/average/sum statistics.
- Operations-message annotations, CSV export, copyable URL-restored state, explicit loading/empty/stale/failed/partial states, and accessible data tables.
- Lazy chart mounting and server-side bounded aggregation, including min/max preservation for spike-critical series.

See [architecture](docs/architecture.md), [ERCOT sources and schemas](docs/ercot-sources.md), [operations and rollback](docs/operations.md), and [verification evidence](docs/verification.md).

## Frontend development

The dashboard frontend now uses React, TypeScript, Vite, `oxlint`, `oxfmt`, and `tsgo` while still being served by the existing Python receiver in production.

```bash
pnpm install
pnpm run build
python3 ercot-receiver/server.py
```

For a separate Vite dev server with `/api` proxied to the local receiver:

```bash
python3 ercot-receiver/server.py
pnpm run dev
```

## Verification

```bash
pnpm run check
pnpm run test:frontend
pnpm run test:receiver
pnpm run test:collector
pnpm run test:e2e
pnpm run test:performance
docker compose build --no-cache
docker compose up -d
```

`pnpm run test:collector:live` performs a one-shot schema/value check against the current ERCOT resources after the collector image has been built. It is intentionally separate from deterministic fixture tests.

## Pre-commit hook

This repo includes a lightweight pre-commit hook at `.githooks/pre-commit` that runs:

```bash
pnpm run validate:commit
```

Enable it once per clone with:

```bash
git config core.hooksPath .githooks
```

## Attribution and sources

Original Datadog dashboard:

```
https://p.datadoghq.com/sb/5c2fc00be-393be929c9c55c3b80b557d08c30787a
```

Source code:

```
https://github.com/venku122/ercot-dashboard
```

The complete source inventory, exact current payload shapes, cadence, timestamp handling, DST behavior, and known limitations are maintained in [docs/ercot-sources.md](docs/ercot-sources.md).
