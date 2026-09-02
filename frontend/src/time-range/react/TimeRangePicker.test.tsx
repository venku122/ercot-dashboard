// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFixedRange,
  createRelativeRange,
  TimeRangePicker,
  type TimeRangePickerProps,
} from "../index";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-01T18:00:00Z");
const baseProps: TimeRangePickerProps = {
  calendarPresets: [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
  ],
  config: {
    defaultTimezone: "America/Chicago",
    locale: "en-US",
    maxDurationMs: 365 * 24 * HOUR,
    minDurationMs: 5 * 60_000,
  },
  nowMs: NOW,
  onCommit: () => {},
  presets: [
    { durationMs: HOUR, id: "past-hour", label: "Past 1 hour" },
    { durationMs: 6 * HOUR, id: "past-6-hours", label: "Past 6 hours" },
  ],
  timezoneOptions: ["America/Chicago", "UTC"],
  value: createRelativeRange(6 * HOUR, "past-6-hours", "America/Chicago"),
};

function button(container: ParentNode, name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`missing_button:${name}`);
  return match;
}

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("controlled TimeRangePicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function render(overrides: Partial<TimeRangePickerProps> = {}) {
    await act(async () => root.render(<TimeRangePicker {...baseProps} {...overrides} />));
  }

  it("TR-UI-002/003/007 and TR-PERF-002 commit a preset once with an honest live label", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose time range"]')!;
    expect(trigger.textContent).toContain("Past 6 hours");
    expect(trigger.textContent).toContain("Live");
    act(() => trigger.click());
    act(() => button(document, "Past 1 hour").click());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toEqual(
      createRelativeRange(HOUR, "past-hour", "America/Chicago"),
    );
  });

  it("TR-UI-007/008 edits a draft without committing and Cancel preserves the value", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose time range"]')!;
    act(() => trigger.click());
    const from = document.querySelector<HTMLInputElement>('[aria-label="From"]')!;
    act(() => setInput(from, "2026-09-01T08:00"));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => button(document, "Cancel").click());
    expect(onCommit).not.toHaveBeenCalled();
    expect(trigger).toBe(document.activeElement);
  });

  it("TR-UI-006/009 rejects nonexistent and unresolved ambiguous Chicago times specifically", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Choose time range"]')!.click(),
    );
    const from = document.querySelector<HTMLInputElement>('[aria-label="From"]')!;
    const to = document.querySelector<HTMLInputElement>('[aria-label="To"]')!;
    act(() => {
      setInput(from, "2026-03-08T02:30");
      setInput(to, "2026-03-08T04:30");
      button(document, "Apply").click();
    });
    expect(document.body.textContent).toContain("From is not a real local time because of DST");
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      setInput(from, "2026-11-01T01:30");
      setInput(to, "2026-11-01T03:30");
      button(document, "Apply").click();
    });
    expect(document.body.textContent).toContain("Choose the earlier or later occurrence for From");
    expect(document.querySelector('[aria-label="From occurrence"]')).not.toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("TR-UI-013 closes on Escape and restores trigger focus", async () => {
    await render();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose time range"]')!;
    act(() => trigger.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("TR-MOD-004/006 proves a non-ERCOT second consumer and independent instances", async () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    await act(async () =>
      root.render(
        <>
          <TimeRangePicker
            {...baseProps}
            config={{
              defaultTimezone: "America/New_York",
              locale: "en-US",
              maxDurationMs: 48 * HOUR,
              minDurationMs: 15 * 60_000,
            }}
            labels={{ trigger: "Analysis interval" }}
            onCommit={firstCommit}
            presets={[{ durationMs: 2 * HOUR, id: "two-hours", label: "Trailing two hours" }]}
            timezoneOptions={["America/New_York", "UTC"]}
            value={createRelativeRange(2 * HOUR, "two-hours", "America/New_York")}
          />
          <TimeRangePicker
            {...baseProps}
            onCommit={secondCommit}
            value={createFixedRange(NOW - HOUR, NOW, "custom", undefined, "UTC")}
          />
        </>,
      ),
    );
    const triggers = [...container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')];
    expect(triggers[0]!.getAttribute("aria-label")).toBe("Analysis interval");
    act(() => triggers[0]!.click());
    act(() => button(document, "Trailing two hours").click());
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(secondCommit).not.toHaveBeenCalled();
  });
});
