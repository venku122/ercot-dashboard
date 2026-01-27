FROM denoland/deno:alpine
WORKDIR /src/app

ENV DENO_DIR=/deno-dir

ADD deps.ts ./
RUN --mount=type=cache,target=/deno-dir ["deno", "cache", "--allow-import", "deps.ts"]

ADD *.ts ./
RUN --mount=type=cache,target=/deno-dir ["deno", "cache", "--allow-import", "mod.ts"]

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-env", "--cached-only", "--no-check", "mod.ts"]
