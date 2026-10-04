import type { TimeRangeValue } from "../time-range";

export type Point = [number, number];

export type TimeMode = "fixed" | "live";
export type CompareMode = "custom" | "day" | "none" | "previous_period" | "week";
export type LegendMode = "compact" | "expanded";
export type StatisticPolicy = "gauge" | "power";
export type InterpretationTone = "critical" | "informational" | "normal" | "strained" | "watch";

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
  history: boolean;
  expandedChart: string | null;
  hiddenSeries: Set<string>;
  legendMode: LegendMode;
  time: TimeRangeValue;
};

export type SeriesTemporalPolicy = {
  kind: "instant" | "interval" | "forecast" | "discrete";
  nativeCadenceSeconds: number | null;
  connectionGapSeconds: number;
  cursor: { mode: "preceding"; maxAgeSeconds: number } | { mode: "interval" };
  evidence: string;
};

export type SeriesDefinition = {
  temporal?: SeriesTemporalPolicy;
  color: string;
  derive?: {
    from: string[];
    operation: import("./derived").DerivedOperation;
  };
  id: string;
  inputOnly?: boolean;
  label: string;
  lineStyle?: "dashed";
  metric?: string;
  rollup?: "sum";
  tags?: string[];
};

export type InterpretationBand = {
  id: string;
  label: string;
  lower?: number;
  tone: InterpretationTone;
  upper?: number;
};

type InterpretationBase = {
  bands: InterpretationBand[];
  basis: string;
  subject: string;
  subjectSeriesId: string;
};

export type ChartInterpretation =
  | (InterpretationBase & {
      mode: "absolute";
    })
  | (InterpretationBase & {
      mode: "reference-ratio";
      referenceLabel: string;
      referenceSeriesKey: string;
    });

export type ChartDefinition = {
  description: string;
  group: string;
  id: string;
  interpretation?: ChartInterpretation;
  sourceId?: string;
  sourceUrl: string;
  spikeCritical?: boolean;
  statisticPolicy: StatisticPolicy;
  title: string;
  unit: string;
  series: SeriesDefinition[];
  zeroCentered?: boolean;
};

export type SeriesMeta = {
  observed_envelope_support?: Array<{ start: number; end: number }>;
  comparison_observed_envelope_support?: Array<{ start: number; end: number }>;
  coverage?: "complete" | "partial" | "unknown";
  intervals?: Array<{ timestamp: number; start: number; end: number }>;
  comparison_intervals?: Array<{ timestamp: number; start: number; end: number }>;
  bucket_seconds?: number | null;
  max_points?: number | null;
  partial_current_bucket?: boolean;
  since?: number;
  until?: number | null;
  pairing?: {
    policy: string;
    paired_count: number;
    expected_count: number;
    collection_history: "first_collection_time_not_recorded";
  };
  stats?: {
    minimum_ts?: number | null;
    maximum_ts?: number | null;
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
  data_timestamp_ts?: number | null;
  collection_age_seconds: number | null;
  source_age_seconds?: number | null;
  collection_state: "delayed" | "failed" | "healthy";
  data_age_seconds: number | null;
  freshness_state: "delayed" | "event_driven" | "fresh" | "stale" | "unknown";
  publication_interval_seconds: number | null;
  publication_mode: "event" | "polling";
  state: "delayed" | "failed" | "healthy" | "stale";
};
