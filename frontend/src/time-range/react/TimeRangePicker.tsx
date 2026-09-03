import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  changeTimeRangeTimezone,
  createCalendarRange,
  createRelativeRange,
  formatTimeRangeExpression,
  formatTimeRangePill,
  incrementTimeRangeExpression,
  navigateTimeRange,
  parseTimeRangeExpression,
  pauseTimeRange,
  resetTimeRange,
  resolveTimeRange,
  resumeTimeRange,
  validateTimeRangeValue,
  type CalendarPresetId,
  type TimeRangeConfig,
  type TimeRangeValidationError,
  type TimeRangeValue,
} from "../core";
import "../styles/time-range-picker.css";

export type DurationPreset = { durationMs: number; id: string; label: string };
export type CalendarPreset = { id: CalendarPresetId; label: string };

export type TimeRangePickerLabels = {
  apply?: string;
  applyTimezone?: string;
  calendar?: string;
  calendarRange?: string;
  calendarPresets?: string;
  cancel?: string;
  close?: string;
  closeAria?: string;
  controls?: string;
  custom?: string;
  description?: string;
  earlier?: string;
  examples?: string;
  examplesIntro?: string;
  fixed?: string;
  fixedExamples?: string;
  fixedMode?: string;
  from?: string;
  fromOccurrence?: string;
  growingMode?: string;
  growingExamples?: string;
  live?: string;
  mode?: string;
  modeAria?: string;
  more?: string;
  nextWindow?: string;
  nextMonth?: string;
  options?: string;
  pause?: string;
  paused?: string;
  past?: string;
  previousWindow?: string;
  previousMonth?: string;
  quickRanges?: string;
  relativeExamples?: string;
  resetLive?: string;
  resume?: string;
  resumeLive?: string;
  selectCalendar?: string;
  secondsRange?: string;
  since?: string;
  timezone?: string;
  title?: string;
  to?: string;
  toOccurrence?: string;
  trigger?: string;
  unixExamples?: string;
  viewDocs?: string;
  weekdays?: readonly string[];
  windowNavigation?: string;
  windowOrigin?: string;
  zoomOrigin?: string;
  backToPresets?: string;
  later?: string;
};

export type TimeRangePickerProps = {
  calendarPresets: readonly CalendarPreset[];
  className?: string;
  config: TimeRangeConfig;
  formatDraftError?: (
    code: "ambiguous" | "invalid" | "nonexistent",
    field: "from" | "to",
  ) => string;
  formatValidationError?: (error: TimeRangeValidationError) => string;
  labels?: TimeRangePickerLabels;
  nowMs: number;
  onCommit: (value: TimeRangeValue) => void;
  presentation?: "desktop" | "mobile";
  portalClassName?: string;
  presets: readonly DurationPreset[];
  style?: CSSProperties;
  timezoneOptions: readonly string[];
  value: TimeRangeValue;
};

type SurfaceMode = "calendar" | "more" | "presets";
type CalendarDay = { day: number; month: number; year: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MORE_GROUPS = [
  {
    label: "Relative",
    values: ["45m", "12 hours", "10d", "2 weeks", "last month", "yesterday", "today"],
  },
  {
    label: "Fixed",
    values: ["Aug 1", "Aug 1 - Aug 2", "8/1", "8/1 - 8/2", "5:00 pm - 11:00 pm"],
  },
  { label: "Growing", values: ["since 8/1", "Aug 2 12pm to now"] },
] as const;
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]";

function Icon({
  kind,
}: {
  kind: "back" | "calendar" | "close" | "forward" | "more" | "pause" | "play";
}) {
  if (kind === "pause") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M4 3h3v10H4zm5 0h3v10H9z" />
      </svg>
    );
  }
  if (kind === "play") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="m5 3 8 5-8 5z" />
      </svg>
    );
  }
  if (kind === "calendar") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M3 2h1v2h8V2h1v2h1v10H2V4h1zm0 5v6h10V7zm2 1h2v2H5z" />
      </svg>
    );
  }
  if (kind === "more") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <circle cx="4" cy="8" r="1.4" />
        <circle cx="8" cy="8" r="1.4" />
        <circle cx="12" cy="8" r="1.4" />
      </svg>
    );
  }
  if (kind === "close") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  const forward = kind === "forward";
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d={forward ? "m5 3 5 5-5 5m5-10v10" : "m11 3-5 5 5 5M6 3v10"}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function offsetLabel(instantMs: number, timezone: string): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instantMs)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!name || name === "GMT") return "UTC+00:00";
  return name.replace("GMT", "UTC");
}

function durationPill(durationMs: number): string {
  const minute = 60_000;
  const units = [
    [30 * 24 * 60 * minute, "mo"],
    [7 * 24 * 60 * minute, "w"],
    [24 * 60 * minute, "d"],
    [60 * minute, "h"],
    [minute, "m"],
  ] as const;
  const match = units.find(([size]) => durationMs % size === 0);
  return match
    ? `${String(durationMs / match[0])}${match[1]}`
    : `${String(Math.round(durationMs / minute))}m`;
}

function sameDay(left: CalendarDay | null, right: CalendarDay): boolean {
  return Boolean(
    left && left.day === right.day && left.month === right.month && left.year === right.year,
  );
}

export function TimeRangePicker({
  calendarPresets,
  className = "",
  config,
  formatDraftError,
  formatValidationError,
  labels = {},
  nowMs,
  onCommit,
  presentation = "desktop",
  portalClassName = "",
  presets,
  style,
  timezoneOptions,
  value,
}: TimeRangePickerProps) {
  const listboxId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(-1);
  const [mode, setMode] = useState<SurfaceMode>("presets");
  const [draftExpression, setDraftExpression] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [calendarStart, setCalendarStart] = useState<CalendarDay | null>(null);
  const current = useMemo(() => new Date(nowMs), [nowMs]);
  const [visibleMonth, setVisibleMonth] = useState(() => ({
    month: Number(
      new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: value.timezone }).format(
        current,
      ),
    ),
    year: Number(
      new Intl.DateTimeFormat("en-US", { timeZone: value.timezone, year: "numeric" }).format(
        current,
      ),
    ),
  }));
  const resolved = useMemo(() => resolveTimeRange(value, nowMs, config), [config, nowMs, value]);
  const committedExpression = useMemo(
    () => formatTimeRangeExpression(value, nowMs, config),
    [config, nowMs, value],
  );
  const committedPill = useMemo(
    () => formatTimeRangePill(value, nowMs, config),
    [config, nowMs, value],
  );
  const timezoneOffset = useMemo(
    () => offsetLabel(resolved.toMs, value.timezone),
    [resolved.toMs, value.timezone],
  );
  const text = {
    backToPresets: "Back to presets",
    calendarPresets: "Calendar presets",
    calendarRange: "Calendar range",
    closeAria: "Close time range picker",
    controls: "Time range controls",
    earlier: "Earlier",
    examples: "Custom time examples",
    examplesIntro: "Type custom times like:",
    fixedExamples: "Fixed",
    growingExamples: "Growing",
    later: "Later",
    more: "More",
    nextWindow: "Step forward",
    nextMonth: "Next month",
    options: "Time range options",
    pause: "Pause",
    previousWindow: "Step back",
    previousMonth: "Previous month",
    relativeExamples: "Relative",
    resetLive: "Reset to live",
    resume: "Play",
    selectCalendar: "Select from calendar…",
    secondsRange: "seconds range",
    timezone: "Timezone",
    title: "Time range",
    trigger: "Time range picker",
    unixExamples: "Unix timestamps",
    viewDocs: "View Docs",
    weekdays: WEEKDAYS,
    ...labels,
  };

  const close = () => {
    setOpen(false);
    setMode("presets");
    setCalendarStart(null);
    setError(null);
    setErrorCode(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openPicker = () => {
    const selectedPresetId =
      value.selection.kind === "relative" ? value.selection.presetId : undefined;
    setDraftExpression(committedExpression);
    setError(null);
    setErrorCode(null);
    setMode("presets");
    setActiveOptionIndex(
      selectedPresetId ? presets.findIndex((preset) => preset.id === selectedPresetId) : 0,
    );
    setOpen(true);
  };

  const commit = (next: TimeRangeValue) => {
    const invalid = validateTimeRangeValue(next, nowMs, config);
    if (invalid) {
      setError(formatValidationError?.(invalid) ?? invalid.message);
      setErrorCode(invalid.code);
      return false;
    }
    onCommit(next);
    close();
    return true;
  };

  const commitExpression = (expression = draftExpression, occurrence?: "earlier" | "later") => {
    if (!occurrence && expression.trim() === committedExpression) {
      close();
      return true;
    }
    const parsed = parseTimeRangeExpression(expression, {
      config,
      nowMs,
      ...(occurrence ? { occurrence } : {}),
      referenceValue: value,
      timezone: value.timezone,
    });
    if (!parsed.ok) {
      if (parsed.validationError) {
        setError(formatValidationError?.(parsed.validationError) ?? parsed.message);
        setErrorCode(parsed.validationError.code);
        return false;
      }
      const kind =
        parsed.code === "ambiguous_wall_time"
          ? "ambiguous"
          : parsed.code === "nonexistent_wall_time"
            ? "nonexistent"
            : "invalid";
      setError(formatDraftError?.(kind, parsed.field === "to" ? "to" : "from") ?? parsed.message);
      setErrorCode(parsed.code);
      return false;
    }
    setDraftExpression(parsed.canonicalExpression);
    return commit(parsed.value);
  };

  useEffect(() => {
    if (!open) return;
    if (presentation === "mobile") {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() =>
        surfaceRef.current?.querySelector<HTMLInputElement>(".time-range-picker__input")?.focus(),
      );
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        surfaceRef.current?.contains(target) ||
        inputRef.current?.closest(".time-range-picker__cluster")?.contains(target)
      )
        return;
      close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, presentation]);

  const onSurfaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (presentation !== "mobile" || event.key !== "Tab") return;
    const focusable = [...(surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = focusable[0];
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

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) {
        openPicker();
      } else if (activeOptionIndex >= 0 && mode === "presets") {
        if (activeOptionIndex < presets.length) {
          const preset = presets[activeOptionIndex]!;
          commit(createRelativeRange(preset.durationMs, preset.id, value.timezone));
        } else if (activeOptionIndex === presets.length) {
          setMode("calendar");
          setActiveOptionIndex(-1);
        } else {
          setMode("more");
          setActiveOptionIndex(-1);
        }
      } else commitExpression();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    if (start === end) {
      event.preventDefault();
      if (!open) openPicker();
      else {
        const count = presets.length + 2;
        setActiveOptionIndex((currentIndex) =>
          event.key === "ArrowDown"
            ? (Math.max(currentIndex, -1) + 1) % count
            : (currentIndex <= 0 ? count : currentIndex) - 1,
        );
      }
      return;
    }
    const incremented = incrementTimeRangeExpression(
      draftExpression,
      start,
      end,
      event.key === "ArrowUp" ? 1 : -1,
    );
    if (!incremented) return;
    event.preventDefault();
    setDraftExpression(incremented.expression);
    requestAnimationFrame(() =>
      input.setSelectionRange(incremented.selectionStart, incremented.selectionEnd),
    );
  };

  const monthDate = new Date(Date.UTC(visibleMonth.year, visibleMonth.month - 1, 1));
  const firstWeekday = monthDate.getUTCDay();
  const dayCount = new Date(Date.UTC(visibleMonth.year, visibleMonth.month, 0)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat(config.locale, {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(monthDate);

  const selectDay = (day: number) => {
    const selected = { day, month: visibleMonth.month, year: visibleMonth.year };
    if (!calendarStart) {
      setCalendarStart(selected);
      return;
    }
    const left = Date.UTC(calendarStart.year, calendarStart.month - 1, calendarStart.day);
    const right = Date.UTC(selected.year, selected.month - 1, selected.day);
    const [from, to] = left <= right ? [calendarStart, selected] : [selected, calendarStart];
    commitExpression(
      `${String(from.month)}/${String(from.day)}/${String(from.year)} - ${String(to.month)}/${String(to.day)}/${String(to.year)}`,
    );
  };

  const chooseExample = (expression: string) => {
    setDraftExpression(expression);
    commitExpression(expression);
  };

  const expressionInput = (mobile: boolean) => (
    <div
      className={`time-range-picker__input-shell${mobile ? " time-range-picker__input-shell--sheet" : ""}`}
    >
      <span aria-hidden="true" className="time-range-picker__pill">
        {committedPill}
      </span>
      <input
        aria-activedescendant={
          open && mode === "presets" && activeOptionIndex >= 0
            ? `${listboxId}-option-${String(activeOptionIndex)}`
            : undefined
        }
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={error ? "true" : undefined}
        aria-label={text.trigger}
        className="time-range-picker__input"
        onChange={(event) => {
          setDraftExpression(event.target.value);
          setActiveOptionIndex(-1);
          setError(null);
          setErrorCode(null);
        }}
        onClick={() => {
          if (!open) openPicker();
        }}
        onKeyDown={onInputKeyDown}
        ref={mobile ? undefined : inputRef}
        role="combobox"
        spellCheck={false}
        value={open ? draftExpression : committedExpression}
      />
      <span aria-hidden="true" className="time-range-picker__caret">
        ▾
      </span>
      <span className="time-range-picker__offset">{timezoneOffset}</span>
    </div>
  );

  const presetList = (
    <div
      aria-label={text.options}
      className="time-range-picker__menu"
      id={listboxId}
      role="listbox"
    >
      {presets.map((preset, index) => (
        <button
          aria-selected={
            activeOptionIndex >= 0
              ? activeOptionIndex === index
              : value.selection.kind === "relative" && value.selection.presetId === preset.id
          }
          className="time-range-picker__option"
          id={`${listboxId}-option-${String(index)}`}
          key={preset.id}
          onClick={() => commit(createRelativeRange(preset.durationMs, preset.id, value.timezone))}
          role="option"
          type="button"
        >
          <span className="time-range-picker__option-pill">{durationPill(preset.durationMs)}</span>
          <span>{preset.label}</span>
        </button>
      ))}
      <button
        aria-selected={activeOptionIndex === presets.length}
        className="time-range-picker__option"
        id={`${listboxId}-option-${String(presets.length)}`}
        onClick={() => setMode("calendar")}
        role="option"
        type="button"
      >
        <span className="time-range-picker__option-pill">
          <Icon kind="calendar" />
        </span>
        <span>{text.selectCalendar}</span>
      </button>
      <button
        aria-selected={mode === "more" || activeOptionIndex === presets.length + 1}
        className="time-range-picker__option"
        id={`${listboxId}-option-${String(presets.length + 1)}`}
        onClick={() => setMode((currentMode) => (currentMode === "more" ? "presets" : "more"))}
        role="option"
        type="button"
      >
        <span className="time-range-picker__option-pill">
          <Icon kind="more" />
        </span>
        <span>{text.more}</span>
      </button>
    </div>
  );

  const morePanel =
    mode === "more" ? (
      <aside aria-label={text.examples} className="time-range-picker__more">
        <div className="time-range-picker__more-heading">
          <strong>{text.examplesIntro}</strong>
          <a
            href="https://docs.datadoghq.com/dashboards/guide/custom_time_frames/"
            rel="noreferrer"
            target="_blank"
          >
            {text.viewDocs}
          </a>
        </div>
        {MORE_GROUPS.map((group) => (
          <section key={group.label}>
            <span>
              {group.label === "Relative"
                ? text.relativeExamples
                : group.label === "Fixed"
                  ? text.fixedExamples
                  : text.growingExamples}
            </span>
            <div>
              {group.values.map((example) => (
                <button key={example} onClick={() => chooseExample(example)} type="button">
                  {example}
                </button>
              ))}
            </div>
          </section>
        ))}
        <section>
          <span>{text.unixExamples}</span>
          <button
            onClick={() =>
              chooseExample(
                `${String(Math.floor((nowMs - 7 * 86_400_000) / 1000))} - ${String(Math.floor(nowMs / 1000))}`,
              )
            }
            type="button"
          >
            {text.secondsRange}
          </button>
        </section>
        <section>
          <span>{text.calendarPresets}</span>
          <div>
            {calendarPresets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => commit(createCalendarRange(preset.id, value.timezone))}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </section>
        <section className="time-range-picker__timezone-section">
          <label>
            <span>{text.timezone}</span>
            <select
              aria-label={text.timezone}
              onChange={(event) => commit(changeTimeRangeTimezone(value, event.target.value))}
              value={value.timezone}
            >
              {timezoneOptions.map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </label>
        </section>
      </aside>
    ) : null;

  const calendarPanel =
    mode === "calendar" ? (
      <div aria-label={text.calendarRange} className="time-range-picker__calendar">
        <header>
          <button
            aria-label={text.previousMonth}
            onClick={() =>
              setVisibleMonth((month) => {
                const previous = new Date(Date.UTC(month.year, month.month - 2, 1));
                return { month: previous.getUTCMonth() + 1, year: previous.getUTCFullYear() };
              })
            }
            type="button"
          >
            <Icon kind="back" />
          </button>
          <strong>{monthLabel}</strong>
          <button
            aria-label={text.nextMonth}
            onClick={() =>
              setVisibleMonth((month) => {
                const next = new Date(Date.UTC(month.year, month.month, 1));
                return { month: next.getUTCMonth() + 1, year: next.getUTCFullYear() };
              })
            }
            type="button"
          >
            <Icon kind="forward" />
          </button>
        </header>
        <div className="time-range-picker__calendar-grid">
          {(text.weekdays ?? WEEKDAYS).map((weekday) => (
            <span aria-hidden="true" key={weekday}>
              {weekday}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span aria-hidden="true" key={`blank-${String(index)}`} />
          ))}
          {Array.from({ length: dayCount }, (_, index) => {
            const day = index + 1;
            const date = new Date(Date.UTC(visibleMonth.year, visibleMonth.month - 1, day));
            const label = new Intl.DateTimeFormat(config.locale, {
              dateStyle: "long",
              timeZone: "UTC",
            }).format(date);
            return (
              <button
                aria-label={label}
                aria-pressed={sameDay(calendarStart, {
                  day,
                  month: visibleMonth.month,
                  year: visibleMonth.year,
                })}
                key={day}
                onClick={() => selectDay(day)}
                type="button"
              >
                {day}
              </button>
            );
          })}
        </div>
        <button
          className="time-range-picker__back"
          onClick={() => {
            setCalendarStart(null);
            setMode("presets");
          }}
          type="button"
        >
          {text.backToPresets}
        </button>
      </div>
    ) : null;

  const surface = (
    <div
      aria-labelledby={titleId}
      aria-modal={presentation === "mobile" ? "true" : undefined}
      className={`time-range-picker__surface time-range-picker__surface--${presentation}`}
      onKeyDown={onSurfaceKeyDown}
      ref={surfaceRef}
      role="dialog"
    >
      <h2 className="sr-only" id={titleId}>
        {text.title}
      </h2>
      {presentation === "mobile" ? (
        <div className="time-range-picker__mobile-heading">
          {expressionInput(true)}
          <button aria-label={text.closeAria} onClick={close} type="button">
            <Icon kind="close" />
          </button>
        </div>
      ) : null}
      <div className="time-range-picker__panels">
        {mode === "calendar" ? calendarPanel : presetList}
        {morePanel}
      </div>
      {error ? (
        <div className="time-range-picker__error" role="alert">
          <span>{error}</span>
          {errorCode === "ambiguous_wall_time" ? (
            <span>
              <button onClick={() => commitExpression(draftExpression, "earlier")} type="button">
                {text.earlier}
              </button>
              <button onClick={() => commitExpression(draftExpression, "later")} type="button">
                {text.later}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className={`time-range-picker time-range-picker--${presentation} ${className}`}
      style={style}
    >
      <div
        aria-hidden={open && presentation === "mobile" ? "true" : undefined}
        aria-label={text.controls}
        className="time-range-picker__cluster"
        role="group"
      >
        {expressionInput(false)}
        <div className="time-range-picker__playback">
          <button
            aria-label={text.previousWindow}
            onClick={() => commit(navigateTimeRange(value, -1, nowMs, config))}
            type="button"
          >
            <Icon kind="back" />
          </button>
          <button
            aria-label={
              value.playback.kind === "running" && resolved.live ? text.pause : text.resume
            }
            onClick={() => {
              if (value.playback.kind === "running" && resolved.live)
                commit(pauseTimeRange(value, nowMs, config));
              else if (value.playback.kind === "paused") commit(resumeTimeRange(value));
              else commit(resetTimeRange(value, config));
            }}
            type="button"
          >
            <Icon kind={value.playback.kind === "running" && resolved.live ? "pause" : "play"} />
          </button>
          <button
            aria-label={text.nextWindow}
            onClick={() => commit(navigateTimeRange(value, 1, nowMs, config))}
            type="button"
          >
            <Icon kind="forward" />
          </button>
        </div>
      </div>
      {open && presentation === "desktop" ? surface : null}
      {open && presentation === "mobile"
        ? createPortal(
            <div
              className={`time-range-picker__backdrop ${portalClassName || className}`}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) close();
              }}
              style={style}
            >
              {surface}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
