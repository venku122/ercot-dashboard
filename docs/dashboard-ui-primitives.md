# Dashboard UI primitives

The UI is partially consolidated; feature-specific markup still exists outside Market. New expandable evidence panels should use the shared primitives rather than add another Load/Hide action or duplicate layout rules.

- `frontend/src/components/ui/disclosure-card.tsx`: full-width heading control, decorative chevron, expanded state, accessible content association, and card surface. Parents retain ownership of state and request gating; collapsing must not initiate requests.
- `frontend/src/components/ui/button.tsx`, `variant="segmented"`: padded, 44px-minimum layer controls with `aria-pressed`. Wrap related controls in `.ui-segmented-control` with an accessible group name.
- `.ui-data-table`: shared table cell spacing, separators, alignment, and a contained horizontal scroller. Keep product-specific minimum table widths in the feature stylesheet.
- `frontend/src/components/ui/dashboard.css`: shared spacing tokens and component styles. Change common spacing here rather than adding feature overrides.

Market Geography and Market Mechanics use these shared surfaces. Other evidence panels and the older Card component have not yet been migrated. Chart cards retain their specialized chart/inspect layout.

Verification must include expanded/collapsed keyboard operation, no requests while collapsed, 44px controls, contained mobile overflow, and populated desktop/mobile screenshots.
