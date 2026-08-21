#!/usr/bin/env node

import { parseTileCatalog, planTileRequests } from "../frontend/src/dashboard/tile-planner.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const options = JSON.parse(input);
const catalog = parseTileCatalog(options.catalog);
const entry = catalog.series.find((candidate) => candidate.key === options.seriesKey);
if (!entry) throw new Error("benchmark_series_missing_from_catalog");

function plannedWindows(correctionHorizonSeconds) {
  return Object.fromEntries(
    options.windows.map(([label, span]) => {
      const request = {
        catalog,
        end: options.end,
        entry,
        now: options.now,
        start: options.end - span,
      };
      if (correctionHorizonSeconds !== undefined) {
        request.correctionHorizonSeconds = correctionHorizonSeconds;
      }
      return [label, planTileRequests(request).map((tile) => tile.url)];
    }),
  );
}

const implicitDefaultWindows = plannedWindows(undefined);
const explicitHorizonWindows = plannedWindows(options.correctionHorizonSeconds);
const defaultMatchesExplicit =
  JSON.stringify(implicitDefaultWindows) === JSON.stringify(explicitHorizonWindows);
if (!defaultMatchesExplicit) throw new Error("frontend_planner_default_horizon_drift");

process.stdout.write(
  JSON.stringify({
    correction_horizon_seconds: options.correctionHorizonSeconds,
    default_matches_explicit_horizon: defaultMatchesExplicit,
    planner_module: "frontend/src/dashboard/tile-planner.ts",
    series_key: entry.key,
    supported_lods: entry.supported_lods,
    windows: implicitDefaultWindows,
  }),
);
