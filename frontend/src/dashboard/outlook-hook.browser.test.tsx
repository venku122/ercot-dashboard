// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOutlookData } from "./data-hooks";
import { OutlookContent } from "./OutlookView";
import type { GridOutlook } from "./outlook";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Outlook request lifecycle", () => {
  it("does not fetch while disabled and aborts on disable and unmount", async () => {
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

    function Probe({ enabled }: { enabled: boolean }) {
      useOutlookData(enabled);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (enabled: boolean) =>
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <Probe enabled={enabled} />
        </SWRConfig>,
      );

    await act(async () => render(false));
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => render(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(signals[0]!.aborted).toBe(false);

    await act(async () => render(false));
    expect(signals[0]!.aborted).toBe(true);

    await act(async () => render(true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => root.unmount());
    expect(signals[1]!.aborted).toBe(true);
  });

  it("reveals the selected delivery day's hourly detail", async () => {
    const cards = ["2027-01-15", "2027-01-16"].map((deliveryDate, index) => ({
      deliveryDate,
      peakDemandMw: 70_000 + index,
      peakRevisionMw: 100,
      peakTargetTs: 1_800_003_600 + index * 86_400,
      projectedHeadroomMw: 10_000 - index,
      tightestTargetTs: 1_800_003_600 + index * 86_400,
    }));
    const outlook: GridOutlook = {
      cards,
      days: cards.map((card) => ({
        card,
        hours: [
          {
            targetTs: card.peakTargetTs!,
            demandMw: card.peakDemandMw,
            projectedHeadroomMw: card.projectedHeadroomMw,
            revisionMw: card.peakRevisionMw,
          },
        ],
      })),
      next24Hours: [
        [1_800_003_600, 70_000],
        [1_800_007_200, 70_100],
      ],
      projectedPeakMw: 70_001,
      projectedPeakTargetTs: cards[1]!.peakTargetTs,
      tightestHeadroomMw: 9_999,
      tightestTargetTs: cards[1]!.tightestTargetTs,
      forecastIssuedAt: 1_800_000_000,
      forecastAgeSeconds: 300,
      forecastModel: "A3",
      forecastSourceHealth: null,
      adequacySourceHealth: null,
      sourceLabel: "ERCOT forecast",
      weather: {
        state: "current_observations_only",
        forecast_driver_available: false,
        driver: null,
        source: null,
        observations: [],
      },
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<OutlookContent outlook={outlook} />));
    const first = host.querySelector<HTMLElement>("#outlook-day-detail-2027-01-15")!;
    const second = host.querySelector<HTMLElement>("#outlook-day-detail-2027-01-16")!;
    const buttonNames = [...host.querySelectorAll("[data-outlook-day] button")].map(
      (button) => button.textContent,
    );
    expect(new Set(buttonNames).size).toBe(2);
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-outlook-day="2027-01-16"] button')!.click();
    });

    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    expect(
      host.querySelector('[data-outlook-day="2027-01-16"] button')?.getAttribute("aria-pressed"),
    ).toBe("true");

    const refreshed = { ...outlook, cards: [cards[0]!], days: [outlook.days[0]!] };
    await act(async () => root.render(<OutlookContent outlook={refreshed} />));
    expect(host.querySelector<HTMLElement>("#outlook-day-detail-2027-01-15")!.hidden).toBe(false);
    expect(
      host.querySelector('[data-outlook-day="2027-01-15"] button')?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => root.unmount());
  });
});
