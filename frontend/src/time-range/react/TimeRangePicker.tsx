import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  changeTimeRangeTimezone,
  commitFixedTimeRange,
  createCalendarRange,
  createGrowingRange,
  createRelativeRange,
  formatTimeRangeLabel,
  formatWallTimeInput,
  navigateTimeRange,
  parseWallTime,
  pauseTimeRange,
  resetTimeRange,
  resolveTimeRange,
  resolveWallTime,
  resumeTimeRange,
  validateResolvedTimeWindow,
  type CalendarPresetId,
  type TimeRangeConfig,
  type TimeRangeValue,
  type WallTimeOccurrence,
} from "../core";
import "../styles/time-range-picker.css";

export type DurationPreset = {
  durationMs: number;
  id: string;
  label: string;
};

export type CalendarPreset = {
  id: CalendarPresetId;
  label: string;
};

export type TimeRangePickerLabels = {
  apply?: string;
  cancel?: string;
  trigger?: string;
};

export type TimeRangePickerProps = {
  calendarPresets: readonly CalendarPreset[];
  className?: string;
  config: TimeRangeConfig;
  labels?: TimeRangePickerLabels;
  nowMs: number;
  onCommit: (value: TimeRangeValue) => void;
  presentation?: "desktop" | "mobile";
  presets: readonly DurationPreset[];
  timezoneOptions: readonly string[];
  value: TimeRangeValue;
};

type CustomMode = "fixed" | "growing";
type DraftError = { field: "from" | "range" | "to"; message: string };

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function wallResolution(value: string, timezone: string) {
  const parsed = parseWallTime(value);
  return parsed.ok ? resolveWallTime(parsed.parts, timezone) : null;
}

function resolveDraftInstant(
  value: string,
  timezone: string,
  occurrence: WallTimeOccurrence | "",
  field: "From" | "To",
): { error?: string; instantMs?: number } {
  const parsed = parseWallTime(value);
  if (!parsed.ok) return { error: `${field} must be a valid local date and time.` };
  const result = resolveWallTime(parsed.parts, timezone, occurrence || undefined);
  if (result.kind === "nonexistent") {
    return { error: `${field} is not a real local time because of DST.` };
  }
  if (result.kind === "ambiguous") {
    return { error: `Choose the earlier or later occurrence for ${field}.` };
  }
  return { instantMs: result.instantMs };
}

export function TimeRangePicker({
  calendarPresets,
  className = "",
  config,
  labels = {},
  nowMs,
  onCommit,
  presentation = "desktop",
  presets,
  timezoneOptions,
  value,
}: TimeRangePickerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const resolved = useMemo(() => resolveTimeRange(value, nowMs, config), [config, nowMs, value]);
  const [draftFrom, setDraftFrom] = useState(() =>
    formatWallTimeInput(resolved.fromMs, value.timezone),
  );
  const [draftTo, setDraftTo] = useState(() => formatWallTimeInput(resolved.toMs, value.timezone));
  const [draftTimezone, setDraftTimezone] = useState(value.timezone);
  const [customMode, setCustomMode] = useState<CustomMode>("fixed");
  const [fromOccurrence, setFromOccurrence] = useState<WallTimeOccurrence | "">("");
  const [toOccurrence, setToOccurrence] = useState<WallTimeOccurrence | "">("");
  const [error, setError] = useState<DraftError | null>(null);

  const presetLabels = useMemo(
    () => new Map(presets.map((preset) => [preset.id, preset.label])),
    [presets],
  );
  const calendarLabels = useMemo(
    () => new Map(calendarPresets.map((preset) => [preset.id, preset.label])),
    [calendarPresets],
  );
  const triggerLabel = formatTimeRangeLabel(value, nowMs, config, {
    calendar: calendarLabels,
    presets: presetLabels,
  });
  const fromWall = wallResolution(draftFrom, draftTimezone);
  const toWall = wallResolution(draftTo, draftTimezone);

  const resetDraft = () => {
    const current = resolveTimeRange(value, nowMs, config);
    setDraftFrom(formatWallTimeInput(current.fromMs, value.timezone));
    setDraftTo(formatWallTimeInput(current.toMs, value.timezone));
    setDraftTimezone(value.timezone);
    setCustomMode("fixed");
    setFromOccurrence("");
    setToOccurrence("");
    setError(null);
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const commitAndClose = (next: TimeRangeValue) => {
    onCommit(next);
    close();
  };

  useEffect(() => {
    if (!open) return;
    surfaceRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    if (presentation !== "mobile") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open, presentation]);

  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(surfaceRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []),
    ];
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const applyCustom = () => {
    const from = resolveDraftInstant(draftFrom, draftTimezone, fromOccurrence, "From");
    if (from.error || from.instantMs === undefined) {
      setError({ field: "from", message: from.error ?? "From must be a valid time." });
      return;
    }
    if (customMode === "growing") {
      const validation = validateResolvedTimeWindow(
        { fromMs: from.instantMs, toMs: nowMs },
        config,
      );
      if (validation) {
        setError({ field: validation.field, message: validation.message });
        return;
      }
      commitAndClose(createGrowingRange(from.instantMs, draftTimezone));
      return;
    }
    const to = resolveDraftInstant(draftTo, draftTimezone, toOccurrence, "To");
    if (to.error || to.instantMs === undefined) {
      setError({ field: "to", message: to.error ?? "To must be a valid time." });
      return;
    }
    const validation = validateResolvedTimeWindow(
      { fromMs: from.instantMs, toMs: to.instantMs },
      config,
    );
    if (validation) {
      setError({ field: validation.field, message: validation.message });
      return;
    }
    commitAndClose(
      commitFixedTimeRange(value, from.instantMs, to.instantMs, "custom", draftTimezone),
    );
  };

  const surface = (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal={presentation === "mobile" ? "true" : undefined}
      className={`time-range-picker__surface time-range-picker__surface--${presentation}`}
      onKeyDown={onSurfaceKeyDown}
      ref={surfaceRef}
      role="dialog"
    >
      <div className="time-range-picker__heading">
        <div>
          <h2 id={titleId}>Time range</h2>
          <p id={descriptionId}>Choose a live, calendar, or custom analysis window.</p>
        </div>
        <button
          aria-label="Close time range picker"
          data-autofocus
          onClick={() => {
            resetDraft();
            close();
          }}
          type="button"
        >
          Close
        </button>
      </div>

      <div className="time-range-picker__status" role="status">
        <strong>{triggerLabel}</strong>
        <span>
          {value.playback.kind === "paused" ? "Paused" : resolved.live ? "Live" : "Fixed"}
        </span>
      </div>

      <fieldset>
        <legend>Quick ranges</legend>
        <div className="time-range-picker__choices">
          {presets.map((preset) => (
            <button
              key={preset.id}
              onClick={() =>
                commitAndClose(createRelativeRange(preset.durationMs, preset.id, draftTimezone))
              }
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Calendar</legend>
        <div className="time-range-picker__choices">
          {calendarPresets.map((preset) => (
            <button
              key={preset.id}
              onClick={() => commitAndClose(createCalendarRange(preset.id, draftTimezone))}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Custom</legend>
        <div className="time-range-picker__form-grid">
          <label>
            <span>Mode</span>
            <select
              aria-label="Custom range mode"
              onChange={(event) => setCustomMode(event.target.value as CustomMode)}
              value={customMode}
            >
              <option value="fixed">From and To</option>
              <option value="growing">Since From</option>
            </select>
          </label>
          <label>
            <span>Timezone</span>
            <select
              aria-label="Time range timezone"
              onChange={(event) => {
                setDraftTimezone(event.target.value);
                setFromOccurrence("");
                setToOccurrence("");
                setError(null);
              }}
              value={draftTimezone}
            >
              {timezoneOptions.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>From</span>
            <input
              aria-describedby={
                error?.field === "from" || error?.field === "range" ? errorId : undefined
              }
              aria-invalid={error?.field === "from" || error?.field === "range" || undefined}
              aria-label="From"
              onChange={(event) => {
                setDraftFrom(event.target.value);
                setFromOccurrence("");
                setError(null);
              }}
              type="datetime-local"
              value={draftFrom}
            />
          </label>
          {fromWall?.kind === "ambiguous" ? (
            <label>
              <span>From occurrence</span>
              <select
                aria-label="From occurrence"
                onChange={(event) =>
                  setFromOccurrence(event.target.value as WallTimeOccurrence | "")
                }
                value={fromOccurrence}
              >
                <option value="">Choose…</option>
                <option value="earlier">Earlier occurrence</option>
                <option value="later">Later occurrence</option>
              </select>
            </label>
          ) : null}
          {customMode === "fixed" ? (
            <label>
              <span>To</span>
              <input
                aria-describedby={
                  error?.field === "to" || error?.field === "range" ? errorId : undefined
                }
                aria-invalid={error?.field === "to" || error?.field === "range" || undefined}
                aria-label="To"
                onChange={(event) => {
                  setDraftTo(event.target.value);
                  setToOccurrence("");
                  setError(null);
                }}
                type="datetime-local"
                value={draftTo}
              />
            </label>
          ) : null}
          {customMode === "fixed" && toWall?.kind === "ambiguous" ? (
            <label>
              <span>To occurrence</span>
              <select
                aria-label="To occurrence"
                onChange={(event) => setToOccurrence(event.target.value as WallTimeOccurrence | "")}
                value={toOccurrence}
              >
                <option value="">Choose…</option>
                <option value="earlier">Earlier occurrence</option>
                <option value="later">Later occurrence</option>
              </select>
            </label>
          ) : null}
        </div>
        {error ? (
          <p className="time-range-picker__error" id={errorId} role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="time-range-picker__actions">
          <button onClick={applyCustom} type="button">
            {labels.apply ?? "Apply"}
          </button>
          <button
            onClick={() => {
              resetDraft();
              close();
            }}
            type="button"
          >
            {labels.cancel ?? "Cancel"}
          </button>
          {draftTimezone !== value.timezone ? (
            <button
              onClick={() => commitAndClose(changeTimeRangeTimezone(value, draftTimezone))}
              type="button"
            >
              Apply timezone
            </button>
          ) : null}
        </div>
      </fieldset>

      <div aria-label="Window navigation" className="time-range-picker__actions">
        <button
          onClick={() => commitAndClose(navigateTimeRange(value, -1, nowMs, config))}
          type="button"
        >
          Previous window
        </button>
        <button
          onClick={() => commitAndClose(navigateTimeRange(value, 1, nowMs, config))}
          type="button"
        >
          Next window
        </button>
        <button
          onClick={() => {
            if (value.playback.kind === "paused") commitAndClose(resumeTimeRange(value));
            else if (value.playback.kind === "fixed") commitAndClose(resetTimeRange(value));
            else commitAndClose(pauseTimeRange(value, nowMs, config));
          }}
          type="button"
        >
          {value.playback.kind === "paused"
            ? "Resume"
            : value.playback.kind === "fixed"
              ? "Resume live"
              : "Pause"}
        </button>
        <button onClick={() => commitAndClose(resetTimeRange(value))} type="button">
          Reset to live
        </button>
      </div>
    </div>
  );

  return (
    <div className={`time-range-picker ${className}`}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={labels.trigger ?? "Choose time range"}
        className="time-range-picker__trigger"
        onClick={() => {
          resetDraft();
          setOpen((current) => !current);
        }}
        ref={triggerRef}
        type="button"
      >
        <span>{triggerLabel}</span>
        <small>
          {value.playback.kind === "paused" ? "Paused" : resolved.live ? "Live" : "Fixed"}
        </small>
      </button>
      {open && presentation === "desktop" ? surface : null}
      {open && presentation === "mobile"
        ? createPortal(
            <div
              className="time-range-picker__backdrop"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  resetDraft();
                  close();
                }
              }}
            >
              {surface}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
