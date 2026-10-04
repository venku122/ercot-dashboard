import { expect, it } from "vitest";
import { coherentColdOracle } from "../../../e2e/performance-observations";

it("cold readiness waits for matching actual and paired source epochs", () => {
  const sources = new Map([
    ["demand", { timestamp: 900, value: 70000 }],
    ["capacity", { timestamp: 900, value: 90000 }],
    ["headroom", { timestamp: 600, value: 23000 }],
  ]);
  expect(coherentColdOracle(sources, true)).toBeNull();
  sources.set("headroom", { timestamp: 900, value: 20000 });
  expect(coherentColdOracle(sources, true)).toEqual({
    demand: "70.0 GW",
    capacity: "90.0 GW",
    headroom: "20.0 GW",
  });
  sources.delete("headroom");
  expect(coherentColdOracle(sources, true)).toBeNull();
  expect(coherentColdOracle(sources, false)?.headroom).toBe("20.0 GW");
  sources.set("capacity", { timestamp: 1200, value: 90000 });
  expect(coherentColdOracle(sources, false)).toBeNull();
});
