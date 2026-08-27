import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { formatValue } from "./units";
import {
  loadMarketManifest,
  loadMarketResource,
  MARKET_SERIES,
  type MarketSeriesKey,
} from "./market-mechanics";

const LABELS: Partial<Record<MarketSeriesKey, string>> = {
  "market.sced.system-lambda": "System Lambda",
  "market.sced.price-adder.energy": "Energy reliability adder",
  "market.sced.price-adder.regup": "Reg-Up adder",
  "market.sced.price-adder.regdown": "Reg-Down adder",
  "market.sced.price-adder.rrs": "RRS adder",
  "market.sced.price-adder.ecrs": "ECRS adder",
  "market.sced.price-adder.nonspin": "Non-Spin adder",
  "market.sced.adder-input.rtdll": "RTDLL (source field; definition pending)",
  "market.sced.adder-input.rtblt-import": "RTBLT import (source field)",
  "market.sced.adder-input.rtblt-export": "RTBLT export (source field)",
};
function label(key: MarketSeriesKey) {
  return LABELS[key] ?? key.split(".").at(-1)!.replaceAll("-", " ");
}
function group(key: MarketSeriesKey) {
  if (key === "market.sced.system-lambda") return "Energy signal";
  if (key.includes("price-adder")) return "Reliability adders";
  if (key.includes("as-mcpc")) return "AS clearing prices";
  if (key.includes("as-capability")) return "Available AS capability";
  return "Operational context inputs";
}
function lineSegments(rows: Array<{ target_ts: number; value: number }>) {
  if (rows.length < 2) return [];
  const values = rows.map((row) => row.value);
  const minimum = Math.min(...values);
  const span = Math.max(1e-9, Math.max(...values) - minimum);
  const first = rows[0]!.target_ts;
  const elapsed = Math.max(1, rows.at(-1)!.target_ts - first);
  const segments: string[][] = [];
  let segment: string[] = [];
  rows.forEach((row, index) => {
    if (index && row.target_ts - rows[index - 1]!.target_ts > 600) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
    segment.push(
      `${((row.target_ts - first) / elapsed) * 100},${38 - ((row.value - minimum) / span) * 34}`,
    );
  });
  if (segment.length > 1) segments.push(segment);
  return segments;
}

export function MarketMechanicsPanel({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<MarketSeriesKey>("market.sced.system-lambda");
  const manifestController = useRef<AbortController | null>(null);
  const manifestFetcher = useCallback(() => {
    manifestController.current?.abort();
    const next = new AbortController();
    manifestController.current = next;
    return loadMarketManifest(next.signal).finally(() => {
      if (manifestController.current === next) manifestController.current = null;
    });
  }, []);
  const manifest = useSWR(
    enabled && expanded ? ["market-mechanics", "manifest"] : null,
    manifestFetcher,
    {
      keepPreviousData: false,
      revalidateOnFocus: true,
      refreshInterval: 300_000,
    },
  );
  useEffect(() => {
    if (!enabled || !expanded) {
      manifestController.current?.abort();
      return;
    }
    const owned = manifestController.current;
    return () => {
      if (manifestController.current === owned) owned?.abort();
    };
  }, [enabled, expanded]);
  const historyLink = useMemo(() => {
    const links = manifest.data?.resources.filter((item) => item.series_key === selected) ?? [];
    return links.sort((left, right) => right.tile_start - left.tile_start)[0] ?? null;
  }, [manifest.data, selected]);
  const historyController = useRef<AbortController | null>(null);
  const history = useSWR(
    enabled && expanded && historyLink ? ["market-mechanics", historyLink.url] : null,
    () => {
      historyController.current?.abort();
      const next = new AbortController();
      historyController.current = next;
      return loadMarketResource(historyLink!, next.signal).finally(() => {
        if (historyController.current === next) historyController.current = null;
      });
    },
    { keepPreviousData: false, revalidateOnFocus: false },
  );
  useEffect(() => {
    if (!enabled || !expanded) {
      historyController.current?.abort();
      return;
    }
    const owned = historyController.current;
    return () => {
      if (historyController.current === owned) owned?.abort();
    };
  }, [enabled, expanded]);

  const current = manifest.data?.current;
  const grouped = useMemo(() => {
    if (!current) return [];
    const result = new Map<string, MarketSeriesKey[]>();
    for (const key of Object.keys(MARKET_SERIES) as MarketSeriesKey[]) {
      const name = group(key);
      result.set(name, [...(result.get(name) ?? []), key]);
    }
    return [...result];
  }, [current]);
  const unhealthy =
    manifest.data?.source_health.filter((item) => item["state"] !== "healthy") ?? [];
  const materializationFailed = manifest.data?.materialization_health["state"] === "failed";

  return (
    <section aria-labelledby="market-mechanics-title" className="market-mechanics-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Market mechanics</p>
          <h2 id="market-mechanics-title">What changed with the price move?</h2>
          <p>
            Signals observed in the same window. Context, not a price decomposition or proof of
            cause.
          </p>
        </div>
        <button
          aria-expanded={expanded}
          className="secondary-button"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Hide market-mechanics details" : "Load market-mechanics details"}
        </button>
      </div>
      {!expanded ? (
        <p>Open to load current SCED context and selected completed-day history.</p>
      ) : null}
      {expanded && manifest.isLoading ? <DataLifecycleMessage state="loading" /> : null}
      {expanded && manifest.error && !manifest.data ? (
        <DataLifecycleMessage state="unavailable" />
      ) : null}
      {expanded && manifest.error && manifest.data ? (
        <p role="status">Refresh failed; showing the last successful market snapshot.</p>
      ) : null}
      {expanded && manifest.data ? (
        <>
          {unhealthy.length || materializationFailed ? (
            <p className="source-warning" role="status">
              Some market-mechanics sources or derived history are stale, unavailable, or failed.
              Exact source states appear below.
            </p>
          ) : null}
          {!current ? (
            <p>
              Four-source exact-SCED context is unavailable. Independent latest readings are not
              combined.
            </p>
          ) : (
            <>
              <p>
                Exact SCED alignment at {new Date(current.target_ts * 1000).toLocaleString()}.
                Lambda parity: {current.lambda_parity.state} (NP6-323 minus NP6-322{" "}
                {formatValue(current.lambda_parity.delta, "$/MWh")}; tolerance{" "}
                {current.lambda_parity.tolerance}).
              </p>
              {grouped.map(([name, keys]) => (
                <section aria-labelledby={`market-group-${name.replaceAll(" ", "-")}`} key={name}>
                  <h3 id={`market-group-${name.replaceAll(" ", "-")}`}>{name}</h3>
                  <div className="market-mechanics-grid">
                    {keys.map((key) => {
                      const reading = current.readings[key];
                      const change = manifest.data!.changes[key];
                      return (
                        <button
                          aria-pressed={selected === key}
                          key={key}
                          onClick={() => setSelected(key)}
                          type="button"
                        >
                          <span>{label(key)}</span>
                          <strong>{formatValue(reading.value, reading.unit)}</strong>
                          <span>
                            {change.delta === null
                              ? "No prior coherent SCED snapshot"
                              : `${change.delta >= 0 ? "+" : ""}${formatValue(change.delta, change.unit)} since prior coherent SCED (${manifest.data!.elapsed_seconds}s)`}
                          </span>
                          <small>
                            {new Date(reading.source.issued_at * 1000).toLocaleString()} ·{" "}
                            {reading.source.product_id}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </>
          )}
          <section aria-labelledby="market-history-title">
            <h3 id="market-history-title">Selected completed-day history: {label(selected)}</h3>
            {!historyLink ? (
              <p>
                Completed-day immutable history is not available yet; collection begins at
                activation.
              </p>
            ) : null}
            {historyLink && history.isLoading ? <DataLifecycleMessage state="loading" /> : null}
            {history.error && !history.data ? <p>Selected history is unavailable.</p> : null}
            {history.error && history.data ? (
              <p role="status">
                History refresh failed; showing the last successful completed-day resource.
              </p>
            ) : null}
            {history.data ? (
              <>
                {history.data.rows.length < 2 ? (
                  <p>Only one exact SCED sample is available; a trend line needs at least two.</p>
                ) : (
                  <svg
                    aria-label={`${label(selected)} completed-day profile`}
                    className="market-mechanics-profile"
                    role="img"
                    viewBox="0 0 100 40"
                  >
                    {lineSegments(history.data.rows).map((points) => (
                      <polyline
                        fill="none"
                        key={points[0]}
                        points={points.join(" ")}
                        stroke="currentColor"
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                )}
                <div
                  aria-label={`${label(selected)} exact values`}
                  className="table-scroll"
                  role="region"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Observed</th>
                        <th>Value</th>
                        <th>Issued</th>
                        <th>Official document</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.rows.map((row) => (
                        <tr key={row.target_ts}>
                          <td>{new Date(row.target_ts * 1000).toLocaleString()}</td>
                          <td>{formatValue(row.value, history.data!.unit)}</td>
                          <td>{new Date(row.source.issued_at * 1000).toLocaleString()}</td>
                          <td>{row.source.document_id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
          <details>
            <summary>Source and freshness status</summary>
            <ul>
              {manifest.data.source_health.map((item) => (
                <li key={String(item["source_id"])}>
                  {String(item["source_id"])}: {String(item["state"])}; observed{" "}
                  {item["data_timestamp_ts"] == null
                    ? "unavailable"
                    : new Date(Number(item["data_timestamp_ts"]) * 1000).toLocaleString()}
                  {item.gap_count
                    ? `; ${item.gap_count} official document gap${item.gap_count === 1 ? "" : "s"} recorded`
                    : ""}
                </li>
              ))}
            </ul>
          </details>
          <p>
            NP6-331 15-minute settlement MCPC and binding-constraint attribution are deferred; no
            simple average or causal decomposition is inferred.
          </p>
        </>
      ) : null}
    </section>
  );
}
