# AidedMind
Tool for saving, summarizing, breaking down, and mapping anything you find online

Share a link from your iPhone — an article, a YouTube video, a TikTok — or paste any text, and AidedMind gives you:

- **In short**: a two or three sentence TL;DR
- **Summary**: section-by-section breakdown, takeaways and quotes worth keeping
- **Outline**: a three-level outline of the whole piece
- **Links**: connections to notes already in your library, each with a reason (supports / contradicts / extends / example-of), plus backlinks
- **Map**: an Obsidian-style graph. Notes are dots colored by source; ideas shared by two or more notes are diamonds. Tap anything to preview it.

Built for iPhone first (installable web app, A.M. family design: warm dark / warm light with lavender accents). Your notes live only on your device. Export them as a `.zip` of Markdown files with `[[wikilinks]]` for Obsidian, or as a JSON backup.

## How it works

```
iPhone                                 AidedMind server (Node)                 outside
┌─────────────────────────┐            ┌──────────────────────┐
│ Share → "Save to        │ POST inbox │ inbox (links only)   │
│ AidedMind" Shortcut     │ ─────────▶ │                      │
│                         │            │                      │
│ AidedMind app           │ capture    │ extract              │ ──▶ article / YouTube captions / TikTok caption
│  · library (IndexedDB)  │ ─────────▶ │ analyze              │ ──▶ Claude API (structured JSON)
│  · map, notes, export   │ ◀───────── │ (no notes stored)    │
└─────────────────────────┘            └──────────────────────┘
```

The server keeps your Anthropic API key off the phone and fetches pages the browser can't. Each capture request carries a compact index of your library (titles, TL;DRs, concept names) so Claude can suggest connections. The server does not keep your notes.

### Why a Shortcut?

iOS doesn't let home-screen web apps appear in the Share menu, and it keeps their storage separate from Safari. So the **Save to AidedMind** Shortcut posts the link to your server's inbox, and the app picks it up (and breaks it down) the next time you open it. Settings → *Save from the Share button* walks you through building it, with copy buttons for the URL and token.

## What each source gives you

| Source | What AidedMind reads |
|---|---|
| Articles / blogs | Main text via Mozilla Readability. Paywalled or JavaScript-only pages may fail; paste the text instead |
| YouTube (videos, Shorts) | Full caption transcript, title and channel. No captions? Paste a transcript |
| TikTok | Caption, description and author only, **not the spoken audio**. Notes are marked partial |
| Anything else | Paste the text |

## Deploy (Render)

`render.yaml` defines one web service that serves both the app and the API.

1. Render → New → Blueprint → pick this repo.
2. Set `ANTHROPIC_API_KEY`. `AIDEDMIND_ACCESS_TOKEN` is generated for you; copy it from the dashboard.
3. On your iPhone, open the service URL in Safari → Share → **Add to Home Screen**.
4. Open AidedMind from the home screen → Settings → paste the token → **Save & Test**.
5. Follow Settings → *Save from the Share button* to create the Shortcut.

**Inbox storage:** the inbox is a small JSON file (`AIDEDMIND_INBOX_PATH`). Render's free plan has an ephemeral disk that is wiped when the service restarts or sleeps, so links shared while you don't open the app for a while can be lost. For reliable sharing, use a paid instance with a persistent disk mounted at `/var/data` and set `AIDEDMIND_INBOX_PATH=/var/data/inbox.json`.

## Run locally

```bash
cp server/.env.example server/.env   # fill in ANTHROPIC_API_KEY and AIDEDMIND_ACCESS_TOKEN
npm install
node --env-file=server/.env server/index.js
# open http://localhost:8787 → Settings → paste the token
```

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | required |
| `AIDEDMIND_ACCESS_TOKEN` | none | required; shared secret sent as `X-AidedMind-Token` |
| `AIDEDMIND_MODEL` | `claude-opus-5` | any Claude model id |
| `AIDEDMIND_INBOX_PATH` | `server/data/inbox.json` | where Shortcut shares wait |
| `PORT` | `8787` | |

Analysis uses Claude structured outputs (the reply always matches the note schema) and Anthropic's server-side refusal fallback (`fallbacks: "default"`). Sources over ~600k characters are rejected rather than silently truncated.

## Security

- Server-side fetching only allows `http(s)` URLs that resolve to public addresses (loopback, private and link-local ranges blocked; each redirect re-checked), with a 5 MB / 15 s cap.
- `/api/*` is rate limited (20/min) and token protected (constant-time comparison).
- The UI builds every element with `textContent`; there is no `innerHTML`. The server sets a strict CSP (`script-src 'self'`).

## Development

```bash
npm test   # server unit + API tests, web graph / markdown / zip tests
```

No build step: `web/` is plain ES modules, `server/` is CommonJS Express.

```
server/
  index.js           Express: static app + /api (capture, inbox, auth-check, health)
  lib/extract.js     URL → text (article / YouTube / TikTok)
  lib/safe-fetch.js  SSRF-safe fetch
  lib/analyze.js     Claude call, JSON schema, normalization
  lib/inbox.js       Shortcut inbox (JSON file)
web/
  index.html, app.css, manifest.webmanifest, service-worker.js
  js/app.js          views, routing, sheets, inbox sync
  js/graph.js        canvas force-directed map (touch, pinch, label placement)
  js/icons.js        inline SVG icon set
  js/db.js           IndexedDB
  js/api.js          server client, settings
  js/markdown.js     Obsidian Markdown
  js/zip.js          zip builder for vault export
```

## Roadmap

- Audio transcription for TikTok and caption-less videos
- PDFs and podcasts
- Optional encrypted sync between devices
- Spaced-repetition review of takeaways
