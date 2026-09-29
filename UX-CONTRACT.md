# AidedMind share and note behavior

The Share Sheet action saves first. A successful Shortcut response means the server stored the item, not that the breakdown is complete. A failed HTTP request must never display a saved confirmation. The one Shortcut has a Safari page branch that can include visible text and a link branch for other apps.

## Shared links

- A pending or processing item stays in Library → Shared links with its article link. A scheduled retry shows its next approximate time.
- A short Safari capture waits for **Check text** before analysis. The preview offers **Use this text**, **Add more text**, and **Later**; review does not use a breakdown or quota.
- A link that cannot be read offers **Open article** and **Add text** on the same item. Temporary site limits show the next retry time and allow Add text immediately; exhausted retries offer **Try again**. Substack app shares stop their automatic attempts after roughly 14 minutes rather than waiting an hour.
- A completed item imports into the local Library without duplicating a saved link. Personal notes and place in the Library survive updates to a partial note.

## Notes

- The note identifies partial content and displays captured word count when available. An image count is a prompt to inspect meaningful images, not a claim that every image matters.
- **Add screenshots** sends selected images with the saved article text, updates that note only after a successful breakdown, and keeps personal notes. Full images are not stored; small thumbnails and extracted text are retained.
- **Give me more detail** is offered for a complete note. It requests a new, fuller breakdown from the stored source and uses one additional breakdown.
- The model shown with a note is the model that generated its breakdown. Gemini is used only if Claude is temporarily unavailable or lacks a key and a Gemini key is configured; a failed backup leaves a shared item available for retry.

## Feedback and recovery

Use short, literal status text in grouped rows. Success feedback can disappear; failure and required action remain on the item. Keep the same operation names in Settings, Shared links, and note menus. Use semantic buttons and links, visible focus, and the existing app sheet and toast primitives.
