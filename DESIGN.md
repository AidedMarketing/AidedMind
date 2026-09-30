# AidedMind — Editorial Knowledge + Knowledge Fabric

AidedMind is a personal knowledge publication whose pages become a knowledge fabric. Prefer the quieter option while reading, the clearer option while navigating, and the more expressive option when showing connections.

## Foundation
v30 keeps the v29 editorial shell coherent during updates while preserving the v27 product foundation. Library / Explore / More and global Add remain intact; saved pieces retain Breakdown / Links / Notes. Capture, source handling, automatic and manual connections, rejection memory, data architecture, exports and stable map neighborhoods remain the foundation.

## Typography
Newsreader variable serif is bundled locally at `web/fonts/Newsreader.ttf` (SIL OFL, included alongside it). Use it for publication titles, reading leads, headings, pull quotes and relationship titles. System UI sans serves navigation, metadata, controls and diagnostics. Reading sections target 72ch and generous line height.

## Surfaces and tokens
Runtime tokens live in `web/tokens.css`, the canonical palette and spacing owner. Components in `web/app.css` and the shared shell in `web/shell.css` consume these variables directly; this document mirrors the accepted values (runtime-owned mapping). Warm paper and warm charcoal are the daylight/night editions of the same publication. Lavender signals action and relationships. Semantic aliases include paper, paper-secondary, surface-muted, ink, text-secondary, rule, display-serif and ui-sans. Use the spacing scale from space-1 through space-16.
Prefer fine rules and whitespace to cards. Reserve containment for capture, sheets, recovery and map context.

| Semantic role | Light | Dark | Consumers |
| --- | --- | --- | --- |
| Paper / `--bg` | `#f7f4ef` | `#262429` | Page, navigation, map |
| Reading surface / `--surface` | `#fdfbf7` | `#302d33` | Writing, sheets, map list |
| Muted surface / `--surface-2` | `#efebe6` | `#38343d` | Search and secondary controls |
| Ink / `--text` | `#302c33` | `#f4f0e8` | Titles and reading |
| Secondary / `--text-2` | `#625c66` | `#cec7d1` | Metadata and navigation |
| Lavender / `--accent` | `#70538f` | `#c5b3e3` | Actions, focus, connections |
| Fine rule / `--line` | `#dcd5cd` | `#4b454f` | Separators |

## Shell ownership and responsive layout
`web/shell.css` exclusively owns fixed navigation, page measure, desktop rail, Explore toolbar/canvas and map list geometry. Do not append shell overrides in component CSS. At widths below 960px, exactly three links occupy the bottom bar. At 960px and above, those same links sit below a static publication imprint in the rail. Neither desktop nor header imprint is an actionable home link. Global Add is a labeled header action; the map toolbar does not duplicate it.
The header uses bounded grid columns, with no invisible title reserving space beside the imprint. Saved-piece titles center within remaining space. Reading content uses one `--content-width` per screen so desktop centering includes the rail correctly.
Explore uses three grid rows: editorial heading and controls, the canvas, then theme controls. Search fills the mobile control width; map actions use a second row below 600px. Labels and neighborhoods live entirely within the remaining canvas. The map list overlays only that canvas, retaining access to its close button and map controls. Changing shell geometry or theme hues never changes graph grouping, rejection memory, or physics.

## Relationship progression
Library offers a truthful count of extant note edges, including automatic links and backlinks. Reading UI stays quiet. Links uses cross-reference rules and equal treatment for automatic and manual origins. Explore expresses the fabric with stable neighborhoods. Source coloring never changes layout grouping.

## Mark
The imprint refines the existing central-node and four-outer-node geometry. SVG, favicon, PNG PWA icons and Apple touch icon share the mark. In-app marks use the original SVG as a mask tinted by the accent token, so dark mode has the same readable lavender signature. Loading resolves once without an endless loop.

## Updates and feedback
The active service worker serves HTML, CSS and JavaScript from its own named release cache. New HTML must not arrive ahead of the matching assets. Controller changes retain the existing safe reload/draft protection. Feedback sits below the header, and switching saved-piece tabs reveals the new panel's beginning without moving keyboard focus.

## Accessibility and preferences
System appearance is the default; local light/dark override is optional. Larger reading text and reduced motion are local display preferences, outside knowledge data and exports. OS reduced motion always applies. Touch controls target at least 44px. Sheets trap focus, inert background content, close with Escape and restore the trigger. Saved-piece tabs support arrows, Home and End. Notes announce Saving…, Saved and storage errors without discarding entered text. Map keeps its synchronized textual equivalent.

## Quotes and recovery
Worth Quoting displays only literal strings present in captured source text, with a source passage control; saved quote data remains untouched. Quotes with normalized punctuation may be omitted until exact verification is possible. Recovery explains what the reader can do and retains technical errors under Advanced diagnostics.

## Validation
`npm test` runs worker, capture, graph, theme, connection and web tests. `npm --prefix worker run check` validates the deployment bundle.
The Editorial browser QA workflow runs Chromium and WebKit across 320px, 390px, tablet, 959px/960px rail boundaries and desktop, both schemes, larger text and reduced motion. It exercises captures with mocked API responses, links and rejection persistence, autosave failure/recovery, sheets, exports, maps and offline assets. It checks exactly three navigation destinations, 44px targets, clipping/occlusion, header overlap, reachable navigation and reserved map canvas space, including a 320×568 viewport. It runs axe WCAG checks and publishes full-page and viewport screenshots plus a JSON report. Screenshots must also be visually inspected before a release; a green functional run alone does not establish layout quality.
This automation does not replace physical iPhone Share Sheet, real publisher access, installed iOS PWA or VoiceOver testing.
