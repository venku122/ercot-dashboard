import type { CompareMode, SeriesMeta, TimeState } from "./types";

export type CompletedSelection = NonNullable<SeriesMeta["completed_selection"]>;

// Selected-window identity is frontend request provenance, not a source observation timestamp.
export function isPreviousSelection(
  completed: CompletedSelection | undefined,
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
) {
  if (!completed) return false;
  const sameComparison =
    completed.compare === compare &&
    (compare !== "custom" || completed.customCompareSeconds === customCompareSeconds);
  const sameBounds = completed.start === time.start && completed.end === time.end;
  // Ordinary running live refresh retains the same duration/comparison selection.
  const sameRunningSelection =
    completed.mode === "live" &&
    !completed.paused &&
    time.mode === "live" &&
    !time.paused &&
    completed.rangeSeconds === time.rangeSeconds &&
    completed.start < time.end &&
    time.start < completed.end;
  return !sameComparison || !(sameBounds || sameRunningSelection);
}

export function selectionDescription(selection: CompletedSelection) {
  const comparison =
    selection.compare === "custom"
      ? `custom (${selection.customCompareSeconds}s earlier)`
      : selection.compare.replaceAll("_", " ");
  return `${new Date(selection.start * 1000).toISOString()}–${new Date(selection.end * 1000).toISOString()} · comparison ${comparison}`;
}
