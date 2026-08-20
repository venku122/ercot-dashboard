import { useEffect, useMemo, useRef, useState } from "react";

import { loadSeries } from "./api";
import { seriesKey } from "./chart-config";
import { loadMarketManifest, type MarketManifest } from "./market-mechanics";
import {
  deriveStorageContextReplay,
  STORAGE_CONTEXT_REPLAY_POLICY,
  STORAGE_CONTEXT_SERIES,
  type StorageContextReplayInput,
  type StorageContextSeriesId,
} from "./storage-context-replay";
import type { ChartDefinition, LoadedSeries, SourceHealth, TimeState } from "./types";

const REPLAY_SECONDS = 2 * 60 * 60;
const CAPABILITY_KEY = "market.sced.as-capability.regup-rrs-ecrs-nonspin" as const;
const LAMBDA_KEY = "market.sced.system-lambda" as const;

const FREQUENCY_CHART: ChartDefinition = {
  description: "Collector-captured ERCOT system frequency context.",
  group: "Grid conditions",
  id: "storage-context-frequency",
  series: [
    {
      color: "#94a3b8",
      id: "frequency",
      label: "System frequency",
      metric: STORAGE_CONTEXT_SERIES.frequency.metric,
    },
  ],
  sourceUrl: "https://www.ercot.com/content/cdr/html/real_time_system_conditions.html",
  spikeCritical: true,
  statisticPolicy: "gauge",
  title: "System frequency",
  unit: "Hz",
};

type ReplayRemote = {
  error: string | null;
  frequency: LoadedSeries | undefined;
  loading: boolean;
  manifest: MarketManifest | null;
  windowKey: string | null;
};

function recentWindow(time: TimeState) {
  return { end: time.end, start: Math.max(time.start, time.end - REPLAY_SECONDS) };
}

function frequencyTime(time: TimeState, window: { end: number; start: number }): TimeState {
  return { ...time, end: window.end, rangeSeconds: window.end - window.start, start: window.start };
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toISOString();
}

function marketSnapshot(
  snapshot: MarketManifest["current"],
): StorageContextReplayInput["market"]["current"] {
  if (!snapshot) return null;
  return {
    alignment: snapshot.alignment,
    readings: {
      [CAPABILITY_KEY]: snapshot.readings[CAPABILITY_KEY],
      [LAMBDA_KEY]: snapshot.readings[LAMBDA_KEY],
    },
    target_ts: snapshot.target_ts,
  };
}

function laneTitle(id: StorageContextSeriesId) {
  if (id === "frequency") return "System frequency";
  if (id === "systemLambda") return "System Lambda";
  if (id === "availableAsCapability") return "Available AS capability";
  return id === "netOutput" ? "Net output" : id[0].toUpperCase() + id.slice(1);
}

function ReplayLane({
  ids,
  replay,
  title,
}: {
  ids: readonly StorageContextSeriesId[];
  replay: ReturnType<typeof deriveStorageContextReplay>;
  title: string;
}) {
  const selected = replay.series.filter((series) => ids.includes(series.id));
  const values = selected.flatMap((series) => series.points.map((point) => point[1]));
  if (!values.length) {
    return (
      <article className="storage-context-lane">
        <h4>{title}</h4>
        <p role="status">No exact source observations in this two-hour window.</p>
      </article>
    );
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const x = (timestamp: number) =>
    10 + ((timestamp - replay.start) / Math.max(1, replay.end - replay.start)) * 280;
  const y = (value: number) =>
    72 - ((value - minimum) / Math.max(0.000_001, maximum - minimum)) * 60;
  const symbols = ["circle", "square", "diamond"] as const;
  return (
    <article className="storage-context-lane">
      <h4>{title}</h4>
      <svg aria-label={`${title}; exact native timestamps`} role="img" viewBox="0 0 300 82">
        {selected.flatMap((series, seriesIndex) =>
          series.points.map(([timestamp, value]) => {
            const symbol = symbols[seriesIndex % symbols.length];
            const centerX = x(timestamp);
            const centerY = y(value);
            const key = `${series.id}-${timestamp}`;
            const label = `${laneTitle(series.id)} at ${formatTimestamp(timestamp)}: ${value} ${series.unit}`;
            if (symbol === "square")
              return (
                <rect
                  aria-label={label}
                  height="6"
                  key={key}
                  width="6"
                  x={centerX - 3}
                  y={centerY - 3}
                />
              );
            if (symbol === "diamond")
              return (
                <rect
                  aria-label={label}
                  height="6"
                  key={key}
                  transform={`rotate(45 ${centerX} ${centerY})`}
                  width="6"
                  x={centerX - 3}
                  y={centerY - 3}
                />
              );
            return <circle aria-label={label} cx={centerX} cy={centerY} key={key} r="3" />;
          }),
        )}
      </svg>
      <p>
        {selected
          .map((series) => `${laneTitle(series.id)} · ${series.cadenceSeconds}s nominal`)
          .join(" · ")}
      </p>
    </article>
  );
}

function exactRows(
  replay: ReturnType<typeof deriveStorageContextReplay>,
  manifest: MarketManifest | null,
) {
  const marketSources = new Map<
    string,
    {
      document: string;
      issued: number;
      product: string;
      rawPublish: string;
      rawSced: string;
      repeated: boolean;
      vintage: string;
    }
  >();
  for (const snapshot of [manifest?.previous, manifest?.current]) {
    if (!snapshot) continue;
    for (const key of [LAMBDA_KEY, CAPABILITY_KEY] as const) {
      const source = snapshot.readings[key].source;
      marketSources.set(`${key}:${snapshot.target_ts}`, {
        document: source.document_id,
        issued: source.issued_at,
        product: source.product_id,
        rawPublish: source.raw_publish_datetime,
        rawSced: source.raw_sced_timestamp,
        repeated: source.repeated_hour_flag,
        vintage: source.vintage_key,
      });
    }
  }
  return replay.series.flatMap((series) =>
    series.points.map(([timestamp, value]) => {
      const source = marketSources.get(`${series.metric}:${timestamp}`);
      return {
        cadence: `${series.cadenceSeconds}s nominal`,
        id: series.id,
        issued: source ? formatTimestamp(source.issued) : null,
        provenance: source
          ? `${source.product}; document ${source.document}; vintage ${source.vintage}; published ${source.rawPublish}; raw SCED ${source.rawSced}; repeated hour ${source.repeated ? "yes" : "no"}`
          : series.timeBasis,
        source: series.sourceId,
        timestamp,
        unit: series.unit,
        value,
      };
    }),
  );
}

export function StorageContextReplay({
  seriesData,
  sourceHealth,
  time,
}: {
  seriesData: Map<string, LoadedSeries>;
  sourceHealth: SourceHealth | null;
  time: TimeState;
}) {
  const window = useMemo(() => recentWindow(time), [time]);
  const windowKey = `${window.start}:${window.end}`;
  const generation = useRef(0);
  const [remote, setRemote] = useState<ReplayRemote>({
    error: null,
    frequency: undefined,
    loading: true,
    manifest: null,
    windowKey: null,
  });
  const effectiveRemote: ReplayRemote =
    remote.windowKey === windowKey
      ? remote
      : { error: null, frequency: undefined, loading: true, manifest: null, windowKey };

  useEffect(() => {
    const controller = new AbortController();
    const request = ++generation.current;
    setRemote({ error: null, frequency: undefined, loading: true, manifest: null, windowKey });
    void Promise.allSettled([
      loadSeries([FREQUENCY_CHART], frequencyTime(time, window), "none", 0, controller.signal),
      loadMarketManifest(controller.signal),
    ]).then(([frequency, market]) => {
      if (controller.signal.aborted || request !== generation.current) return;
      setRemote({
        error:
          frequency.status === "rejected" || market.status === "rejected"
            ? "One or more context sources could not be loaded. Available layers remain exact."
            : null,
        frequency:
          frequency.status === "fulfilled"
            ? frequency.value.get(seriesKey(FREQUENCY_CHART.id, "frequency"))
            : undefined,
        loading: false,
        manifest: market.status === "fulfilled" ? market.value : null,
        windowKey,
      });
    });
    return () => controller.abort();
  }, [time.mode, time.paused, window.end, window.start, windowKey]);

  const nativeFrequency =
    effectiveRemote.frequency &&
    effectiveRemote.frequency.error === null &&
    (effectiveRemote.frequency.meta.bucket_seconds == null ||
      effectiveRemote.frequency.meta.bucket_seconds ===
        STORAGE_CONTEXT_SERIES.frequency.cadenceSeconds)
      ? effectiveRemote.frequency
      : undefined;
  const nativeStorage = (id: "charging" | "discharging" | "netOutput") => {
    const loaded = seriesData.get(seriesKey("storage", id === "netOutput" ? "net-output" : id));
    return loaded &&
      loaded.error === null &&
      (loaded.meta.bucket_seconds == null ||
        loaded.meta.bucket_seconds === STORAGE_CONTEXT_SERIES[id].cadenceSeconds)
      ? loaded
      : undefined;
  };

  const replay = useMemo(
    () =>
      deriveStorageContextReplay({
        end: window.end,
        market: {
          current: marketSnapshot(effectiveRemote.manifest?.current ?? null),
          previous: marketSnapshot(effectiveRemote.manifest?.previous ?? null),
        },
        series: [
          {
            id: "frequency",
            points:
              nativeFrequency?.points.filter(
                ([timestamp]) => timestamp >= window.start && timestamp < window.end,
              ) ?? [],
          },
          ...(["charging", "discharging", "netOutput"] as const).map((id) => ({
            id,
            points:
              nativeStorage(id)?.points.filter(
                ([timestamp]) => timestamp >= window.start && timestamp < window.end,
              ) ?? [],
          })),
        ],
        start: window.start,
      }),
    [effectiveRemote.manifest, nativeFrequency, seriesData, window],
  );
  const rows = useMemo(
    () => exactRows(replay, effectiveRemote.manifest),
    [effectiveRemote.manifest, replay],
  );
  const derivedRows = useMemo(
    () =>
      replay.series.flatMap((series) => {
        if (!series.points.length) return [];
        const ordered = [...series.points].sort((left, right) => left[1] - right[1]);
        return [
          { kind: "minimum", point: ordered[0] },
          { kind: "maximum", point: ordered.at(-1)! },
        ].map(({ kind, point }) => ({
          cadence: `${series.cadenceSeconds}s nominal`,
          id: series.id,
          method: "window_extrema_v1",
          provenance: series.timeBasis,
          source: series.sourceId,
          timestamp: point[0],
          unit: series.unit,
          value: point[1],
          kind,
        }));
      }),
    [replay],
  );
  const unhealthyMarket = effectiveRemote.manifest?.source_health.some(
    (source) =>
      (source.source_id === "ercot_mis_np6_322" || source.source_id === "ercot_mis_np6_328") &&
      source.state !== "healthy",
  );
  const staleStorage = sourceHealth !== null && sourceHealth.state !== "healthy";
  const frequencyUnavailable =
    effectiveRemote.frequency !== undefined && nativeFrequency === undefined;
  const storageUnavailable = (["charging", "discharging", "netOutput"] as const).filter(
    (id) => nativeStorage(id) === undefined,
  );

  return (
    <section aria-label="Multi-cadence storage context replay" className="storage-context-replay">
      <header>
        <h3>Multi-cadence storage context replay</h3>
        <p>Recent two-hour source-observation view</p>
      </header>
      <p>
        Fleet storage, frequency, System Lambda, and available AS capability are shown in the same
        UTC window. Their different timestamps and cadences are preserved; timing alone does not
        establish attribution or operational intent.
      </p>
      <p>
        Alignment: <code>display_window_only</code> · policy:{" "}
        <code>{STORAGE_CONTEXT_REPLAY_POLICY}</code>
      </p>
      <p>
        UTC window{" "}
        <time dateTime={formatTimestamp(window.start)}>{formatTimestamp(window.start)}</time>
        {" – "}
        <time dateTime={formatTimestamp(window.end)}>{formatTimestamp(window.end)}</time>
      </p>
      {effectiveRemote.loading ? (
        <p role="status">Loading frequency and exact SCED context…</p>
      ) : null}
      {effectiveRemote.error ? <p role="alert">{effectiveRemote.error}</p> : null}
      {frequencyUnavailable ? (
        <p role="status">
          Frequency is unavailable because its request failed or was not native 60-second data.
        </p>
      ) : null}
      {storageUnavailable.length ? (
        <p role="status">
          Native five-minute storage unavailable: {storageUnavailable.join(", ")}.
        </p>
      ) : null}
      {staleStorage || unhealthyMarket ? (
        <p role="status">
          One or more sources are stale or unhealthy; retained timestamps remain explicit.
        </p>
      ) : null}
      <div className="storage-context-lanes">
        <ReplayLane
          ids={["charging", "discharging", "netOutput"]}
          replay={replay}
          title="Storage fleet (MW)"
        />
        <ReplayLane ids={["frequency"]} replay={replay} title="System frequency (Hz)" />
        <ReplayLane
          ids={["availableAsCapability"]}
          replay={replay}
          title="Available AS capability (MW)"
        />
        <ReplayLane ids={["systemLambda"]} replay={replay} title="System Lambda ($/MWh)" />
      </div>
      <p>
        Source observations and deterministic derived window extrema use separate annotation
        classes. Official annotations are unavailable because no strict official annotation source
        is in this slice.
      </p>
      <details>
        <summary>Exact observations and provenance</summary>
        <div
          aria-label="Storage context replay exact observations"
          className="table-scroll storage-context-table"
          role="region"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Timestamp UTC</th>
                <th>Series</th>
                <th>Value</th>
                <th>Unit</th>
                <th>Source</th>
                <th>Cadence</th>
                <th>Time basis / provenance</th>
                <th>Issued</th>
                <th>Class</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.id}-${row.timestamp}`}>
                  <td>{formatTimestamp(row.timestamp)}</td>
                  <td>{laneTitle(row.id)}</td>
                  <td>{row.value}</td>
                  <td>{row.unit}</td>
                  <td>{row.source}</td>
                  <td>{row.cadence}</td>
                  <td>{row.provenance}</td>
                  <td>{row.issued ?? "not applicable"}</td>
                  <td>source</td>
                  <td>source observation</td>
                </tr>
              ))}
              {derivedRows.map((row) => (
                <tr key={`derived-${row.id}-${row.kind}-${row.timestamp}`}>
                  <td>{formatTimestamp(row.timestamp)}</td>
                  <td>
                    {laneTitle(row.id)} {row.kind}
                  </td>
                  <td>{row.value}</td>
                  <td>{row.unit}</td>
                  <td>{row.source}</td>
                  <td>{row.cadence}</td>
                  <td>{row.provenance}</td>
                  <td>not applicable</td>
                  <td>derived</td>
                  <td>{row.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Derived window annotations</summary>
        <p>
          Rule <code>window_extrema_v1</code>: exact minimum and maximum within each native series,
          with no interpolation.
        </p>
        <p>
          The exact table above includes every derived annotation with source, cadence, class, and
          method.
        </p>
      </details>
    </section>
  );
}
