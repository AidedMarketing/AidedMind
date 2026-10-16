# v34 verification

- Worker tests: 98 passed.
- Web tests: 52 passed, including ES module parsing, canonical aliases, source updates, graph focus budgets, stable anchors, and retries.
- Cloudflare deployment bundle: dry run passed.
- Local Chromium matrix: 121 checks passed across 320, 390, 768, 959, 960 and 1280 pixels; light/dark, larger text, reduced motion, keyboard, axe accessibility, source correction, re-analysis, connection retry, topic merge/undo, and offline publication assets.
- Follow-up 320px matrix covers settled neighborhood screenshots, merge storage failure/recovery, canonical acronym search, and pressed control states.
- GitHub's Editorial browser QA runs both Chromium and WebKit on the final PR revision. Local browser package downloads were unavailable, so local checks used a serverless Chromium binary; WebKit verification belongs to GitHub CI.

The full local matrix report is `chromium-matrix.json`. Accepted screenshots show the topic overview on a phone and a settled topic neighborhood. All data is synthetic. Source update failures retain the previous piece and pasted text. Topic merge failures remain in the app-owned sheet and can be retried; successful merges support Undo.

The stock premium static auditor timed out in its HTML/JSX lexer on the DOM-only JavaScript app. Contract, JavaScript-pattern and evidence checks passed with that inapplicable lexer skipped. Real browser checks cover semantics, focus, and geometry. DESIGN.md lint reports zero errors and the pre-existing absence-of-YAML warning; runtime tokens were not changed.

The metadata migration is additive and uses no model request. Existing automatic relationships are refreshed when source content changes or when the user explicitly requests a library connection review. Semantic truth of relationship labels remains a model judgment; literal evidence checks verify source attribution.
