import { describe, expect, it } from "vitest";

import { canonicalLatestKey, REFRESH_CADENCE_MS } from "./data-hooks";

describe("overview refresh policy", () => {
  it("deduplicates equivalent latest resources regardless of query or tag order", () => {
    const first = canonicalLatestKey([
      { id: "price", metric: "ercot.pricing", tags: ["market:rt", "zone:houston"] },
      { id: "frequency", metric: "ercot.frequency" },
    ]);
    const second = canonicalLatestKey([
      { id: "frequency", metric: "ercot.frequency", tags: [] },
      { id: "price", metric: "ercot.pricing", tags: ["zone:houston", "market:rt"] },
    ]);

    expect(first).toBe(second);
  });

  it("uses source-aware cadences instead of one global cosmetic timer", () => {
    expect(REFRESH_CADENCE_MS.fastTelemetry).toBe(30_000);
    expect(REFRESH_CADENCE_MS.sourceHealth).toBe(60_000);
    expect(REFRESH_CADENCE_MS.events).toBe(180_000);
    expect(REFRESH_CADENCE_MS.marketAndFiveMinute).toBe(300_000);
  });
});
