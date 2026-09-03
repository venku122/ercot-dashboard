// @vitest-environment jsdom

import { act, type CSSProperties } from "react";
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
    defaultRelativeRange: { durationMs: 6 * HOUR, presetId: "past-6-hours" },
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

function byTextButton(root: ParentNode, name: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(name),
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

describe("DRUIDS-conformant controlled TimeRangePicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (callback) => {
      callback(0);
      return 0;
    };
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

  function editor(rootNode: ParentNode = container) {
    return rootNode.querySelector<HTMLInputElement>('[aria-label="Time range picker"]')!;
  }

  function open() {
    act(() => editor().click());
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it("DD-UI-001/002 and TR-PERF-002 render the compact cluster and commit a preset once", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    expect(editor().value).toBe("Past 6 Hours");
    expect(container.querySelector('[aria-label="Step back"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Pause"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Step forward"]')).not.toBeNull();
    const dialog = open();
    expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => byTextButton(dialog, "Past 1 hour").click());
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]![0]).toEqual(
      createRelativeRange(HOUR, "past-hour", "America/Chicago"),
    );
  });

  it("DD-UI-010 keeps draft edits request/commit silent until Enter", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    open();
    act(() => setInput(editor(), "Jan 1 - Jan 2"));
    expect(onCommit).not.toHaveBeenCalled();
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]![0].selection.kind).toBe("fixed");
  });

  it("keeps malformed and unchanged drafts commit-silent and preserves preset identity", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    open();
    act(() => setInput(editor(), "not a time"));
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(onCommit).not.toHaveBeenCalled();
    act(() => setInput(editor(), "Past 6 Hours"));
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("validates every configured preset and restores timezone/calendar configuration", async () => {
    const onCommit = vi.fn();
    const formatValidationError = vi.fn(() => "consumer bounds message");
    await render({
      formatValidationError,
      onCommit,
      presets: [{ durationMs: 60_000, id: "too-short", label: "Too short" }],
    });
    let dialog = open();
    act(() => byTextButton(dialog, "Too short").click());
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "consumer bounds message",
    );
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    dialog = open();
    act(() => byTextButton(dialog, "More").click());
    act(() => byTextButton(document, "Today").click());
    expect(onCommit.mock.calls[0]![0].selection).toMatchObject({
      kind: "calendar",
      preset: "today",
    });
    await render({ onCommit });
    dialog = open();
    act(() => byTextButton(dialog, "More").click());
    const timezone = document.querySelector<HTMLSelectElement>('[aria-label="Timezone"]')!;
    act(() => setInput(timezone, "UTC"));
    expect(onCommit.mock.calls.at(-1)![0].timezone).toBe("UTC");
  });

  it("reports the failing endpoint and keeps exactly one keyboard-active option selected", async () => {
    const formatDraftError = vi.fn(() => "consumer draft message");
    await render({ formatDraftError });
    let dialog = open();
    act(() => setInput(editor(), "Jan 1, 2026 - bad end"));
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(formatDraftError).toHaveBeenCalledWith("invalid", "to");
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    dialog = open();
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
    );
    expect(dialog.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
  });

  it("DD-UI-003 opens the syntax sidecar and examples compile through the parser", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    const dialog = open();
    act(() => byTextButton(dialog, "More").click());
    expect(document.querySelector('[aria-label="Custom time examples"]')?.textContent).toContain(
      "Type custom times like:",
    );
    act(() => byTextButton(document, "since 8/1").click());
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]![0].selection.kind).toBe("growing");
  });

  it("DD-UI-004/005 uses a two-click single-month full-day calendar", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    const dialog = open();
    act(() => byTextButton(dialog, "Select from calendar…").click());
    const first = document.querySelector<HTMLButtonElement>('[aria-label="September 1, 2026"]')!;
    const third = document.querySelector<HTMLButtonElement>('[aria-label="September 3, 2026"]')!;
    act(() => first.click());
    expect(onCommit).not.toHaveBeenCalled();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    act(() => third.click());
    expect(onCommit).toHaveBeenCalledOnce();
    const selection = onCommit.mock.calls[0]![0].selection;
    expect(selection.kind).toBe("fixed");
    if (selection.kind === "fixed") expect(selection.toMs - selection.fromMs).toBe(72 * HOUR);
  });

  it("DD-SYN-006 increments a selected component with Arrow Up without committing", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    open();
    act(() => setInput(editor(), "Jan 1, 2026, 1:05 pm - Jan 2, 2026, 2:10 pm"));
    editor().setSelectionRange(0, 3);
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })),
    );
    expect(editor().value.startsWith("Feb 1")).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("TR-TZ-006/007 exposes specific nonexistent and ambiguous-time recovery", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    open();
    act(() => {
      setInput(editor(), "Mar 8, 2026, 2:30 am - Mar 8, 2026, 4:30 am");
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("does not exist");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      setInput(editor(), "Nov 1, 2026, 1:30 am - Nov 1, 2026, 3:30 am");
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("earlier or later");
    act(() => byTextButton(document, "Later").click());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("DD-UI-006 keeps previous, pause/play, and next outside the menu", async () => {
    const onCommit = vi.fn();
    await render({ onCommit });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Pause"]')!.click());
    expect(onCommit.mock.calls[0]![0].playback.kind).toBe("paused");
    await render({ onCommit, value: onCommit.mock.calls[0]![0] });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Play"]')!.click());
    expect(onCommit.mock.calls[1]![0].playback.kind).toBe("running");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Step back"]')!.click());
    expect(onCommit.mock.calls[2]![0].selection.origin).toBe("navigation");
  });

  it("TR-UI-013 restores input focus on Escape and outside dismissal", async () => {
    await render();
    open();
    act(() =>
      editor().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(editor());
    open();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(editor());
  });

  it("TR-MOD-004/005/006 carries labels/theme to mobile portals and keeps instances independent", async () => {
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    await act(async () =>
      root.render(
        <>
          <TimeRangePicker
            {...baseProps}
            className="consumer-theme"
            labels={{ trigger: "Analysis interval" }}
            onCommit={firstCommit}
            portalClassName="consumer-portal"
            presentation="mobile"
            style={{ "--trp-background": "#123456" } as CSSProperties}
          />
          <TimeRangePicker
            {...baseProps}
            onCommit={secondCommit}
            value={createFixedRange(NOW - HOUR, NOW, "custom", undefined, "UTC")}
          />
        </>,
      ),
    );
    const first = container.querySelector<HTMLInputElement>('[aria-label="Analysis interval"]')!;
    act(() => first.click());
    const backdrop = document.querySelector<HTMLElement>(".time-range-picker__backdrop")!;
    expect(backdrop.classList.contains("consumer-portal")).toBe(true);
    expect(backdrop.style.getPropertyValue("--trp-background")).toBe("#123456");
    act(() => byTextButton(backdrop, "Past 1 hour").click());
    expect(firstCommit).toHaveBeenCalledOnce();
    expect(secondCommit).not.toHaveBeenCalled();
  });

  it("TR-PERF-010 cleans up its outside listener through repeated cycles", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    await render();
    for (let index = 0; index < 20; index += 1) {
      open();
      act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    }
    expect(add.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(20);
    expect(remove.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(20);
  });
});
