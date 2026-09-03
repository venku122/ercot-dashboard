import { describe, expect, it } from "vitest";

import { shouldCommitRequest } from "./request-generation";

describe("request generation guard", () => {
  it("TR-INT-007 ignores a slow obsolete response after a newer request settles", async () => {
    let releaseOld!: (value: string) => void;
    const oldResponse = new Promise<string>((resolve) => (releaseOld = resolve));
    const newResponse = Promise.resolve("new window");
    const controller = new AbortController();
    let currentGeneration = 1;
    let committed = "";

    const oldSettlement = oldResponse.then((value) => {
      if (shouldCommitRequest(1, currentGeneration, controller.signal)) committed = value;
    });
    currentGeneration = 2;
    await newResponse.then((value) => {
      if (shouldCommitRequest(2, currentGeneration, controller.signal)) committed = value;
    });
    releaseOld("obsolete window");
    await oldSettlement;

    expect(committed).toBe("new window");
  });

  it("rejects an aborted response even when its generation is current", () => {
    const controller = new AbortController();
    controller.abort();
    expect(shouldCommitRequest(3, 3, controller.signal)).toBe(false);
  });
});
