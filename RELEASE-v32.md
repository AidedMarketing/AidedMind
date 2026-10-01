# AidedMind v32 — Safari launch repair

Cloudflare redirects /index.html to /. The cached final response retains its redirect history, which Safari can reject when the service worker returns it for navigation. Reconstruct redirected navigation responses with the same body, status and headers, removing redirect history. Cached release coherence and offline reading remain intact.

App and service-worker versions advance together to 32. No IndexedDB, local settings, capture API or knowledge graph changes. Do not clear website data to recover: it contains saved pieces.

Regression coverage includes redirected cached HTML and network fallback. The browser fixture now reproduces the Cloudflare canonical redirect, with WebKit checking controlled reload, fresh-tab reopening and offline navigation.
