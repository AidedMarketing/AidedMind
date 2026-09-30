# AidedMind — Editorial Knowledge + Knowledge Fabric

AidedMind is a personal knowledge publication whose pages become a knowledge fabric. Prefer the quieter option while reading, the clearer option while navigating, and the more expressive option when showing connections.

## Foundation
v28 evolves the v27 shell. Library / Explore / More and global Add remain intact; saved pieces retain Breakdown / Links / Notes. Capture, source handling, automatic and manual connections, rejection memory, data architecture, exports and stable map neighborhoods remain the foundation.

## Typography
Newsreader variable serif is bundled locally at `web/fonts/Newsreader.ttf` (SIL OFL, included alongside it). Use it for publication titles, reading leads, headings, pull quotes and relationship titles. System UI sans serves navigation, metadata, controls and diagnostics. Reading sections target 72ch and generous line height.

## Surfaces and tokens
Runtime tokens live in `web/app.css`. Warm paper and warm charcoal are the daylight/night editions of the same publication. Lavender signals action and relationships. Semantic aliases include paper, paper-secondary, surface-muted, ink, text-secondary, rule, display-serif and ui-sans. Use the spacing scale from space-1 through space-16.
Prefer fine rules and whitespace to cards. Reserve containment for capture, sheets, recovery and map context.

## Relationship progression
Library offers a truthful count of extant note edges, including automatic links and backlinks. Reading UI stays quiet. Links uses cross-reference rules and equal treatment for automatic and manual origins. Explore expresses the fabric with stable neighborhoods. Source coloring never changes layout grouping.

## Mark
The imprint refines the existing central-node and four-outer-node geometry. SVG, favicon, PNG PWA icons and Apple touch icon share the mark. Loading resolves once without an endless loop.

## Accessibility and preferences
System appearance is the default; local light/dark override is optional. Larger reading text and reduced motion are local display preferences, outside knowledge data and exports. OS reduced motion always applies. Touch controls target at least 44px. Sheets trap focus, inert background content, close with Escape and restore the trigger. Saved-piece tabs support arrows, Home and End. Notes announce Saving…, Saved and storage errors without discarding entered text. Map keeps its synchronized textual equivalent.

## Quotes and recovery
Worth Quoting displays only literal strings present in captured source text, with a source passage control; saved quote data remains untouched. Quotes with normalized punctuation may be omitted until exact verification is possible. Recovery explains what the reader can do and retains technical errors under Advanced diagnostics.

## Validation
`npm test` runs worker, capture, graph, theme, connection and web tests. `npm --prefix worker run check` validates the deployment bundle.
The Editorial browser QA workflow runs Chromium and WebKit across 320px, 390px, tablet and desktop, both schemes, larger text and reduced motion. It exercises captures with mocked API responses, links and rejection persistence, autosave failure/recovery, sheets, exports, maps and offline assets. It runs axe WCAG checks and publishes screenshots plus a JSON report.
This automation does not replace physical iPhone Share Sheet, real publisher access, installed iOS PWA or VoiceOver testing.
