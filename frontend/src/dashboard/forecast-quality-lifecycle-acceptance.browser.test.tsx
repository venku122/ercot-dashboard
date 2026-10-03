// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForecastQualityPanel } from "./ForecastQualityPanel";

afterEach(() => vi.unstubAllGlobals());

describe("independent forecast-quality request lifecycle", () => {
  it("does not fetch before disclosure and aborts the manifest when collapsed", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing_abort_signal");
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <ForecastQualityPanel enabled />
        </SWRConfig>,
      );
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Load quality details")!
        .click();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/v1/forecast-quality");
    expect(signals[0]!.aborted).toBe(false);

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Hide quality details")!
        .click();
    });
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => root.unmount());
  });
});
