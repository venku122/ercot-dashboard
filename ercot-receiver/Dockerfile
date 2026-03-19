FROM node:22-bookworm-slim AS web-build

WORKDIR /src

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json vite.config.ts oxlint.config.ts /src/
COPY frontend /src/frontend

RUN mkdir -p /src/ercot-receiver/web

RUN pnpm install --frozen-lockfile && pnpm build

FROM python:3.12-slim

WORKDIR /app

COPY ercot-receiver/server.py /app/server.py
COPY --from=web-build /src/ercot-receiver/web /app/web

RUN mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["python", "/app/server.py"]
