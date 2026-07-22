export type Point = [number, number];

export type TimeMode = "fixed" | "live";
export type CompareMode = "custom" | "day" | "none" | "previous_period" | "week";
export type LegendMode = "compact" | "expanded";
export type StatisticPolicy = "gauge" | "power";

export type TimeState = {
  end: number;
  mode: TimeMode;
  paused: boolean;
  rangeSeconds: number;
  start: number;
};

export type DashboardState = {
  compare: CompareMode;
  customCompareSeconds: number;
  events: boolean;
  expandedChart: string | null;
  hiddenSeries: Set<string>;
  legendMode: LegendMode;
  time: TimeState;
};

export type SeriesDefinition = {
  color: string;
  derive?: {
    from: string[];
    operation: import("./derived").DerivedOperation;
  };
  id: string;
  label: string;
  metric?: string;
  rollup?: "sum";
  tags?: string[];
};

export type ChartDefinition = {
  description: string;
  group: string;
  id: string;
  sourceId?: string;
  sourceUrl: string;
  spikeCritical?: boolean;
  statisticPolicy: StatisticPolicy;
  title: string;
  unit: string;
  series: SeriesDefinition[];
};

export type SeriesMeta = {
  bucket_seconds?: number | null;
  max_points?: number | null;
  partial_current_bucket?: boolean;
  since?: number;
  until?: number | null;
  stats?: {
    average: number | null;
    count: number;
    energy_mwh: number | null;
    latest: number | null;
    maximum: number | null;
    minimum: number | null;
  };
};

export type LoadedSeries = {
  compare: Point[];
  error: string | null;
  meta: SeriesMeta;
  points: Point[];
};

export type EventRecord = {
  body?: string | null;
  dedupe_key: string;
  ends_at?: number | null;
  event_type: string;
  severity?: string | null;
  starts_at: number;
  status?: string | null;
  title: string;
};

export type SourceHealth = {
  age_seconds: number | null;
  consecutive_failures: number;
  display_name: string;
  expected_interval_seconds: number;
  last_attempt_ts: number | null;
  last_error: string | null;
  last_row_count: number | null;
  last_success_ts: number | null;
  source_id: string;
  source_timestamp_ts: number | null;
  collection_age_seconds: number | null;
  collection_state: "delayed" | "failed" | "healthy";
  data_age_seconds: number | null;
  freshness_state: "delayed" | "event_driven" | "fresh" | "stale" | "unknown";
  publication_interval_seconds: number | null;
  publication_mode: "event" | "polling";
  state: "delayed" | "failed" | "healthy" | "stale";
};
