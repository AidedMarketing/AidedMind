# v34 — Clearer topics and focused exploration

Explore opens with a topic overview. Open a topic to see its neighborhood or a piece to follow its strongest connections. Expand focused maps deliberately (16, 48, then 80 pieces). Very common concepts no longer pull the entire library into a local map. Canvas and text search now use the same matching pieces.

Topics and concepts receive canonical IDs. Narrow acronym aliases such as AI / Artificial Intelligence are normalized on-device without a new breakdown. Named topics retain singleton pieces, stable colors, and persisted homes independent of topic size. More → Appearance → Manage topics combines duplicate names and remembers aliases in JSON backups, with Undo during the session.

Full-text imports, screenshot augmentation and re-analysis share one update path. Manual links, rejections, personal notes, source attribution and manually chosen topics survive. Automatic outgoing links are refreshed; old automatic backlinks to changed source text are invalidated and queued for review. Stronger relationship labels require matching original passages from both pieces.

Failed linking no longer needs another content capture: its state persists, retries with bounded backoff, and offers Retry connections on the Links tab. More → Appearance → Review library connections applies current rules to older pieces after explaining model usage. This reviews links without regenerating summaries.

Existing content stays in IndexedDB. The additive knowledge migration and saved aliases travel with ordinary JSON backups. Layout preferences are disposable and separate from knowledge data. Service worker v34 caches the new knowledge module atomically with the rest of the release.
