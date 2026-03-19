import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  publicDir: "public",
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "../ercot-receiver/web",
    emptyOutDir: true,
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
