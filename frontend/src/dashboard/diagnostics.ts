import type { SourceHealth } from "./types";

export type DiagnosticsSummary = {
  counts: Record<SourceHealth["state"], number>;
  headline: string;
  problemCount: number;
  state: "attention" | "healthy" | "unavailable";
  worstSource: SourceHealth | null;
};

const sourcePriority: Record<SourceHealth["state"], number> = {
  failed: 0,
  stale: 1,
  delayed: 2,
  healthy: 3,
};

export function summarizeDiagnostics(sources: readonly SourceHealth[]): DiagnosticsSummary {
  const counts: DiagnosticsSummary["counts"] = {
    healthy: 0,
    delayed: 0,
    stale: 0,
    failed: 0,
  };
  for (const source of sources) counts[source.state] += 1;

  if (!sources.length) {
    return {
      counts,
      headline: "Source Health Unavailable",
      problemCount: 0,
      state: "unavailable",
      worstSource: null,
    };
  }

  const problemCount = counts.delayed + counts.stale + counts.failed;
  const worstSource =
    [...sources]
      .filter((source) => source.state !== "healthy")
      .sort((left, right) => sourcePriority[left.state] - sourcePriority[right.state])[0] ?? null;

  return {
    counts,
    headline: problemCount
      ? problemCount === 1
        ? "1 Data Source Needs Attention"
        : `${problemCount} Data Sources Need Attention`
      : "Data Sources Healthy",
    problemCount,
    state: problemCount ? "attention" : "healthy",
    worstSource,
  };
}

export function sortDiagnostics(sources: readonly SourceHealth[]) {
  return [...sources].sort(
    (left, right) => sourcePriority[left.state] - sourcePriority[right.state],
  );
}
