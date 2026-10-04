# ERP-09 local text, contrast and safe-area acceptance

`e2e/post-release-text-contrast.spec.ts` adds local Chromium acceptance at widths
320, 390, 768, 1440 and 1920 CSS pixels. Text-only enlargement snapshots each
DOM element's computed font size and doubles it with an inline override while
CSS zoom remains 1. This includes pixel-sized labels; it is a test override,
not a claim that a browser root-font preference doubles every pixel-sized font.
Critical readings and controls remain inside the viewport without clipping;
the accessible table remains a named, keyboard-focusable scrolling region.

At 390 and 1440 pixels the test measures primary text, critical Normal/Current
status labels, and keyboard focus. It hides glyph paint while preserving element
geometry and foreground-dependent borders/backgrounds, screenshots the actual
background, decodes the PNG in browser canvas, and calculates WCAG sRGB contrast
against every background pixel. Ancestor opacity and foreground alpha contribute
to text compositing. Focus is verified as painted outline pixels against a second
capture with only the outline suppressed. Text requires 4.5:1; focus requires
3:1. Reduced motion stabilizes CSS transitions during this measurement.
This is bounded evidence for selected critical surfaces, not a whole-app audit.

Delayed and failed source fixtures retain explicit collection state, delayed data,
18-minute age, and source-observation text under monochrome styling. These states
remain distinguishable without hue. Existing 44-pixel controls, reduced-motion,
quiet hover, keyboard Inspect and zoom checks are retained.

Chromium's native safe-area environment reports zero insets; the viewport declares
`viewport-fit=cover`. The test reads shipped CSSOM expressions and preserves their
cascade while substituting explicit resolved values (top 24, sides 18, bottom 34
pixels). It checks shell padding, fixed navigation clearance, header position and
diagnostics. This is a resolved-expression stress test, not hardware notch
emulation or physical Safari validation. It caught later fixed padding rules
that overrode shell top and overview navigation insets. Enlarged text also exposed
active-range truncation at 320 and 768 pixels; the picker now reserves character
width for the range and allows its shell to wrap. The narrow CSS repair
uses `max(existing spacing, env(...))`, preserving all zero-inset spacing.

Measurements are written to `artifacts/post-release/ERP-09-rendered-contrast-*.json`
and `ERP-09-safe-area.json`; text-only screenshots and Playwright attachments
record layout. No screenshot baselines or tolerance changes are included.
Physical-device Safari, browser text preference modes, and manual assistive-reader
acceptance remain unperformed.
