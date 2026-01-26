# Deployment

Two options: separate containers via Compose (recommended) or a single-container wrapper.

## Option A: Docker Compose (recommended)

From `/Users/tjt/src/vms/agent-vm`:

```bash
docker compose up -d --build
```

Access dashboard:

```
http://<server-ip>:8080/
```

Optional environment:
- `METRICS_API_KEY` in both services to secure ingest.
- `POWEROUTAGE_US_KEY` in collector to enable outage data.

Stop:

```bash
docker compose down
```

## Multi-arch image builds (GHCR)

Use buildx to publish both amd64 and arm64 images:

```bash
docker buildx create --use --name ercot-multi || docker buildx use ercot-multi

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/venku122/ercot-receiver:latest \
  --push ercot-receiver

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/venku122/ercot-collector:latest \
  --push ercot-collector
```

## Option B: Single container (wrapper)

If you prefer a single container, we can build a small supervisor image to run both the receiver and collector in one container. This is not included yet because Compose is simpler and more robust; ask and I’ll add it.

## Firewall

Ensure port `8080` is open to the network you want to access from.
