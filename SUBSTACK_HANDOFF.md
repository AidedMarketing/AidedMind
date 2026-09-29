# Substack sharing handoff

Updated September 29, 2026. Read current main, recent PRs, and deployment checks before treating this snapshot as live status.

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

- Preserve a fallback API's 429 and Retry-After when a direct publication page returns a different failure such as 404.
- An API retry no longer repeats the API if its one page fallback also fails. Missing APIs and empty post responses still allow a readable public page to complete the share.
- Regression coverage includes recovery to a completed note on the same inbox item, with no quota spent on failed reads.

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
