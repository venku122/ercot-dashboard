# Reusable TimeRangePicker design

Status: frozen before implementation on 2026-09-01 and updated after implementation to describe the implemented source-module boundary.

## Why a source module

The repository is a single Vite application rather than a workspace. Converting it to a workspace solely for this control would expand migration and release risk. The implementation will therefore live at `frontend/src/time-range/` with explicit `core`, `react`, `styles`, and public entrypoints. Core code will have no React or dashboard imports, so moving it into a package later is mechanical.

## Domain model

The reusable API uses epoch milliseconds with names ending in `Ms`.

```ts
type LiveTimeRangeSpec =
  | { kind: "relative"; durationMs: number; presetId?: string }
  | { kind: "growing"; fromMs: number }
  | { kind: "calendar"; preset: CalendarPresetId };

type FixedTimeRangeSpec = {
  kind: "fixed";
  fromMs: number;
  toMs: number;
  origin: "custom" | "zoom" | "navigation";
};

type TimeRangeValue =
  | { selection: LiveTimeRangeSpec; playback: { kind: "running" }; timezone: string }
  | {
      selection: LiveTimeRangeSpec;
      playback: { kind: "paused"; fromMs: number; toMs: number };
      timezone: string;
    }
  | {
      selection: FixedTimeRangeSpec;
      playback: { kind: "fixed" };
      lastLiveSelection?: { selection: LiveTimeRangeSpec; timezone: string };
      timezone: string;
    };
```

This union prevents contradictory fixed/live/paused booleans. `resolveTimeRange(value, nowMs, config)` produces an immutable absolute `ResolvedTimeWindow`. A fixed or paused value never ticks. A running relative, growing, or current-calendar value resolves against injected `nowMs` without mutating semantic identity.

Transitions are pure functions: select preset, pause, resume, navigate, reset live, zoom/custom fixed, and change timezone. Fixed timezone changes preserve instants. Calendar timezone changes preserve the expression and re-resolve. The previous live selection travels with fixed states so Reset Live is not duration inference.

## Timezone and wall-time algorithm

`Intl.DateTimeFormat.formatToParts` supplies deterministic wall parts in an IANA zone. Parsing a wall time will:

1. validate the calendar fields without normalization;
2. search a bounded UTC candidate interval for instants whose formatted wall parts exactly match;
3. return `nonexistent` for zero matches;
4. return `ambiguous` plus the earlier/later instants for two matches;
5. require an explicit occurrence choice before Apply.

Calendar boundaries use wall-date arithmetic followed by the same exact resolver. They never assume a day is 86,400 seconds. Week starts Monday. Previous week/month are closed-open local calendar intervals; current-to-date ranges end at injected now.

## Validation

Validation accepts configurable minimum and maximum durations. ERCOT supplies five minutes and 365 days. Errors are structured codes with field targets and specific messages for order, too short, too long, malformed input, nonexistent wall time, and ambiguous wall time.

## URL codec

The generic codec reads/writes time-only canonical fields with a configurable prefix. The canonical ERCOT composition will use:

- `time_kind`: `relative`, `growing`, `calendar`, or `fixed`
- `time_value`: duration milliseconds, calendar preset, or growing start milliseconds
- `time_tz`: IANA timezone
- `time_play`: `running`, `paused`, or `fixed`
- `time_from_ms` / `time_to_ms`: paused or fixed endpoints
- `time_origin`: fixed origin
- `time_last_kind` / `time_last_value` / `time_last_tz`: reset-live memory for fixed values

The dashboard adapter parses these first, then bounded legacy seconds fields. Dashboard serialization only replaces time-owned keys and preserves `view`, compare fields, events, history, legend, inspect, hidden series, and view-specific selectors.

## React boundary

`TimeRangePicker` is controlled: `value`, `onCommit`, `nowMs`, preset/calendar lists, timezone options, duration bounds, labels/locale, class name, and presentation configuration are inputs. Draft mode/from/to/timezone/ambiguity choices stay local and never invoke `onCommit`. Preset buttons commit once. Apply validates and commits once. Cancel, Escape, or outside close discards draft and restores trigger focus.

Desktop uses a compact non-modal popover surface with dialog semantics and managed focus. Mobile portals the same generic editor into an opaque, focus-trapped sheet. Consumer class, portal class, style variables, labels, validation formatting, and presentation mode are inputs; the module imports no dashboard component. Both surfaces render the same editor and transitions.

Styles are scoped under `.time-range-picker` and use CSS custom properties. No page-level selector is required.

## ERCOT adapter and migration

`frontend/src/dashboard/time-range-adapter.ts` is the only conversion between milliseconds and the existing seconds-based query/chart boundary. It exposes the resolved `TimeState` shape needed by Chart.js, compare, API, SWR, and tile planning. `DashboardState` owns `TimeRangeValue`, while resolved seconds are derived once in `App` from semantic state and the current tick.

Chart zoom commits a fixed value with `origin: "zoom"`; fractional Chart.js scale values are rounded at the milliseconds adapter boundary. Previous/Next derives a fixed navigation value. Reset Live calls the semantic transition. Chart.js remains the renderer.

Compare day/week will reuse generic timezone calendar shifting through a thin seconds adapter. Previous period stays exact-duration arithmetic. API request code continues to receive the established seconds `TimeState`, preserving fixed tiles/chunks, live tails, max points, decimation, and server-authoritative statistics.

## Fetch/race behavior

Picker drafts do not touch dashboard state, so they cannot change SWR keys or the chart load context. Every commit changes semantic state once; App derives one resolved window. Existing per-effect `AbortController` cleanup remains, and a request-generation guard prevents a late non-cooperative result from settling over a newer range. During refresh, existing data stays paired with its prior x-domain and is marked busy until replacement data and its matching domain commit together.

## Second-consumer proof

A component fixture will mount two independent controlled instances using UTC or America/New_York, a different preset list/default, different min/max limits, consumer labels, and theme variables. It will import only the public `time-range` entrypoint and no dashboard code.

## Performance choices

No date-picker or timezone package is added. Expensive `Intl.DateTimeFormat` instances are cached by locale/timezone/options outside render paths. Configuration arrays are module constants. The picker never traverses chart data. Existing SWR remains the data-fetching owner in line with the React performance guidance used for this work.
