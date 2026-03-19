import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "ercot-receiver/web/**",
    "frontend/public/vendor/**",
    "node_modules/**",
    ".sisyphus/**",
  ],
  overrides: [
    {
      files: ["frontend/src/legacy/app.js"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
