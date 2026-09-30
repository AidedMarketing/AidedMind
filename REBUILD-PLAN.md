# AidedMind rebuild — 2026-09-30

Owner-authorized follow-up to the full audit. Preserve the calm mobile reading experience and Substack app sharing as the primary capture path. Safari capture remains optional recovery.

## Release 26 — implemented, verification in progress

- F1: retain uncollected inbox work; return capacity error instead of silent eviction/expiry.
- F2: strict backup envelope/note validation, additive restore preview, transaction-safe preservation of existing notes, immediate Settings refresh and preference sync. Existing corrupted dates no longer crash sorting.
- F3: direct text shares recognize complete duplicates; canonical queued identity now covers all supported links; repeated identical text reuses its receipt. Safari text can upgrade processing shares; revision checks stop stale processing overwrites.
- F4: direct capture honors explicit publisher restriction metadata.
- F5: quota exhaustion retains queued items until next month.
- F6: Obsidian connections use collision-resolved export filenames.
- F7: block mapped IPv6 private addresses and validate every redirect before fetching, with bounded hops/time.
- F8: supporting paid APIs get per-account quota, monthly request, rate and concurrency protection with expiring leases.
- F9: Gemini analysis tokens included in ledger totals.
- F10: refresh vulnerable development dependencies within existing version range.
- F11–13: accessible shared sheets, app-owned delete confirmation, accessible Map list, improved secondary-text contrast.
- F14: blank full-text submit disabled; restore refreshes the current screen.
- Accessibility: side Aa button and Settings entry; persistent 100–200% text, high contrast, system reading font, reading spacing, link underlining, reduced motion, reset. No desktop cursor option or whole-page color filters.

## Next reliability work

1. Durable library backup/sync and recovery UI: local browser storage remains the main note store. Exports remain important. No silent claim that inbox retention is a cloud backup.
2. Cross-device duplicate ledger and receipt/status lookup after lost responses: current completed-library fingerprints are a capped device snapshot. This release closes same-inbox races, not that architectural limitation.
3. DNS-resolution/rebinding defense: literal addresses and redirect targets are checked; hostname resolution still relies on platform egress protections.
4. Trash with Undo and retention policy, conflict-aware personal-note autosave, recoverable Add drafts, last-backup reminders, explicit partial badges in Library.
5. Guided Shortcut installation and result/status recovery. Requires real iPhone testing and a distributable Apple Shortcut; no simulated installer.

## Accessibility follow-up

Priority is operable core controls, readable text and content access. Validate iPhone Safari/PWA, VoiceOver, Dynamic Type/zoom, switch control, virtual keyboard, light/dark and narrow 200% layouts. Review Map relationship descriptions and list filtering parity. Optional later reading tools: read aloud, focus reading mode, adjustable measure. Avoid claiming a preference panel alone makes the app accessible.

## Release gates and rollback

Run npm test, npm audit, Wrangler bundle check, strict design static audit, browser test of changed controls and restore. Tests use synthetic notes and provider stubs. No destructive testing on real notes. Ship through PR/CI. Roll back code by reverting the release commit; preserve additive DB columns and retained inbox items. Do not restore old eviction behavior as a data migration.

## Candidate additions after reliability

Unread/archive/favorites, source-linked highlights, encrypted backup/sync, stronger full-text search/PDF capture, native share extension. Prioritize based on real usage; none are promised as part of release 26.
