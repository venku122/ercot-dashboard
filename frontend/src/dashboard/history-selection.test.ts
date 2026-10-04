import { describe, expect, it } from "vitest";
import { isPreviousSelection, selectionDescription } from "./history-selection";
import type { CompletedSelection } from "./history-selection";

const completed: CompletedSelection = {
  start: 100_000,
  end: 121_600,
  rangeSeconds: 21_600,
  mode: "live",
  paused: false,
  compare: "previous_period",
  customCompareSeconds: 0,
};

describe("completed historical request selection", () => {
  it("retains the same running live selection across incremental clock refreshes", () => {
    expect(
      isPreviousSelection(
        completed,
        { ...completed, start: 100_030, end: 121_630 },
        "previous_period",
        0,
      ),
    ).toBe(false);
    expect(isPreviousSelection(completed, completed, "previous_period", 0)).toBe(false);
  });
  it("distinguishes a changed duration, comparison, custom offset, or fixed bounds", () => {
    expect(
      isPreviousSelection(
        completed,
        { ...completed, start: 35_200, rangeSeconds: 86_400 },
        "previous_period",
        0,
      ),
    ).toBe(true);
    expect(isPreviousSelection(completed, completed, "day", 0)).toBe(true);
    expect(
      isPreviousSelection(
        { ...completed, compare: "custom", customCompareSeconds: 3_600 },
        completed,
        "custom",
        7_200,
      ),
    ).toBe(true);
    expect(
      isPreviousSelection(
        { ...completed, mode: "fixed" },
        { ...completed, mode: "fixed", start: 100_030, end: 121_630 },
        "previous_period",
        0,
      ),
    ).toBe(true);
  });
  it("identifies a disjoint live window after a long suspended-tab clock jump", () => {
    for (const shift of [completed.rangeSeconds, 86400, -86400]) {
      const shifted = { ...completed, start: completed.start + shift, end: completed.end + shift };
      expect(isPreviousSelection(completed, shifted, "previous_period", 0)).toBe(true);
    }
  });
  it("does not invent request provenance and renders the exact completed UTC bounds", () => {
    expect(isPreviousSelection(undefined, completed, "day", 0)).toBe(false);
    expect(selectionDescription(completed)).toBe(
      "1970-01-02T03:46:40.000Z–1970-01-02T09:46:40.000Z · comparison previous period",
    );
  });
});
