import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  root: "frontend",
  publicDir: "public",
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "ercot-build-identity",
      transformIndexHtml() {
        let revision = "unknown";
        try {
          revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
