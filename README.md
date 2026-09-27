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

- **Nothing to babysit.** Cloudflare Workers don't sleep, the inbox and usage live in durable SQLite storage, and inbox items clean themselves up after 30 days.
- **Low server cost.** The Worker only moves data and waits on Claude. Article pages are cleaned up on the phone (Readability), which keeps each request well inside the free plan's CPU limit.
- **Your notes stay on your phone.** Each breakdown request carries a compact index of your library (titles, TL;DRs, concept names) so Claude can suggest connections; the server doesn't keep notes.

### Why a Shortcut?

iOS doesn't let home-screen web apps appear in the Share menu, and it keeps their storage separate from Safari. So the **Save to AidedMind** Shortcut posts the link to your inbox, and the app picks it up (and breaks it down) the next time you open it. Settings → *Save from the Share button* walks you through building it, with copy buttons for the URL and token.

## What each source gives you

| Source | What AidedMind reads |
|---|---|
| Articles / blogs | Main text via Mozilla Readability. Paywalled or JavaScript-only pages may fail; paste the text instead |
| YouTube (videos, Shorts) | Full caption transcript, title and channel. No captions? Paste a transcript |
| TikTok | Caption, description and author only, **not the spoken audio**. Notes are marked partial |
| Anything else | Paste the text |

## One-time setup (about 15 minutes)

After this, deploys, dependency updates and monitoring run by themselves.

1. **Cloudflare:** create a free account → *Workers & Pages* → *Create* → *Import a repository* → pick `AidedMarketing/AidedMind`.
   - Root directory: `worker`
   - Build command: *(leave empty)* · Deploy command: `npx wrangler deploy`
   - Every push to `main` now deploys automatically. The storage (Durable Object) is created on first deploy.
2. **Secrets:** in the Worker → *Settings* → *Variables and Secrets*, add:
   - `ANTHROPIC_API_KEY`: your Claude API key
   - `OWNER_TOKEN`: a long random string (your personal, unlimited access token). Generate one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
3. **Anthropic spend cap:** in the Anthropic Console → *Limits*, set a monthly spend limit so costs can never run away.
4. **GitHub (hands-off updates):**
   - *Settings → General*: turn on **Allow auto-merge**.
   - *Settings → Rules → Rulesets*: add a rule for `main` that **requires the `test` status check**. Dependabot's weekly minor/patch updates then merge themselves once CI passes, and Cloudflare deploys them. Major version bumps wait for you.
   - *Settings → Secrets and variables → Actions → Variables*: add `APP_URL` = your Worker URL (e.g. `https://aidedmind.<you>.workers.dev`). A daily health check then verifies the app, its storage and your Claude key, and **GitHub emails you if it fails**.
5. **iPhone:** open the Worker URL in Safari → Share → **Add to Home Screen**. Open it, go to Settings, paste your `OWNER_TOKEN`, tap **Save & Test**, then follow *Save from the Share button*.

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
| `AIDEDMIND_DEFAULT_DEPTH` | `wrangler.jsonc` vars | breakdown style when the app doesn't send one: `quick`, `balanced` (default) or `thorough` |
| `AIDEDMIND_MODEL_QUICK` / `_BALANCED` / `_THOROUGH` | `wrangler.jsonc` vars | defaults `claude-haiku-4-5` / `claude-sonnet-5` / `claude-opus-5-5` |
| `FREE_MONTHLY_CAPTURES` / `PRO_MONTHLY_CAPTURES` | `wrangler.jsonc` vars | default 25 / 400 |
| `APP_URL` | GitHub Actions variable | enables the daily health check |

**Breakdown styles** (Settings → Breakdown style, per device):

| Style | Model | Use it for |
|---|---|---|
| Quick | Claude Haiku 4.5, no extended thinking | TikToks, short posts; fastest and cheapest |
| Balanced (default) | Claude Sonnet 5, medium effort | most articles and videos |
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
  src/extract.js        link → source (article HTML / YouTube captions / TikTok caption)
  src/analyze.js        Claude call, JSON schema, normalization
  src/store-core.js     SQLite tables: users, inbox, usage
  src/store.js          Durable Object wrapper
web/
  index.html, app.css, manifest.webmanifest, service-worker.js, _headers
  js/app.js             views, routing, sheets, inbox sync, accounts
  js/readable.js        article HTML → clean text on the device
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
- Audio transcription for TikTok and caption-less videos
- PDFs and podcasts
- Optional encrypted sync between devices
- Spaced-repetition review of takeaways
