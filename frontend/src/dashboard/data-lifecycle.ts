export type DataLifecycleState = "loading" | "ready" | "unavailable" | "waiting";

export type DataLifecycleInput = {
  hasData: boolean;
  loading: boolean;
  unavailable: boolean;
};

export const dataLifecycleCopy = {
  loading: {
    detail: "Requesting the latest data for this view.",
    title: "Loading…",
  },
  unavailable: {
    detail: "The latest request could not be completed. Try again shortly.",
    title: "Temporarily unavailable…",
  },
  waiting: {
    detail: "No observation has arrived for the selected range yet.",
    title: "Waiting for first sample…",
  },
} as const;

export function resolveDataLifecycleState({
  hasData,
  loading,
  unavailable,
}: DataLifecycleInput): DataLifecycleState {
  if (hasData) return "ready";
  if (loading) return "loading";
  if (unavailable) return "unavailable";
  return "waiting";
}
