# AidedMind share and note behavior

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

## Rebuild authorization and scope (2026-09-30)

Source: owner accepted the completed audit and requested “go through with your findings and rebuild,” with robust accessibility and a side-menu reference. Existing account plans and monthly breakdown allowances remain unchanged.

- Retention: shared links are retained until imported or explicitly removed. At 200 entries, new shares receive a recoverable capacity error; repeats can reuse existing entries.
- Quota: exhausted background work stays queued until the next UTC month. Supporting source/connection requests also respect quota; each has a four-times-plan supporting-call budget, with at most three concurrent calls and twenty starts/minute per account. Unlimited plans have concurrency/rate bounds but no monthly supporting-call cap. Failed attempts count toward supporting-call budgets to bound provider spend.
- Restore: validate the complete supported backup before writes, preview additions, preserve existing IDs unchanged. A single transaction adds missing notes; restoring never deletes or overwrites local work. Unsupported/invalid files show failure and leave storage unchanged.
- Deletion: explicit app-owned confirmation names the note and irreversible local consequence; initial focus is Keep note. Trash/Undo is tracked separately and is not implied by this release.
- Sheets: named dialog, isolated background, focus confinement, Escape dismissal, scroll lock, return to opener. Accessibility controls use the same primitive.
- Preferences: local to this browser/device, persist immediately, reset explicitly. OS reduced motion is always honored. No claim of WCAG conformance is made without the broader device/assistive-technology matrix.
