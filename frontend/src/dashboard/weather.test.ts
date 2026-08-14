import { describe, expect, it } from "vitest";

import { formatWindCondition } from "./weather";

const point = (value: number) => ({ ts: 1_786_715_700, value });

describe("formatWindCondition", () => {
  it("shows where northwest wind travels and narrates where it originates", () => {
    expect(formatWindCondition(point(12), point(315), point(25))).toEqual({
      accessible: "Wind from northwest at 12 miles per hour, gusting to 25 miles per hour",
      detail: "315° · Gust 25 mph",
      headline: "NW ↘ · 12 mph",
    });
  });

  it("does not invent a direction for calm or variable reports", () => {
    expect(formatWindCondition(point(1), undefined, undefined).headline).toBe("Calm · 1 mph");
    expect(formatWindCondition(point(9), undefined, undefined).headline).toBe("Variable · 9 mph");
  });

  it("keeps gust optional and handles missing speed", () => {
    expect(formatWindCondition(point(8), point(180), undefined).detail).toBe(
      "180° · No gust reported",
    );
    expect(formatWindCondition(undefined, point(180), point(20)).headline).toBe("—");
  });
});
