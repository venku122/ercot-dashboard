import { describe, expect, it } from "vitest";

import { dataLifecycleCopy, resolveDataLifecycleState } from "./data-lifecycle";

describe("data lifecycle states", () => {
  it("distinguishes loading, first-sample wait, and request failure", () => {
    expect(resolveDataLifecycleState({ hasData: false, loading: true, unavailable: false })).toBe(
      "loading",
    );
    expect(resolveDataLifecycleState({ hasData: false, loading: false, unavailable: false })).toBe(
      "waiting",
    );
    expect(resolveDataLifecycleState({ hasData: false, loading: false, unavailable: true })).toBe(
      "unavailable",
    );
  });

  it("keeps existing observations ready during refreshes and failed updates", () => {
    expect(resolveDataLifecycleState({ hasData: true, loading: true, unavailable: true })).toBe(
      "ready",
    );
  });

  it("uses the required user-facing lifecycle language", () => {
    expect(dataLifecycleCopy.loading.title).toBe("Loading…");
    expect(dataLifecycleCopy.waiting.title).toBe("Waiting for first sample…");
    expect(dataLifecycleCopy.unavailable.title).toBe("Temporarily unavailable…");
  });
});
