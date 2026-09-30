# Substack sharing handoff

Updated September 29, 2026. Read current main, recent PRs, and deployment checks before treating this snapshot as live status.

## September 30 duplicate follow-up

- PR #27 deployed successfully; it deduplicates waiting URL-only shares and reports captured word counts. It did not cover completed notes or text captures.
- User confirmed Safari capture worked, but it created a second breakdown of the Matt Paige article. Screenshots also show a network-loss notification; that notification alone cannot establish whether the server accepted a request.
- Substack post identity now maps app `/pub/<publication>/p/<slug>` and publication `/p/<slug>` URLs to the same key, ignoring referral/query parameters on these known routes. Other sites retain meaningful query parameters.
- Full saved library fingerprints now skip text captures too. Full completed inbox results also prevent duplicate analysis before the app collects and syncs them. Partial results remain eligible for full-text upgrades.
- App shell and service-worker cache now use version 24, since browser duplicate matching also changed. Existing duplicate notes are not automatically deleted.
- The Library timestamp is assigned when a note is imported into the app; it does not prove when background processing succeeded. The reason an earlier failed share later appeared remains unverified without per-item history.

## Product intent

Adrian wants the Substack app's Share button → Save to AidedMind Shortcut to remain the primary path. Keep the frontend simple and put recovery logic on the backend. Safari capture is an optional recovery path, not a prerequisite for every share.

## Current baseline

- Main at the start of this work: `c10fe87` (PR #25). PR #24 improved Substack recovery; PR #23 shortened automatic throttling retries. Installed app shell version: 23. Backend-only fixes do not require a shell version bump.
- App links normally provide a URL, not subscriber article text or the user's login session. Public article fetching can work from these links; paid content still needs text the user supplies.
- `open.substack.com/pub/<publication>/p/<slug>` maps directly to the publication API/page. Direct publication links are supported too.
- First attempt can try both public routes; later attempts alternate API and page. An API returning 429 stops that attempt; a missing API or empty post can fall back to the page once. Respect Retry-After; stop after four throttled attempts (roughly 14 minutes without a longer publisher-requested delay).
- Keep the saved item available for Add text / Try again. Safari text for a matching waiting Substack post attaches to the same item; short captures require review.
- Try again resets attempts and refetches. It cannot guarantee that Substack has lifted a server-side limit.

## This change

- Baseline now includes PR #26 (`7632696`), which preserves fallback API rate limits and avoids repeating a failed API route.
- Repeated URL-only Substack shares match the same pending, processing, or failed item across app and publication URLs. They preserve attempts and Retry-After deadlines; Try again remains the explicit reset action.
- The Shortcut plain-text confirmation now distinguishes received article text (actual word count) from a URL-only share, an empty Safari capture, and a repeated link.
- Safari text recovery still completes the same waiting item without an upstream fetch. Existing duplicate rows are not deleted, and custom-domain aliases are not inferred.
- September 29 late-evening screenshot showed mattpaige68.substack.com throttling after both app and Safari shares. Exact post URL and the user's Shortcut configuration are still needed to diagnose that capture path; do not claim this change lifts the publisher's rate limit.

## Verification and remaining checks

- Run `npm test` and `npm run check`; API tests need permission to bind a localhost mock server.
- Check PR CI and Cloudflare deployment separately. A merged PR does not by itself prove a successful deployment.
- Live iPhone QA remains: a new free Substack app share, Try again on an older failed item, and optional Safari/Add text recovery without a duplicate breakdown.
- User's previously failing example: `https://khushivadadoriya.substack.com/p/the-eileen-guv-mindset?r=5m68f1&utm_medium=ios`.
- A newer shared article previously succeeded while retrying an older item still produced a limit message. That does not establish a cached failure; inspect the current fetch path and live responses before choosing a fix.
- Do not rotate identities, add proxy loops, bypass access controls, or make repeated live requests to force a throttled publication to respond.

## Relevant code

- `worker/src/extract.js`: public routes and upstream errors.
- `worker/src/inbox-processor.js`: retry timing, limits, quota refunds, article extraction.
- `worker/src/store-core.js`: matching waiting shares, text recovery, retry reset.
- `worker/test/lib.test.js` and `worker/test/inbox.test.js`: route and queue regressions.
- `web/js/app.js`: installed version and Shortcut instructions; `web/service-worker.js`: matching cache version.
