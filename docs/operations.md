# Operations and rollback

## Local verification

```bash
pnpm install --frozen-lockfile
pnpm run validate:commit
pnpm run test:collector
pnpm run test:collector:live
pnpm run test:performance
pnpm run test:e2e

METRICS_API_KEY=local-dev-key docker compose build --no-cache
METRICS_API_KEY=local-dev-key docker compose up -d
docker compose ps
docker compose logs --no-color --tail=500 receiver collector
```

The Compose file builds local images, waits for the receiver health check before starting the
collector, and uses `local-dev-key` only as a local default.

## Database backup

Do not experiment on the production database. Before rollout, create a consistent copy with the
SQLite backup API or while the receiver is stopped:

```bash
docker compose stop receiver
cp ercot-receiver/data/metrics.db ercot-receiver/data/metrics.db.pre-chart-ux
docker compose start receiver
```

For a live backup, use SQLite `.backup` from a host/container that has the SQLite CLI. Preserve the
database, WAL, Compose environment, and previous image digests in the change record.

## Rollback

The migration is additive and old receiver builds ignore the new tables/nullable column. A normal
rollback is therefore: stop the collector, restore the previous receiver/collector images, and
restart. If database rollback is required, stop the receiver and restore the reviewed copied
database before starting the old image. Never copy only a live main database while discarding an
active WAL.

No production deploy is part of this feature branch.
