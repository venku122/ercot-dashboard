# Mobile overview loading geometry

At primary06 the first local WebKit performance check passed, while Linux CI
had genuinely requested all six fuel histories during initial loading. A bounded
300ms source delay reproduced the failure locally. Intersection instrumentation
showed scrollY0, both preceding cards with no legend, and the fuel placeholder
intersecting882.70..1230.39px in a956px viewport. `useVisible` correctly observed
that temporary intersection and permanently mounted the chart; it was not a
counter alias or a source fixture omission.

Mobile overview cards now render their known legend controls before source data
arrives. Unknown values remain dashes and source lifecycle messages stay explicit.
The real44px controls reserve the same geometry used after hydration. The observed
initial legends are132px (supply) and88px (headroom); fuel starts1118.70px and no
longer transiently intersects. No visibility thresholds, artificial settle delay,
source data suppression, or existing assertions are changed. Non-overview/mobile
placements retain existing behavior.

The browser regression exercises normal/empty/error source scenarios at0/300/1000ms
latency, captures actual observer geometry and request IDs, requires <=2 initially
mounted/constructed charts, zero unvisited fuel history and no collapsed engineering
requests, named44px legend controls, and honest no-data/error dashes without a
canvas. Empty physical history can resolve waiting or unavailable when a separate
required forecast archive explicitly reports unavailable. The initial ceilings and
zero-undisclosed-work assertions remain exact. Intentional scrolling to fuel then
loads all six source histories; this does not count as initial work.

Native local WebKit and the frozen CI Playwright1.61.1 noble Linux/amd64 image are
used. Linux runs through architecture emulation on the local arm64 host; it matches
the image/browser configuration but is not a GitHub-hosted CPU/performance proof.
The original mobile performance test remains unchanged. No snapshots or tolerances
are updated; loading/empty mobile card placeholders intentionally gain the honest
legend controls. Physical Safari acceptance is not claimed.
