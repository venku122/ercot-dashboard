import { runLongHorizonProducts } from "./long_horizon_runner.ts";

function assert(condition: unknown, message = "assertion_failed"): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("source collection failure reports only that stream and peer still ingests", async () => {
  const ingested: string[] = [];
  const failures: string[] = [];
  let thrown: unknown;
  try {
    await runLongHorizonProducts({
      collectGis: () => Promise.reject(new Error("bounded_source_failure")),
      collectTrend: () => Promise.resolve({ stream: "resource_capacity_trend" }),
      collectLtlf: () => Promise.resolve({ stream: "long_term_load_forecast" }),
      ingest: (payload) => {
        ingested.push(String(payload.stream));
        return Promise.resolve();
      },
      reportFailure: (stream) => {
        failures.push(stream);
        return Promise.resolve();
      },
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof Error && thrown.message === "bounded_source_failure");
  assert(
    JSON.stringify(ingested) ===
      JSON.stringify(["resource_capacity_trend", "long_term_load_forecast"]),
  );
  assert(JSON.stringify(failures) === JSON.stringify(["gis"]));
});

Deno.test("next successful collection ingests recovery without a failure report", async () => {
  const ingested: string[] = [];
  const failures: string[] = [];
  await runLongHorizonProducts({
    collectGis: () => Promise.resolve({ stream: "gis" }),
    collectTrend: () => Promise.resolve({ stream: "resource_capacity_trend" }),
    collectLtlf: () => Promise.resolve({ stream: "long_term_load_forecast" }),
    ingest: (payload) => {
      ingested.push(String(payload.stream));
      return Promise.resolve();
    },
    reportFailure: (stream) => {
      failures.push(stream);
      return Promise.resolve();
    },
  });

  assert(
    JSON.stringify(ingested) ===
      JSON.stringify(["gis", "resource_capacity_trend", "long_term_load_forecast"]),
  );
  assert(failures.length === 0);
});
