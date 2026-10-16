# AidedMind share and note behavior

## Canonical UI map

The original implementation brief and current user feedback own the navigation and visual requirements. Domain behavior remains defined by worker routes, storage and existing capture/connection tests.

| Capability | Canonical owner | Variants | Verification |
| --- | --- | --- | --- |
| Navigation and page layout | `web/index.html`, `setNav`, `web/shell.css` | Three-link mobile bar / desktop rail; static branding | Browser geometry, pointer navigation, keyboard |
| Tokens and theme | `web/tokens.css`, `applyDisplay` | System / light / dark | Token contrast, appearance browser checks |
| Tabs / display choices | Existing `segmentedControl` and saved-piece tablist | Radiogroup / Breakdown–Links–Notes | Keyboard and browser tests |
| Forms | Existing capture and manual-link controls | Capture / search / notes autosave | Success, failure and persistence browser checks |
| Sheets | `openSheet` / `closeSheet` | Existing capture, connections, source passage | Focus trap, inert background, Escape and restoration |
| Scrollbar | Global baseline in `web/app.css` | Document / canvas list | Theme contrast and browser inspection |
| Status feedback | Shared `toast`, notes save status | Transient feedback / persistent inline error | Live region and save-state checks |
| Explore controls | `graphView`, `web/shell.css` | Full fabric / focused neighborhood | Theme zoom, Fit All, synchronized accessible list |

Brand imprints have no href, click handler or tabindex. Only Library, Explore and More are primary destinations. Add stays a global header action. Explore controls must never obscure canvas labels; list overlays remain within the canvas. Scrolling and viewport resizing must not hide navigation targets. Feedback cannot cover the header. Tab changes reveal the new panel heading without moving focus. The service worker serves document and assets from the same named release cache during online and offline navigation, including share URLs.

The Share Sheet action saves first. A successful Shortcut response means the server stored the item, not that the breakdown is complete. A failed HTTP request must never display a saved confirmation. The one Shortcut has a Safari page branch that can include visible text and a link branch for other apps.

## Shared links

- A pending or processing item stays in Library → Shared links with its article link. A scheduled retry shows its next approximate time.
- A short Safari capture waits for **Check text** before analysis. The preview offers **Use this text**, **Add more text**, and **Later**; review does not use a breakdown or quota.
- A link that cannot be read offers **Open article** and **Add text** on the same item. Temporary site limits show the next retry time and allow Add text immediately; exhausted retries offer **Try again**. Substack app shares use both public routes once, then alternate one route per retry and honor a longer `Retry-After` time. They stop after four attempts, roughly 14 minutes when the publisher does not specify a longer wait.
- Sharing the same Substack post from readable Safari attaches its captured text to a waiting Substack app share, preserving the item and avoiding another fetch. Short or access-message captures still wait for review.
- A completed item imports into the local Library without duplicating a saved link. Personal notes and place in the Library survive updates to a partial note.

## Notes

- The note identifies partial content and displays captured word count when available. An image count is a prompt to inspect meaningful images, not a claim that every image matters.
- **Add screenshots** sends selected images with the saved article text, updates that note only after a successful breakdown, and keeps personal notes. Full images are not stored; small thumbnails and extracted text are retained.
- **Give me more detail** is offered for a complete note. It requests a new, fuller breakdown from the stored source and uses one additional breakdown.
- The model shown with a note is the model that generated its breakdown. Gemini is used only if Claude is temporarily unavailable or lacks a key and a Gemini key is configured; a failed backup leaves a shared item available for retry.

## Feedback and recovery

Use short, literal status text in grouped rows. Success feedback can disappear; failure and required action remain on the item. Keep the same operation names in Settings, Shared links, and note menus. Use semantic buttons and links, visible focus, and the existing app sheet and toast primitives.

Connection setup belongs first in Capture & Sharing. Shortcut copy controls require a token and a valid receiving server; GitHub Pages cannot receive captures. Owner account creation uses the shared focus-managed sheet, preserves its name on failure, and announces progress/errors.

## Full-text corrections

Every saved piece offers **Import full text** in its action menu and Notes tab, regardless of automatic completeness detection. The shared sheet replaces captured text and rebuilds the same piece after a successful analysis and local save. Identity, date, personal notes, manual links, rejected links, photos, manually chosen topic and source attribution survive. Automatic outgoing links are refreshed from the successful analysis; old automatic explanations are replaced. When source text changes, obsolete automatic backlinks are invalidated and independently queued for review. Failure retains the previous piece and pasted text; closing and reopening retains the draft for this app session. The sheet states that updating uses one breakdown.

## Knowledge processing and exploration, v34

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | `h`, shared fields and `openSheet` in `web/js/app.js` | This contract | Capture, topic merge, full-text update | Browser success, failure, keyboard |
| Scrollbar | `web/app.css` and geometry in `web/shell.css` | `DESIGN.md` | Document, sheet list, topic overview | Browser overflow and geometry |
| Toast | `toast` in `web/js/app.js` | This contract | Saved acknowledgement, retry feedback | Browser status |
| CRUD | `finishNote`, `mergeTopics`, `preserveUpdatedNote`, IndexedDB transactions | This contract and `web/js/knowledge.js` | Source update, topic merge and Undo | Unit and browser persistence |

Existing notes receive deterministic knowledge metadata on load without another model call. Topic IDs and aliases travel in JSON backups. Built-in aliases cover narrowly equivalent acronyms; related concepts are not automatically merged. Explicit topic merges keep the chosen identity, record former labels as aliases, and protect the selection from re-analysis. Undo changes only topic metadata and never overwrites intervening source or personal-note edits.

All source replacement paths preserve manual links and rejection memory, refresh automatic outgoing links, and atomically save affected records. Relationship labels stronger than related require literal source passages on both sides; this verifies attribution, while semantic judgment still comes from the model. Missing or invalid evidence downgrades a claim to related.

Background captures always save even when linking fails. Persistent linking status retries independently with backoff, at most three attempts before the user retries. Source-version checks and a final rejection check prevent outdated responses from overriding a new source or recreating rejected pairs. A bulk review requires an app-owned confirmation explaining request count and model usage; existing links remain until each successful review.

Explore defaults to a collapsed topic overview, including singleton topics. Focus starts with one note-distance step and at most 16 pieces, expands to 48 and then 80, and reports omitted pieces. Concepts shared across the whole library, more than half of a library of at least 12 pieces, or more than 12 pieces never become visual hubs. Rejected pairs are excluded from a focused note's indirect neighborhood too. Source colors do not affect membership or coordinates. Map and list share the same query and visible-note dataset, including concepts and topic aliases. URL state retains focus, topic, expansion, query, and overview choice. Persistent display anchors do not move when topic rankings change. Reduced motion settles offscreen; text exploration remains available.

Background connection results and personal-note autosave patch the latest record within an IndexedDB transaction. Neither operation replaces unrelated fields from an earlier snapshot. Rejection memory is saved on both sides of a removed automatic link so either side can reject an in-flight suggestion.

## Topic care and connection review, v35

Rename changes every member's display name while retaining its topic ID, map identity and prior-name aliases. Split moves selected pieces to a distinct new name without inheriting the original topic's aliases; at least one piece must remain in the original topic. Name collisions include existing aliases and equivalent acronyms. Both actions protect manual topic choices on re-analysis. Merge retains its explicit confirmation. All topic actions use the shared sheet, preserve input on storage failure, and expose session Undo for the pieces changed by the latest action. Undo patches only matching topic metadata; it preserves newer content, connections and separate topic choices. Later captures that inherited a renamed/merged topic also receive its restored name/aliases, preventing an undone merge from silently reappearing. Later pieces in a split topic remain there.

Collection edits and review queue changes transform the latest IndexedDB records in a single transaction. A library review stores its identity and completion state with each piece, so JSON backups and reloads retain progress. More → Appearance shows complete, checking, queued and failed counts. Pause persists before acknowledging success; a request already in flight may finish, and no further paused pieces start. Resume continues remaining work. Failed means three attempts were exhausted; Retry failed resets only those pieces. Existing links remain until a successful check, including a valid empty result; manual links and rejected pairs remain protected. A stalled request aborts after 90 seconds; an incomplete response remains a retryable failure rather than an empty success. Background checks retain the review identity on failure and completion, and ignore responses from superseded review identities or source versions. Web Locks serialize connection requests across open tabs when supported. Closing the app interrupts active requests; the saved pending queue resumes when reopened. Review status updates preserve sheet focus and do not navigate the reader.
