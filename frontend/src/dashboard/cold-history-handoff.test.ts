import { describe, expect, it, vi } from "vitest";
import { afterColdHistoryPaint } from "./cold-history-handoff";

function setup() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, TimerHandler>();
  const scheduler = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const key = ++id;
      frames.set(key, callback);
      return key;
    },
    cancelAnimationFrame: (key: number) => {
      frames.delete(key);
    },
    setTimeout: (callback: TimerHandler) => {
      const key = ++id;
      timers.set(key, callback);
      return key;
    },
    clearTimeout: (key: number) => {
      timers.delete(key);
    },
  };
  const frame = () => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(0));
  };
  return { scheduler, frames, timers, frame };
}

describe("cold queue handoff", () => {
  it("keeps the queue held through the first frame and releases once after the second", () => {
    const s = setup();
    const complete = vi.fn();
    afterColdHistoryPaint(new AbortController().signal, complete, s.scheduler);
    s.frame();
    expect(complete).not.toHaveBeenCalled();
    s.frame();
    expect(complete).toHaveBeenCalledOnce();
    expect(s.timers.size).toBe(0);
    s.frame();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("releases once via the bounded fallback when frames cannot run", () => {
    const s = setup();
    const complete = vi.fn();
    afterColdHistoryPaint(new AbortController().signal, complete, s.scheduler);
    const callback = [...s.timers.values()][0] as () => void;
    callback();
    expect(complete).toHaveBeenCalledOnce();
    expect(s.frames.size).toBe(0);
    callback();
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each([0, 1])("abort cancels a pending handoff after %i frames", (count) => {
    const s = setup();
    const controller = new AbortController();
    const complete = vi.fn();
    afterColdHistoryPaint(controller.signal, complete, s.scheduler);
    for (let i = 0; i < count; i += 1) s.frame();
    controller.abort();
    s.frame();
    expect(complete).not.toHaveBeenCalled();
    expect(s.frames.size).toBe(0);
    expect(s.timers.size).toBe(0);
  });
  it("explicit cancellation and already-aborted contexts never release", () => {
    const s = setup();
    const complete = vi.fn();
    const controller = new AbortController();
    afterColdHistoryPaint(controller.signal, complete, s.scheduler)();
    s.frame();
    controller.abort();
    afterColdHistoryPaint(controller.signal, complete, s.scheduler);
    expect(complete).not.toHaveBeenCalled();
    expect(s.frames.size).toBe(0);
    expect(s.timers.size).toBe(0);
  });
});
