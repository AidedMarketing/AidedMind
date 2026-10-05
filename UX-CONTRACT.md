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

Every saved piece offers **Import full text** in its action menu and Notes tab, regardless of automatic completeness detection. The shared sheet replaces captured text and rebuilds the same piece after a successful analysis and local save. Identity, date, personal notes, existing links, rejected links, photos, manually chosen topic and source attribution survive. Failure retains the previous piece and pasted text; closing and reopening retains the draft for this app session. The sheet states that updating uses one breakdown.
