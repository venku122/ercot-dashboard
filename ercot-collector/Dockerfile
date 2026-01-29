FROM denoland/deno:alpine
WORKDIR /src/app

ENV DENO_DIR=/deno-dir

ADD deps.ts ./
RUN --mount=type=cache,target=/deno-cache DENO_DIR=/deno-cache deno cache --allow-import deps.ts \
    && mkdir -p /deno-dir \
    && cp -a /deno-cache/. /deno-dir/

ADD *.ts ./
RUN --mount=type=cache,target=/deno-cache DENO_DIR=/deno-cache deno cache --allow-import mod.ts \
    && mkdir -p /deno-dir \
    && cp -a /deno-cache/. /deno-dir/

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-env", "--cached-only", "--no-check", "mod.ts"]
