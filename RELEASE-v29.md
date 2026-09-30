# AidedMind v29 — shell repair

Repair v28's visible navigation regressions without changing the v27 knowledge foundation.

- Remove duplicate AidedMind home links. Branding is a static imprint outside the three-link navigation.
- Give mobile bottom navigation and the desktop rail one shared layout owner. Bound header columns and center reading content within the space beside the rail.
- Place Explore heading, search and actions above a dedicated canvas. Place theme controls below it; keep the accessible map list inside it. Global Add remains in the header.
- Extract the palette and spacing into `web/tokens.css`. Restore cleaner warm paper, warm graphite and restrained lavender; distinguish the two previously similar ochre theme colors without changing theme IDs or map grouping.
- Cache the new token and shell styles atomically under `aidedmind-v29`.
- Strengthen browser QA with navigation count, viewport clipping, hit-testing, header overlap, usable canvas space, full-width mobile search and 959px/960px breakpoint coverage.

Validation results and visual evidence are recorded in the implementation PR. The local in-app browser was unavailable because its administrator policy check could not be verified; QA uses the existing repository-owned Chromium/WebKit workflow and fresh screenshot artifacts. Physical iPhone sharing, installed PWA behavior and VoiceOver require device checks.
