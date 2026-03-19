# ERCOT Grid Monitor

Live ERCOT grid metrics with a self-hosted collector, receiver, and dashboard UI.

Live site:

```
https://ercot.tarazevits.io
```

## What this is

Hello, I am a Texas resident and the health and status of the Texas power grid is of immense importance to me and my family. This project was originally created by @danopia and visualized in Datadog. This is a fork/reimplementation of that with self-hosted data collection and dashboards. Ironically, this site is hosted in Texas and if the Texas power grid goes down, so will this site!

## Quick start (Docker)

```
docker compose up -d
```

The dashboard will be available at:

```
http://localhost:8080
```

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

## Attribution and sources

Original Datadog dashboard:

```
https://p.datadoghq.com/sb/5c2fc00be-393be929c9c55c3b80b557d08c30787a
```

Source code:

```
https://github.com/venku122/ercot-dashboard
```

Data sources:

```
http://www.ercot.com/content/cdr/html/real_time_system_conditions.html
http://www.ercot.com/content/cdr/html/as_capacity_monitor.html
http://www.ercot.com/content/cdr/html/real_time_spp
http://www.ercot.com/content/alerts/conservation_state.js
https://www.aviationweather.gov/metar/data
https://poweroutage.us
```
