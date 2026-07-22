import { describe, expect, it } from "vitest";

import { chartInteractionPolicy } from "./interaction-policy";

describe("mobile chart interaction policy", () => {
  it("reserves ordinary mobile gestures for vertical page scrolling", () => {
    expect(chartInteractionPolicy({ inspect: false, mobile: true })).toEqual({
      cursorPin: false,
      dragZoom: false,
      pan: false,
      panModifier: undefined,
      pinchZoom: false,
      policyName: "mobile-scroll",
      wheelZoom: false,
    });
  });

  it("enables deliberate analysis gestures only in inspect mode", () => {
    expect(chartInteractionPolicy({ inspect: true, mobile: true })).toMatchObject({
      cursorPin: true,
      pan: true,
      panModifier: undefined,
      pinchZoom: true,
      policyName: "inspect",
    });
  });
});
