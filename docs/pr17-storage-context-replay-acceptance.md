# PR17 storage context replay acceptance contract

## Scope and degraded truth boundary

PR17 is the degraded, source-supported form of the requested Battery event
replay UX. It may display fleet storage observations beside frequency and two
exact PR14 market-mechanics readings on a common UTC time axis. It is a
**storage context replay**, not a replay of an individual battery, a dispatch,
or a response event.

The current four-second Energy Storage Resource source is unavailable. ERCOT
staff confirmed that the former subscription API contains data only before
RTC+B began on December 5, 2025 and has no current API or ICCP replacement.
PR17 therefore does not collect, query, backfill, or label a current or
high-resolution ESR series. It does not expose resource identity, state of
charge, stored energy, remaining duration, capacity utilization, dispatch
intent, participation, revenue, or individual-resource behavior.

Every replay response and derived view uses the stable explanation policy:

```text
multi_cadence_context_not_battery_response_attribution
```

The stable alignment policy is:

```text
display_window_only
```

Signals share a reviewed display window; their observations are not joined.
Timing alone does not establish that storage responded to frequency, System
Lambda, or available Ancillary Service capability.

## Exact accepted inputs

The slice accepts exactly these existing series and no others:

| Replay identity                | Existing source identity           | Exact series identity                              | Unit    | Native time basis and cadence                        |
| ------------------------------ | ---------------------------------- | -------------------------------------------------- | ------- | ---------------------------------------------------- |
| Frequency                      | `ercot_realtime`                   | `ercot.Frequency.Current_Frequency`                | `Hz`    | Collector capture time; nominal 60-second collection |
| Fleet charging                 | `energy_storage`                   | `ercot.storage.charging_mw`                        | `MW`    | Source `epoch`; five-minute observation              |
| Fleet discharging              | `energy_storage`                   | `ercot.storage.discharging_mw`                     | `MW`    | Source `epoch`; five-minute observation              |
| Fleet net output               | `energy_storage`                   | `ercot.storage.net_output_mw`                      | `MW`    | Source `epoch`; five-minute observation              |
| System Lambda marker           | `ercot_mis_np6_322` / `NP6-322-CD` | `market.sced.system-lambda`                        | `$/MWh` | Exact PR14 current or previous SCED `target_ts`      |
| Available AS capability marker | `ercot_mis_np6_328` / `NP6-328-CD` | `market.sced.as-capability.regup-rrs-ecrs-nonspin` | `MW`    | Exact PR14 current or previous SCED `target_ts`      |

Frequency is the value captured by the existing collector once per nominal
minute. The legacy adapter does not retain the wall-clock `Last Updated` label
from the HTML page. Its timestamp must consequently be described as collector
capture time, not ERCOT publication time, and it cannot establish sub-minute
ordering.

Storage retains the PR16 contract unchanged. The anonymous
`energy-storage-resources.json` source supplies system-wide values, not
resource rows. Its exact row fields are `tagCLastTime`, `dstFlag`,
`totalCharging`, `totalDischarging`, `netOutput`, `timestamp`, and `epoch`.
The 13-digit millisecond epoch and offset-bearing timestamp must agree;
charging is non-positive, discharging is non-negative, and the independently
published net output must equal their sum within `0.01 MW`. The two-day source
payload remains capped at 600 rows and is reread with the existing 50-hour
correction overlap.

The two market markers are selected only from PR14's `current` and `previous`
coherent snapshots. Within each snapshot, the NP6-322 System Lambda and
NP6-328 capability value have the exact same normalized SCED `target_ts` and
retain their own row-level source provenance. The capability combination is
one overlapping ERCOT measurement; it is not a sum calculated by PR17 and it
does not describe an award, deployment, or battery response. If either PR14
snapshot is absent or invalid, PR17 omits that snapshot's two markers rather
than assembling independently latest readings.

The nested PR14 manifest retains its own established
`time_adjacent_context_not_causal_decomposition` explanation policy. That
source-product policy does not replace PR17's required
`multi_cadence_context_not_battery_response_attribution` replay policy.

The legacy `ercot_ancillary` capacity-monitor metrics and legacy
`ercot_pricing` Settlement Point Price metrics are outside this slice. PR17
must not request them, silently substitute them, or relabel either as the PR14
capability or System Lambda source. NP6-323 price adders, NP6-332 MCPC,
NP6-788 LMP, NP6-905 Settlement Point Price, and Operations Messages are also
outside the minimum replay contract.

## Window, alignment, and gaps

The request interval is an integer-second, half-open UTC window `[start, end)`.
`start` must be earlier than `end`, and `end - start` must not exceed 86,400
seconds. A request wider than 24 hours fails closed; it is not silently clipped.

Each series preserves only its own native timestamp and value. Selection is
the independent predicate `start <= observation timestamp < end`. PR17 must
not perform a nearest-time or exact-time cross-series join, forward-fill,
back-fill, linear interpolation, step interpolation, zero-fill, averaging, or
arithmetic across the inputs. In particular:

- a frequency capture does not acquire a five-minute storage timestamp;
- a storage row does not acquire a SCED timestamp;
- current and previous PR14 markers remain at their exact SCED seconds; and
- missing intervals remain visible gaps and do not create synthetic points.

“Synchronized” means only that independent native observations are displayed
on one UTC axis within the same requested window. Tooltip and exact-value UI
must expose the native observation time and time basis. The replay must not
use language such as “simultaneous,” “at the moment the battery responded,” or
“storage response time.”

For one maximum-width request, the accepted numeric cardinality is bounded by
1,440 frequency captures, 288 observations for each of the three storage
series, and at most the current and previous marker for each of the two PR14
series: at most 2,308 numeric observations. Duplicate identities, an
out-of-window observation, or a response above these bounds fails validation;
the UI does not truncate an otherwise accepted response without disclosure.
PR17 adds no duplicate receiver table, raw publication archive, or retention
policy.

## Provenance, status, and annotation semantics

Frequency exposes `source_id=ercot_realtime` and
`time_basis=collector_capture_time`. Storage exposes
`source_id=energy_storage`, `time_basis=source_epoch`, and the existing source
health. Each market marker retains the exact PR14 source object, including
product, normalized `issued_at`, raw publish time, raw SCED time, and repeated
hour flag. A resource-wide publication time may not replace row provenance.

The current and previous SCED values are source observations, not events or
official ERCOT annotations. P0 adds no official event source. Gap, stale,
failed, unavailable, and discontinued-source notices are labeled `source`.
Any cursor, selected window, extrema callout, or comparison delta created by
the application is labeled `derived`; it must identify its rule and must not
be presented as an ERCOT declaration. A derived delta may compare the exact
current and previous value of the same PR14 scalar, but it is not a price
component or causal contribution.

Source states remain distinct. A missing storage interval is not zero MW. An
absent PR14 snapshot is not a zero marker. Delayed frequency captures remain
capture-time observations with a disclosed gap. The discontinued four-second
ESR source is `historical_only_discontinued`, never healthy, live, stale,
failed, valid-empty, or current-zero.

## UI and copy acceptance

The visible title uses “Storage context replay.” Supporting copy says:

> Fleet storage, frequency, System Lambda, and available AS capability are
> shown in the same UTC window. Their different timestamps and cadences are
> preserved; timing alone does not establish cause or battery response.

The UI identifies frequency as 60-second capture-time data, storage as
five-minute system-wide data, and the two market values as exact-SCED markers.
It never uses “high-resolution battery replay,” “four-second,” “live ESR,”
“state of charge,” “battery dispatch,” “battery response,” “caused,” “driven
by,” or equivalent unsupported copy.

Desktop and mobile expose the same observations and policies. At 440 CSS
pixels, controls remain at least 44 CSS pixels high, the page has no horizontal
overflow, and any exact-value table confines horizontal scrolling to its own
focusable region. Hiding labels or reducing visual detail on mobile must not
drop a source series, change a timestamp, fill a gap, or alter the causal
disclaimer.

## Deterministic acceptance goldens

Independent pure and browser acceptance must prove all of the following:

1. The exact six series identities and units above are exhaustive; legacy
   ancillary, pricing, ESR, and additional PR14 series are rejected.
2. A fixture with minute frequency captures, five-minute storage observations,
   and off-grid SCED seconds preserves each x coordinate exactly on one UTC
   axis without joining or interpolation.
3. A missing frequency or storage interval remains a discontinuity, and a
   missing current or previous PR14 snapshot produces no synthetic marker.
4. A 24-hour half-open window is accepted with at most 2,308 observations;
   zero-length, reversed, wider, out-of-window, duplicate, non-finite, and
   over-cardinality inputs fail closed.
5. A Chicago repeated hour keeps distinct storage epochs and PR14 SCED instants;
   frequency remains explicitly capture-time based.
6. The explanation and alignment policy literals are exact, source and derived
   annotations remain distinct, and forbidden causal/high-resolution/ESR/SOC
   claims do not render.
7. The collapsed view starts no request. Opening replay reuses the existing
   frequency, storage, and PR14 lifecycles and never requests legacy ancillary,
   legacy pricing, Operations Messages, or the discontinued ESR endpoint.
8. Desktop Chromium and iPhone Pro Max WebKit prove native-time gaps, readable
   provenance and disclaimer copy, 44-point controls, focusable exact values,
   and no 440-point viewport overflow.
