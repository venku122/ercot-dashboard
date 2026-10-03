import {
  ConditionalNwsClient,
  nwsWeatherRuntimeConfig,
  type NwsWeatherTransport,
  runNwsWeatherCycle,
} from "./nws_weather_runner.ts";
import {
  NWS_WEATHER_POINTS,
  type NwsGridPayload,
  type NwsPointId,
  type NwsWeatherPublication,
} from "./nws_weather.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("runtime is disabled by default and fails closed without contact identity", () => {
  equal(nwsWeatherRuntimeConfig({ get: () => undefined }), { enabled: false });
  let failed = false;
  try {
    nwsWeatherRuntimeConfig({
      get: (name) => (name === "NWS_WEATHER_INGEST_ENABLED" ? "true" : undefined),
    });
  } catch (error) {
    failed = error instanceof Error && error.message === "nws_runtime_config";
  }
  equal(failed, true);
});

Deno.test("conditional client identifies itself, rate-bounds requests, and revalidates", async () => {
  const requests: RequestInit[] = [];
  let calls = 0;
  const client = new ConditionalNwsClient(
    "ercot-grid-observatory (https://example.test/contact)",
    (_url, init) => {
      requests.push(init ?? {});
      calls++;
      if (calls === 2) {
        return Promise.resolve(
          new Response(null, {
            status: 304,
            headers: { "cache-control": "max-age=5" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            etag: '"v1"',
            "last-modified": "Wed, 20 Aug 2026 00:00:00 GMT",
          },
        }),
      );
    },
  );
  await client.get("https://api.weather.gov/test", 1_000, 1_024, 60, 60, 300);
  await client.get("https://api.weather.gov/test", 1_030, 1_024, 60, 60, 300);
  equal(calls, 1);
  await client.get("https://api.weather.gov/test", 1_061, 1_024, 60, 60, 300);
  equal(calls, 2);
  const headers = new Headers(requests[1]?.headers);
  equal(headers.get("if-none-match"), '"v1"');
  equal(headers.get("if-modified-since"), "Wed, 20 Aug 2026 00:00:00 GMT");
  equal(headers.get("user-agent"), "ercot-grid-observatory (https://example.test/contact)");
});

Deno.test("mapping failure uses explicit stale cache for at most 24 hours", async () => {
  let calls = 0;
  const client = new ConditionalNwsClient(
    "ercot-grid-observatory (https://example.test/contact)",
    () => {
      calls++;
      if (calls > 1) return Promise.reject(new Error("offline"));
      return Promise.resolve(new Response(JSON.stringify({ mapping: true })));
    },
  );
  await client.get("https://api.weather.gov/points/test", 1_000, 1_024, 60, 60, 86_400);
  const stale = await client.get(
    "https://api.weather.gov/points/test",
    1_061,
    1_024,
    60,
    60,
    86_400,
  );
  equal(stale.stale, true);
  let unavailable = false;
  try {
    await client.get("https://api.weather.gov/points/test", 87_401, 1_024, 60, 60, 86_400);
  } catch {
    unavailable = true;
  }
  equal(unavailable, true);
});

Deno.test("cycle with one failed grid does not publish a partial forecast", async () => {
  const publications: NwsWeatherPublication[] = [];
  const health: Record<string, unknown>[][] = [];
  const transport: NwsWeatherTransport = {
    point: (pointId) =>
      Promise.resolve({
        freshUntil: 1_777_086_400,
        stale: false,
        validatedAt: 1_777_000_000,
        value: {
          forecast_grid_data_url: `https://api.weather.gov/gridpoints/FWD/80,${
            Object.keys(NWS_WEATHER_POINTS).indexOf(pointId) + 100
          }`,
          grid_id: "FWD",
          grid_x: 80,
          grid_y: Object.keys(NWS_WEATHER_POINTS).indexOf(pointId) + 100,
          point_id: pointId,
          time_zone: "America/Chicago",
        },
      }),
    grid: (pointId: NwsPointId) => {
      if (pointId === "KHOU") {
        return Promise.reject(new Error("nws_http_503"));
      }
      const empty = (unit: string) => ({ unit, values: [] });
      return Promise.resolve({
        freshUntil: 1_777_000_900,
        stale: false,
        validatedAt: 1_777_000_000,
        value: {
          layers: {
            apparentTemperature: empty("wmoUnit:degC"),
            heatIndex: empty("wmoUnit:degC"),
            temperature: empty("wmoUnit:degC"),
            windChill: empty("wmoUnit:degC"),
            windGust: empty("wmoUnit:km_h-1"),
            windSpeed: empty("wmoUnit:km_h-1"),
          },
          point_id: pointId,
          source_updated_at: 1_777_000_000,
        } satisfies NwsGridPayload,
      });
    },
    alerts: () =>
      Promise.resolve({
        freshUntil: 1_777_000_160,
        stale: false,
        validatedAt: 1_777_000_100,
        value: {
          collection_updated_at: 1_777_000_000,
          items: [],
          truncated: false,
        },
      }),
    ingest: (payload) => {
      publications.push(payload);
      return Promise.resolve();
    },
    saveHealth: (attempts) => {
      health.push(attempts);
      return Promise.resolve();
    },
  };
  let failed = false;
  try {
    await runNwsWeatherCycle(transport, 1_777_000_100);
  } catch {
    failed = true;
  }
  equal(failed, true);
  equal(publications.length, 1);
  equal(publications[0]?.stream, "alerts");
  equal(health[0]?.length, 2);
  equal(health[0]?.find((item) => item.source_id === "nws_grid_forecast")?.success, false);
  equal(
    health[0]?.find((item) => item.source_id === "nws_alerts_tx")?.availability_status,
    "empty",
  );
});

Deno.test("cycle publishes one exact-order atomic forecast and one alerts stream", async () => {
  const publications: NwsWeatherPublication[] = [];
  const empty = (unit: string) => ({ unit, values: [] });
  const transport: NwsWeatherTransport = {
    point: (pointId) =>
      Promise.resolve({
        freshUntil: 1_777_086_400,
        stale: false,
        validatedAt: 1_777_000_000,
        value: {
          forecast_grid_data_url: `https://api.weather.gov/gridpoints/FWD/80,${
            Object.keys(NWS_WEATHER_POINTS).indexOf(pointId) + 100
          }`,
          grid_id: "FWD",
          grid_x: 80,
          grid_y: Object.keys(NWS_WEATHER_POINTS).indexOf(pointId) + 100,
          point_id: pointId,
          time_zone: "America/Chicago",
        },
      }),
    grid: (pointId) =>
      Promise.resolve({
        freshUntil: 1_777_000_900,
        stale: false,
        validatedAt: 1_777_000_000,
        value: {
          layers: {
            apparentTemperature: empty("wmoUnit:degC"),
            heatIndex: empty("wmoUnit:degC"),
            temperature: empty("wmoUnit:degC"),
            windChill: empty("wmoUnit:degC"),
            windGust: empty("wmoUnit:km_h-1"),
            windSpeed: empty("wmoUnit:km_h-1"),
          },
          point_id: pointId,
          source_updated_at: 1_777_000_000,
        },
      }),
    alerts: () =>
      Promise.resolve({
        freshUntil: 1_777_000_160,
        stale: false,
        validatedAt: 1_777_000_100,
        value: {
          collection_updated_at: 1_777_000_000,
          items: [],
          truncated: false,
        },
      }),
    ingest: (payload) => {
      publications.push(payload);
      return Promise.resolve();
    },
    saveHealth: () => Promise.resolve(),
  };
  await runNwsWeatherCycle(transport, 1_777_000_100);
  equal(
    publications.map((item) => item.stream),
    ["forecast", "alerts"],
  );
  const forecast = publications[0];
  equal(forecast?.stream === "forecast" ? forecast.points.map((point) => point.point_id) : [], [
    "KDFW",
    "KAUS",
    "KHOU",
    "KSAT",
  ]);
});
