import { expect, it } from "vitest";
import * as budget from "../../../e2e/performance-budget";
it("ERP06 rejects excessive cold or pointer measurements, blank readouts and undersampling", () => {
  const api = budget as unknown as {
    evaluatePerformanceBudget?: (value: unknown) => { pass: boolean };
  };
  expect(api.evaluatePerformanceBudget).toBeTypeOf("function");
  const valid = {
    coldMs: [2200, 2300, 2400, 2450, 2500],
    pointerMs: Array.from({ length: 200 }, () => 35),
    readoutChanges: 200,
    hoverHistoryRequests: 0,
  };
  expect(api.evaluatePerformanceBudget!(valid).pass).toBe(true);
  for (const bad of [
    { ...valid, coldMs: [3000, 3100, 3200, 3300, 3400] },
    { ...valid, pointerMs: Array.from({ length: 200 }, () => 60) },
    { ...valid, readoutChanges: 0 },
    { ...valid, readoutChanges: NaN },
    { ...valid, readoutChanges: 201 },
    { ...valid, pointerMs: [20] },
    { ...valid, hoverHistoryRequests: 1 },
  ])
    expect(api.evaluatePerformanceBudget!(bad).pass).toBe(false);
});
