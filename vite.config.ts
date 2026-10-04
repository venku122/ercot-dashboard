import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  root: "frontend",
  publicDir: "public",
  plugins: [
    {
      name: "preload-overview-catalog",
      transformIndexHtml: {
        order: "post",
        handler() {
          return [
            {
              tag: "script",
              children: `if ((new URLSearchParams(location.search).get("view") || "overview") === "overview") {
              const catalog = document.createElement("link");
              catalog.rel = "preload";
              catalog.as = "fetch";
              catalog.crossOrigin = "anonymous";
              catalog.href = "/api/v2/tile-catalog?include=paired-headroom";
              document.head.append(catalog);
            }`,
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
    {
      name: "preload-first-useful-chart",
      transformIndexHtml: {
        order: "post",
        handler(_html, context) {
          const chunk = Object.values(context.bundle ?? {}).find(
            (output) => output.type === "chunk" && output.name === "ChartCard",
          );
          return chunk
            ? [
                {
                  tag: "link",
                  attrs: { rel: "modulepreload", href: `/${chunk.fileName}` },
                  injectTo: "head",
                },
              ]
            : [];
        },
      },
    },
    tailwindcss(),
    react(),
    {
      name: "ercot-build-identity",
      transformIndexHtml() {
        let revision = "unknown";
        try {
          revision = execFileSync(
            "git",
            ["-c", `safe.directory=${process.cwd()}`, "rev-parse", "HEAD"],
            { encoding: "utf8" },
          ).trim();
        } catch {
          /* Source archives can be built without Git metadata. */
        }
        return [
          {
            tag: "meta",
            attrs: { name: "ercot-build-revision", content: revision },
            injectTo: "head",
          },
        ];
      },
    },
  ],
  build: {
    outDir: "../ercot-receiver/web",
    emptyOutDir: true,
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: loadEnv(mode, ".")["VITE_API_PROXY_TARGET"] ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
}));
