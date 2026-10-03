import { describe, expect, it } from "vitest";

import {
  forecastQualityManifest,
  forecastQualityResource,
  netLoadDailyResource,
  netLoadManifest,
  netLoadResource,
} from "../../../e2e/review-evidence-fixtures";
import { parseForecastQualityManifest, parseForecastQualityResource } from "./forecast-quality";
import { parseNetLoadDailyResource, parseNetLoadManifest, parseNetLoadResource } from "./net-load";

describe("deterministic review evidence fixtures", () => {
  it("passes the production forecast-quality parsers", () => {
    const manifest = parseForecastQualityManifest(forecastQualityManifest);
    expect(
      parseForecastQualityResource(forecastQualityResource, manifest.resources[0]).rows,
    ).toHaveLength(24);
  });

  it("passes the production net-load parsers", () => {
    const manifest = parseNetLoadManifest(netLoadManifest);
    expect(parseNetLoadResource(netLoadResource, manifest.resources[0]).rows).toHaveLength(288);
    expect(
      parseNetLoadDailyResource(netLoadDailyResource, manifest.daily_resources[0]).daily_ramp,
    ).not.toBeNull();
  });
});
