# Manual accessibility and physical device disposition

Automated Chromium and WebKit geometry, keyboard, focus, disclosure/table and live-region tests are recorded separately from spoken-output and touch testing. CSS zoom is a reflow stress test, not an assertion of every Safari browser-zoom behavior.

The macOS application inventory reported no running VoiceOver session. VoiceOver spoken output was not reviewed. NVDA was not available on this macOS execution host. Read-only Xcode device inventory listed two paired entries, with zero connected iOS devices; private names and identifiers remain outside the repository. No physical iPhone Safari gesture, browser chrome/safe-area or screen-reader result is claimed. WebKit emulation is automated browser coverage only.

Disposition: DEFERRED_MANUAL_REVIEW for spoken-output and physical-device gates. This is a review limitation; local discovered software defects still require fixes and retests.

Human retry on the final candidate: enable VoiceOver in a dedicated review session; navigate header/view/range controls, chart keyboard cursor/pin/clear, expanded legend summaries, Inspect dialog and accessible scrollable table. Confirm logical names/states, concise pin announcement, silent hover, missing/stale data never called healthy or zero, collapsed content excluded from navigation, Escape and focus return. Repeat with NVDA on Windows when available. On a physical iPhone Safari, check portrait/landscape browser chrome and safe areas, ordinary vertical scrolling, pinch/drag Inspect interactions, selection without accidental page locking, large text and VoiceOver table navigation. Record exact candidate SHA, OS/browser/device class and observed failures without personal identifiers.
