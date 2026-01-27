FROM denoland/deno:alpine
WORKDIR /src/app

ADD deps.ts ./
RUN ["deno", "cache", "--allow-import", "deps.ts"]

ADD *.ts ./
RUN ["deno", "cache", "--allow-import", "mod.ts"]

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-env", "--cached-only", "--no-check", "mod.ts"]
