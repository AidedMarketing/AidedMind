# AidedMind
Tool for saving, summarizing, breaking down, and mapping anything you find online

Share a link from your iPhone (an article, a YouTube video, a TikTok) or paste any text, and AidedMind gives you:

- **In short**: a two or three sentence TL;DR
- **Summary**: section-by-section breakdown, takeaways and quotes worth keeping
- **Outline**: a three-level outline of the whole piece
- **Links**: connections to notes already in your library, each with a reason (supports / contradicts / extends / example-of), plus backlinks
- **Map**: an Obsidian-style graph. Notes are dots colored by source; ideas shared by two or more notes are diamonds. Tap anything to preview it.

Built for iPhone first (installable web app, A.M. family design: warm dark / warm light with lavender accents), running hands-off on Cloudflare's free plan. Your notes live only on your device. Export them as a `.zip` of Markdown files with `[[wikilinks]]` for Obsidian, or as a JSON backup.

## How it works

```
iPhone                                   Cloudflare (free plan)                   outside
┌───────────────────────────┐            ┌─────────────────────────────┐
│ Share → "Save to          │ POST inbox │ Worker  /api/*              │
│ AidedMind" Shortcut       │ ─────────▶ │  · auth + monthly quotas    │
│                           │            │  · inbox, usage (SQLite     │
│ AidedMind app             │ /source    │    Durable Objects)         │ ──▶ article page / YouTube captions / TikTok caption
│  · cleans articles        │ /analyze   │  · Claude call              │ ──▶ Claude API (structured JSON)
│  · library (IndexedDB)    │ ─────────▶ │ Static assets  web/         │
│  · map, notes, export     │ ◀───────── │                             │
└───────────────────────────┘            └─────────────────────────────┘
```

- **Updates itself.** A new version downloads in the background when you open the app and reloads it on its own (or offers a *Reload* button if you're in the middle of something). Settings shows the version you're running.
- **Nothing to babysit.** Cloudflare Workers don't sleep, the inbox and usage live in durable SQLite storage, and inbox items clean themselves up after 30 days.
- **Low server cost.** The Worker only moves data and waits on Claude. Article pages are cleaned up on the phone (Readability), which keeps each request well inside the free plan's CPU limit.
- **Your notes stay on your phone.** Each breakdown request carries a compact index of your library (titles, TL;DRs, concept names) so Claude can suggest connections; the server doesn't keep notes.
- **Cost stays flat as the library grows.** Up to 20 notes the whole index is sent. Past that, the phone picks the 20 notes most related to the new source (shared concepts, tags and title words, rarer words counting more) and adds a list of your most-used concept names so the map keeps linking up. A breakdown costs about the same with 50 notes or 5,000.
- **No paying twice.** A link that's already in your library (including short links, `youtu.be` vs `youtube.com`, and links with tracking parameters) opens the existing note instead of being broken down again. Use ••• → *Re-analyze* to redo one on purpose.

### Why a Shortcut?

iOS doesn't let home-screen web apps appear in the Share menu, and it keeps their storage separate from Safari. So the **Save to AidedMind** Shortcut posts the link to your inbox, and the app picks it up (and breaks it down) the next time you open it. Settings → *Save from the Share button* walks you through building it, with copy buttons for the URL and token.

## What each source gives you

| Source | How AidedMind reads it (in order, cheapest first) |
|---|---|
| Articles / blogs | Main text via Mozilla Readability on the phone; Substack posts fall back to Substack's post API. Paywalled or login-only pages: paste the text |
| YouTube | 1. the video's own captions (free) → 2. **Gemini** watches the video, captions or not (needs `GEMINI_API_KEY`) → 3. Supadata captions-only (needs `SUPADATA_API_KEY`) → 4. title + description + chapters, marked partial |
| TikTok | 1. **Supadata** transcribes what's said (needs `SUPADATA_API_KEY`) → 2. caption and description only, marked partial |
| Photos | **Add photos** on the Add tab (camera or library, up to 8 per note): screenshots, book pages, slides, whiteboards, handwritten notes, charts. Claude reads the text, explains visuals and breaks it down in one request |
| Anything else | Paste the text |

Photos are resized on the phone to 1,568 px on the long edge (the most detail Claude uses) and sent as JPEG, roughly 1,600 tokens each (about $0.003 per photo on Sonnet 5). Only small thumbnails and the text Claude read are kept with the note; the photos themselves are never stored. Auto uses Balanced for photos and Thorough for 6 or more.

Transcripts are cached for 30 days, so a retried or re-analyzed link never pays for transcription twice. Each note says where its transcript came from (bottom of its Notes tab).

**Costs:** Gemini's YouTube-link input is free during Google's preview; afterwards it costs a few cents per video. Supadata's free tier is 100 credits a month (a transcribed TikTok is about 2 credits per minute). Settings → *This month* shows breakdowns, estimated Claude spend, Gemini videos and Supadata transcripts; the exact Claude bill is in the Anthropic Console.

## One-time setup (about 15 minutes)

After this, deploys, dependency updates and monitoring run by themselves.

1. **Cloudflare:** create a free account → *Workers & Pages* → *Create* → *Import a repository* → pick `AidedMarketing/AidedMind`.
   - Root directory: `worker`
   - Build command: *(leave empty)* · Deploy command: `npx wrangler deploy`
   - Every push to `main` now deploys automatically. The storage (Durable Object) is created on first deploy.
2. **Secrets:** in the Worker → *Settings* → *Variables and Secrets*, add:
   - `ANTHROPIC_API_KEY`: your Claude API key
   - `OWNER_TOKEN`: a long random string (your personal, unlimited access token). Generate one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
3. **Optional video transcripts** (same place, as secrets):
   - `GEMINI_API_KEY`: from aistudio.google.com → *Get API key*. Transcribes YouTube videos, including ones without captions.
   - `SUPADATA_API_KEY`: from supadata.ai (free plan). Transcribes what's said in TikToks.
   - Each one switches on when its key is present; `/api/health` lists them under `services`, and `/api/health?deep=1` also tests each key and lists any that fail under `serviceProblems` (e.g. `api_key_rejected`, `out_of_credits`).
   - When a transcript service fails, the note is marked partial and says why. Sharing the same link again retries it and updates that note in place.
4. **Anthropic spend cap:** in the Anthropic Console → *Limits*, set a monthly spend limit so costs can never run away.
5. **GitHub (hands-off updates):**
   - *Settings → General*: turn on **Allow auto-merge**.
   - *Settings → Rules → Rulesets*: add a rule for `main` that **requires the `test` status check**. Dependabot's weekly minor/patch updates then merge themselves once CI passes, and Cloudflare deploys them. Major version bumps wait for you.
   - *Settings → Secrets and variables → Actions → Variables*: add `APP_URL` = your Worker URL (e.g. `https://aidedmind.<you>.workers.dev`). A daily health check then verifies the app, its storage, your Claude key and your Gemini and Supadata keys, and **GitHub emails you if any of them fails**. If you don't use a transcript service, add `EXPECT_SERVICES` listing the ones you do (e.g. `gemini`), or `none`.
6. **iPhone:** open the Worker URL in Safari → Share → **Add to Home Screen**. Open it, go to Settings, paste your `OWNER_TOKEN`, tap **Save & Test**, then follow *Save from the Share button*.

## Accounts and the path to paid

The server already has everything a paid version needs except the payment step:

- **Accounts:** each person gets their own access token, inbox and usage record. As the owner you see an **Accounts** section in Settings: add an account (their token is shown once) and see how many breakdowns each account used this month.
- **Plans and quotas:** `free` (25 breakdowns/month), `pro` (400), `unlimited`, and your `owner` token. Limits are set in `worker/wrangler.jsonc` (`FREE_MONTHLY_CAPTURES`, `PRO_MONTHLY_CAPTURES`). A failed breakdown doesn't count against the quota.
- **Owner API:** `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id` (`{ "plan": "pro" }` or `{ "status": "paused" }`).
- **Token usage per account per month** is recorded, so pricing can be set from real cost data.

Next step when you're ready: a Stripe Checkout + webhook that creates an account (or upgrades its plan) when someone pays.

## Local development

```bash
npm install                                    # installs worker dependencies
cp worker/.dev.vars.example worker/.dev.vars   # fill in ANTHROPIC_API_KEY and OWNER_TOKEN
npm run dev                                    # http://localhost:8787 (Cloudflare's runtime, local storage)
npm test                                       # Worker + web tests (Node 22.5+)
npm run check                                  # bundle exactly what Cloudflare will deploy
```

## Configuration

| Name | Where | |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | required |
| `OWNER_TOKEN` | secret | required; your unlimited access token |
| `AIDEDMIND_DEFAULT_DEPTH` | `wrangler.jsonc` vars | breakdown style when the app doesn't send one: `auto` (default), `quick`, `balanced` or `thorough` |
| `AIDEDMIND_MODEL_QUICK` / `_BALANCED` / `_THOROUGH` | `wrangler.jsonc` vars | defaults `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5-5` |
| `FREE_MONTHLY_CAPTURES` / `PRO_MONTHLY_CAPTURES` | `wrangler.jsonc` vars | default 25 / 400 |
| `GEMINI_API_KEY` | secret, optional | YouTube transcripts via Gemini |
| `GEMINI_MODEL` | `wrangler.jsonc` vars | default `gemini-flash-latest` (Google's current Flash model) |
| `SUPADATA_API_KEY` | secret, optional | TikTok (and fallback YouTube caption) transcripts |
| `APP_URL` | GitHub Actions variable | enables the daily health check |

**Breakdown styles** (Settings → Breakdown style, per device):

| Style | Model | Use it for |
|---|---|---|
| Auto (default) | picks per link: Quick under ~600 words or TikTok captions, Thorough from ~12,000 words, otherwise Balanced | everything; no extra call or cost |
| Quick | Claude Haiku 4.5, no extended thinking | TikToks, short posts; fastest and cheapest |
| Balanced | Claude Sonnet 5, medium effort | most articles and videos |
| Thorough | Claude Opus 5.5, medium effort | long or dense pieces; also available per note via ••• → *Re-analyze in depth* |

Summaries and outlines are kept short for skimming; quotes and takeaways get the most attention. Analysis uses Claude structured outputs (the reply always matches the note schema); Thorough also uses Anthropic's server-side refusal fallback (`fallbacks: "default"`). Sources over ~600k characters are rejected rather than silently truncated.

## Security

- The server only fetches public `http(s)` links (localhost, private and link-local addresses are refused), with a 3 MB / 15 s cap.
- Every `/api` call except `/api/health` needs an access token; tokens are stored only as SHA-256 hashes and compared in constant time.
- The app builds every element with `textContent` (no `innerHTML`), and the site sends a strict Content-Security-Policy (`web/_headers`).

## Project layout

```
worker/
  wrangler.jsonc        Cloudflare config: static assets, Durable Object, vars
  src/app.js            API routes: auth, quotas, source, analyze, inbox, admin
  src/extract.js        link → source (article HTML / YouTube / TikTok), fallback order
  src/transcripts.js    Gemini, Supadata and YouTube description fallbacks
  src/costs.js          monthly spend estimate from the cost ledger
  src/analyze.js        Claude call, JSON schema, normalization
  src/store-core.js     SQLite tables: users, inbox, usage, transcript cache, cost ledger
  src/store.js          Durable Object wrapper
web/
  index.html, app.css, manifest.webmanifest, service-worker.js, _headers
  js/app.js             views, routing, sheets, inbox sync, accounts
  js/readable.js        article HTML → clean text on the device
  js/photos.js          photo resize and thumbnails on the device
  js/library.js         related-note picking, concept list, duplicate links
  js/graph.js           canvas map (touch, pinch, label placement)
  js/api.js, db.js, markdown.js, zip.js, icons.js
  vendor/Readability.js Mozilla Readability (Apache-2.0)
.github/
  workflows/ci.yml                  tests + bundle check
  workflows/health.yml              daily live check, emails you on failure
  workflows/dependabot-automerge.yml
  dependabot.yml
```

## Roadmap

- Stripe checkout for paid plans
- PDFs and podcasts
- Optional encrypted sync between devices
- Spaced-repetition review of takeaways
