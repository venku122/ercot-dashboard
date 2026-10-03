import {
  NWS_GRID_LAYERS,
  NWS_WEATHER_POINTS,
  parseNwsGridData,
  parseNwsPoint,
  parseNwsTexasAlerts,
  pointUrl,
  validateNwsLinkedUrl,
} from "./nws_weather.ts";

async function fixture(name: string) {
  return JSON.parse(await Deno.readTextFile(new URL(`./fixtures/nws/${name}`, import.meta.url)));
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function throws(code: string, callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message === code) return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("NWS registry is exactly the four reviewed airport points", () => {
  equal(Object.keys(NWS_WEATHER_POINTS), ["KDFW", "KAUS", "KHOU", "KSAT"]);
  equal(pointUrl("KDFW"), "https://api.weather.gov/points/32.8974,-97.0220");
});

Deno.test("point mapping accepts only exact api.weather.gov raw-grid links", async () => {
  equal(await parseNwsPoint("KDFW", await fixture("point.kdfw.json")), {
    forecast_grid_data_url: "https://api.weather.gov/gridpoints/FWD/81,109",
    grid_id: "FWD",
    grid_x: 81,
    grid_y: 109,
    point_id: "KDFW",
    time_zone: "America/Chicago",
  });
  for (const link of [
    "http://api.weather.gov/gridpoints/FWD/80,109",
    "https://evil.test/gridpoints/FWD/80,109",
    "https://api.weather.gov/gridpoints/FWD/80,109/forecast",
    "https://api.weather.gov/gridpoints/FWD/80,109?x=1",
  ]) {
    throws("nws_link_invalid", () => validateNwsLinkedUrl(link, "grid"));
  }
});

Deno.test("grid parser freezes six exact layers, units, intervals, and null gaps", async () => {
  equal(Object.entries(NWS_GRID_LAYERS), [
    ["temperature", "wmoUnit:degC"],
    ["apparentTemperature", "wmoUnit:degC"],
    ["heatIndex", "wmoUnit:degC"],
    ["windChill", "wmoUnit:degC"],
    ["windSpeed", "wmoUnit:km_h-1"],
    ["windGust", "wmoUnit:km_h-1"],
  ]);
  const parsed = parseNwsGridData("KDFW", await fixture("grid.kdfw.json"));
  equal(parsed.layers.windChill.values[0]?.value, null);
  const windChill = parsed.layers.windChill.values[0];
  if (!windChill) throw new Error("expected wind chill fixture row");
  equal(windChill.end_ts - windChill.start_ts, 8 * 86_400 + 3_600);
  const wrong = await fixture("grid.kdfw.json");
  wrong.properties.windSpeed.uom = "wmoUnit:mi_h-1";
  throws("nws_grid_layer_invalid", () => parseNwsGridData("KDFW", wrong));
  const overlap = await fixture("grid.kdfw.json");
  overlap.properties.temperature.values.push({
    validTime: "2026-08-20T00:30:00+00:00/PT1H",
    value: 39.1,
  });
  throws("nws_grid_order", () => parseNwsGridData("KDFW", overlap));
});

Deno.test("Texas alert parser retains official update references and text without executing it", async () => {
  const alerts = parseNwsTexasAlerts(await fixture("alerts.tx.json"));
  equal(alerts.items.length, 1);
  equal(alerts.items[0]?.message_type, "Update");
  equal(alerts.items[0]?.references[0]?.identifier, "urn:oid:2.49.0.1.840.0.prior.001.1");
  equal(alerts.items[0]?.description, "Heat context <script>alert(1)</script>");
  equal(parseNwsTexasAlerts({ features: [], updated: "2026-08-20T09:15:12+00:00" }).items, []);
  equal(
    parseNwsTexasAlerts({
      features: [],
      pagination: {
        next: "https://api.weather.gov/alerts/active?area=TX&status=actual&cursor=next",
      },
      updated: "2026-08-20T09:15:12+00:00",
    }).truncated,
    true,
  );
  throws("nws_alerts_pagination", () =>
    parseNwsTexasAlerts({
      features: [],
      pagination: { next: "https://evil.test/alerts/active?area=TX" },
      updated: "2026-08-20T09:15:12+00:00",
    }),
  );
  const nonActual = await fixture("alerts.tx.json");
  nonActual.features[0].properties.status = "Test";
  throws("nws_alert_status", () => parseNwsTexasAlerts(nonActual));
  const duplicateZone = await fixture("alerts.tx.json");
  duplicateZone.features[0].properties.affectedZones.push(
    duplicateZone.features[0].properties.affectedZones[0],
  );
  throws("nws_alert_zones", () => parseNwsTexasAlerts(duplicateZone));
  const reversedTime = await fixture("alerts.tx.json");
  reversedTime.features[0].properties.expires = "2026-08-19T20:00:00-05:00";
  throws("nws_alert_time_order", () => parseNwsTexasAlerts(reversedTime));
});
