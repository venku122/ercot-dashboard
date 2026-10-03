# PR17 battery event replay acceptance

PR17 adds a bounded, synchronized view of nearby grid evidence around a selected battery event
window. It is a context replay, not a causal model. The view preserves the native observation
times, gaps, units, and independent scales of frequency, storage, and market context. It never
interpolates one source onto another source's timestamps and never describes a nearby market or
operations observation as the cause of storage behavior.

## Source and resolution boundary

- Storage remains the official five-minute system-wide aggregate already loaded by the Generation
  storage chart. The replay does not issue a second storage request and does not expose
  state-of-charge, individual-resource behavior, dispatch intent, or efficiency.
- Frequency is the existing 60-second dashboard observation series. It is requested only while the
  replay is open.
- Market context comes from the bounded market-mechanics manifest. Its open-day evidence is only the
  exact coherent `current` and `previous` snapshots published by that manifest. Those observations
  are markers, not a fabricated current-day history trace.
- The retired ESR four-second source has no nonempty reviewed row contract or current feed. PR17 must
  not claim four-second battery response, current ESR coverage, or an ESR resource-level replay.
- A common UTC domain and cursor mean synchronized display only. Every exact row retains its source's
  actual timestamp; unequal cadences, missing intervals, and negative values remain visible.

## Annotation provenance

Annotations are visibly and structurally separated:

1. **Source observation** identifies a value and timestamp supplied by a named source.
2. **Dashboard derived** identifies deterministic presentation logic and states the methodology.
3. **Official event unavailable** says that no official event evidence is available in the replay
   contract. It is not silently replaced by a source or derived annotation.

No annotation uses causal terms such as “caused,” “because of,” “responded to,” or “resulted in.”

## Lifecycle and request ownership

1. Outside Generation, and while the replay disclosure is collapsed, there are zero replay
   frequency or market-manifest requests.
2. Opening the replay requests only frequency plus one market-mechanics manifest. It reuses the
   already-loaded storage series and makes no duplicate storage request.
3. Only the selected bounded replay window is retained. Switching the replay window aborts the
   previous request generation; a late result cannot mix with the new storage window or overwrite
   it.
4. Collapse, view exit, disable, and unmount abort all replay-owned requests.
5. Reopening an unchanged selection respects canonical request deduplication. PR17 adds no receiver
   storage, retention class, cache namespace, or extended TTL.
6. Partial, stale last-good, refresh-failed, and unavailable states remain visibly distinct. Missing
   evidence is never replaced with zero and a failed refresh cannot be presented as current.

## Visual and accessible contract

- Frequency, storage, and market evidence use separate labeled scales and units, aligned only by
  their common UTC domain and cursor.
- The exact-data table is the complete accessible fallback. It is keyboard focusable, contains
  source/provenance, exact UTC timestamp, value, and unit, and preserves negative values and gaps.
- Controls have visible focus and at least a 44 by 44 CSS-pixel target. Meaning is not conveyed by
  color alone, and reduced-motion preferences disable nonessential animation.
- At 440 by 956 CSS pixels there is no body-level horizontal overflow. Wide plots and tables own
  their internal scrolling, controls wrap, and the exact table remains reachable.

## Independent gates

The independent frontend acceptance suite must cover collapsed and off-view zero-request behavior;
open request cardinality and storage reuse; collapse, switch, and unmount aborts; stale-generation
rejection; exact timestamps, gaps, negative values, independent scales, and the exact table; all
three annotation states; partial, stale, and refresh-failed data; 44-pixel controls; and mobile
containment.

Desktop Chromium and iPhone Pro Max WebKit visual evidence is required for the coherent replay,
provenance distinctions, degraded evidence, and exact table. Checked-in baselines include local
Darwin and pinned Playwright Noble variants, followed immediately by no-update comparisons. The
mobile WebKit workflow explicitly includes the PR17 mobile spec.

## Deferred or blocked

- Four-second battery-response replay remains blocked until a nonempty, authoritative source,
  timestamp/natural-key contract, retention policy, and bounded resource API are reviewed.
- A continuous current-day market-mechanics trace remains blocked because the manifest currently
  exposes only current and previous coherent markers; completed UTC days alone are immutable
  history resources.
- Causal attribution, dispatch intent, individual ESR behavior, and state-of-charge remain out of
  scope even if a higher-resolution source later becomes available.
