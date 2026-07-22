import type { TimeState } from "./types";

export const DEFAULT_RANGE_SECONDS = 6 * 60 * 60;

export function createTimeState(now: number, rangeSeconds = DEFAULT_RANGE_SECONDS): TimeState {
  return {
    mode: "live",
    paused: false,
    rangeSeconds,
    start: now - rangeSeconds,
    end: now,
  };
}

export function setRange(state: TimeState, rangeSeconds: number, now: number): TimeState {
  const safeRange = Math.max(300, Math.min(rangeSeconds, 365 * 86400));
  const end = state.mode === "live" && !state.paused ? now : state.end;
  return { ...state, rangeSeconds: safeRange, start: end - safeRange, end };
}

export function setCustomRange(start: number, end: number): TimeState {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("invalid_time_range");
  }
  return { mode: "fixed", paused: false, rangeSeconds: end - start, start, end };
}

export function navigateWindow(state: TimeState, direction: -1 | 1): TimeState {
  const delta = state.rangeSeconds * direction;
  return {
    ...state,
    mode: "fixed",
    paused: false,
    start: state.start + delta,
    end: state.end + delta,
  };
}

export function resetLive(state: TimeState, now: number): TimeState {
  return {
    ...state,
    mode: "live",
    paused: false,
    start: now - state.rangeSeconds,
    end: now,
  };
}

export function togglePause(state: TimeState, now: number): TimeState {
  if (state.mode === "fixed") return resetLive(state, now);
  return { ...state, paused: !state.paused };
}

export function tickLive(state: TimeState, now: number): TimeState {
  if (state.mode !== "live" || state.paused) return state;
  return { ...state, start: now - state.rangeSeconds, end: now };
}

export function zoomTo(state: TimeState, start: number, end: number): TimeState {
  const custom = setCustomRange(start, end);
  return { ...custom, paused: state.paused };
}
