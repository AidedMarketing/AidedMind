# AidedMind
Your personal knowledge publication. Your knowledge, connected quietly.

**v29 — Editorial Knowledge + Knowledge Fabric:** repaired mobile navigation, a static publication imprint, aligned Explore controls around a dedicated map canvas, and cleaner warm-paper/graphite editions with restrained lavender. Locally bundled Newsreader typography keeps the reading surface quiet. Mobile keeps Library / Explore / More with global Add; desktop expands the same system with a left rail. The underlying v27 capture, automatic linking and stable map neighborhoods remain intact. See [release notes](RELEASE-v29.md), [design system](DESIGN.md) and [screen review](docs/qa/v29/README.md).

Share a link from your iPhone (an article, a YouTube video, a TikTok), take a photo, or paste any text, and AidedMind gives you:

- **In short**: a two or three sentence TL;DR
- **Breakdown**: one fluid reading view with the section-by-section summary, takeaways, quotes worth keeping, and the source outline
- **Links**: strong connections to notes already in your library are added automatically, each with a reason (supports / contradicts / extends / example-of). You can add your own links or mark an automatic link as not related.
- **Map**: the payoff of those links: a knowledge graph that grows as you save, organized into stable **theme neighborhoods** so related notes stay together instead of drifting into one loose cloud. Ideas shared by two or more notes are diamonds. Tap a theme to zoom into its neighborhood, tap a point to preview it, or use the accessible list view.

Built for iPhone first (installable web app, A.M. family design: warm dark / warm light with lavender accents), running hands-off on Cloudflare's free plan. Your notes live only on your device. Export them as a `.zip` of Markdown files with `[[wikilinks]]` for Obsidian, or as a JSON backup.

**Contents:** [How it works](#how-it-works) · [Background breakdowns](#background-breakdowns) · [Sources](#what-each-source-gives-you) · [Paywalls](#paywalled-articles) · [Map and themes](#map-and-themes) · [Using the app](#using-the-app) · [Setup](#one-time-setup-about-15-minutes) · [Settings reference](#settings-reference) · [Troubleshooting](#troubleshooting) · [Accounts](#accounts-and-the-path-to-paid) · [Configuration](#configuration) · [API](#api-reference) · [Development](#local-development)

## How it works

```
iPhone                                   Cloudflare (free plan)                   outside
┌───────────────────────────┐            ┌─────────────────────────────┐
│ Share → "Save to          │ POST inbox │ Worker  /api/*              │
│ AidedMind" Shortcut       │ ─────────▶ │  · auth + monthly quotas    │
│                           │            │  · inbox, usage, transcript │
│ AidedMind app             │ /source    │    cache, cost ledger       │ ──▶ article page / YouTube / TikTok
│  · cleans articles        │ /analyze   │    (SQLite Durable Objects) │ ──▶ Gemini / Supadata transcripts
│  · library (IndexedDB)    │ ─────────▶ │  · Claude call              │ ──▶ Claude API (structured JSON)
│  · map, themes, export    │ ◀───────── │ Static assets  web/         │
└───────────────────────────┘            └─────────────────────────────┘
```

- **Nothing to babysit.** Cloudflare Workers don't sleep, the inbox and usage live in durable SQLite storage, and inbox items clean themselves up after 30 days.
- **Updates itself.** A new version downloads in the background when you open the app and reloads it on its own (or offers a *Reload* button if you're in the middle of something). Settings → *About* shows the version you're running.
- **Works while the app is closed.** A link you share is broken down on the server right away (Cloudflare's Durable Object alarms), retried if something hiccups, and waits as a finished note until you open the app, which collects it and automatically adds its strongest useful connections to your Map. See [Background breakdowns](#background-breakdowns).
- **Watches itself.** A daily GitHub check tests the live app, its storage and every API key, and emails you if anything fails.
- **Low server cost.** The Worker only moves data and waits on Claude. Article pages are cleaned up on the phone (Readability), which keeps each request well inside the free plan's CPU limit.
- **Your notes stay on your phone.** Each breakdown request carries a compact index of related notes (titles, TL;DRs, concept names) so AidedMind can create strong automatic connections; the server doesn't keep notes. Automatic links are confidence-filtered, capped at six per new piece, explain why they exist, and remember when you mark one as not related.
- **Cost stays flat as the library grows.** Up to 20 notes the whole index is sent. Past that, the phone picks the 20 notes most related to the new source (shared concepts, tags and title words, rarer words counting more) and adds a list of your most-used concept names so the map keeps linking up. A breakdown costs about the same with 50 notes or 5,000.
- **No paying twice.** A link that's already in your library (including short links, `youtu.be` vs `youtube.com`, and links with tracking parameters) opens the existing note instead of being broken down again. Transcripts are cached for 30 days, so a retried link never pays for transcription twice.

### Why a Shortcut?

iOS doesn't let home-screen web apps appear in the Share menu, and it keeps their storage separate from Safari. One **Save to AidedMind** Shortcut works from Substack and other apps by sending their link; from Safari it can also send text visible in your logged-in page. Settings → *Save from the Share button* walks you through both branches of the same Shortcut.

Use the Shortcut inbox URL shown in Settings (it ends in `?shortcut=1`). It replies in plain text: either the number of words received or a notice that only a link arrived. If a Safari share says no article text was received, check that the Safari branch runs the script and posts its JavaScript Result as the request body. Re-sharing the same waiting Substack link keeps its existing progress and retry deadline rather than adding another job. After upgrading, replace the URL in both Get Contents of URL actions. Safari captures under 200 words or with a likely access message wait in Shared links for **Check text**; choose **Use this text** or **Add more text** before spending a breakdown. Existing Shortcuts need the updated Safari script copied from Settings to send this capture signal.

### Background breakdowns

Sharing a link no longer waits for the app:

1. The Shortcut posts the link. The server queues it and answers "Saved" straight away.
2. A background run on your Cloudflare storage fetches the source (article, YouTube, TikTok), reads the article's text, and breaks it down with Claude. If Claude is unavailable, the link stays queued with automatic retries up to an hour apart. A blocked or unreadable article stays in *Shared links* as **Needs article text**; a broken link or monthly limit stops with a reason.
3. The finished note waits on the server (up to 30 days). When you open the app it's added to your library, the server copy is deleted, and a small call links it to related notes (the server doesn't have your library, so this step happens here).

What the server holds, and only briefly: queued links, any article text you supply for a waiting item, and finished notes until the app collects them. Waiting items expire after 30 days. It also keeps a small settings record synced by the app: your breakdown style, the topic and concept *names* in use (so new notes reuse them), and short fingerprints of the links you've already saved (so sharing a repeat costs nothing). Your library stays on your device.

The Library shows anything still in progress under *Shared links*. It never starts a second breakdown just because a queued item has been waiting for ten minutes.

## What each source gives you

| Source | How AidedMind reads it (in order, cheapest first) |
|---|---|
| Articles / blogs | Main text via Mozilla Readability on the phone (or, for links broken down while the app is closed, the server's own article reader); Substack posts fall back to Substack's post API. Paywalled pages: see [Paywalled articles](#paywalled-articles) |
| YouTube | 1. the video's own captions (free) → 2. **Gemini** watches the video, captions or not (needs `GEMINI_API_KEY`) → 3. Supadata captions-only (needs `SUPADATA_API_KEY`) → 4. title + description + chapters, marked partial |
| TikTok | 1. **Supadata** transcribes what's said (needs `SUPADATA_API_KEY`; short `vm.tiktok.com` links are resolved first) → 2. caption and description only, marked partial |
| Photos | **Add photos** on the Add tab (camera or library, up to 8 per note): screenshots, book pages, slides, whiteboards, handwritten notes, charts. Claude reads the text, explains visuals and breaks it down in one request |
| Anything else | Paste the text |

Photos are resized on the phone to 1,568 px on the long edge (the most detail Claude uses) and sent as JPEG, roughly 1,600 tokens each (about $0.003 per photo on Sonnet 5.5). Only small thumbnails and the text Claude read are kept with the note; the photos themselves are never stored. Auto uses Balanced for photos and Thorough for 6 or more.

For an article whose images contain information, open its note → ••• → **Add screenshots**. Choose up to eight images from Photos; AidedMind reads them alongside the captured article and updates the same note, keeping personal notes and its place in the Library. The page's images are not fetched automatically. A note shows its captured word count and, where detectable, a count of images that may need your attention.

### Paywalled articles

AidedMind's server isn't logged in as you, so on a paywalled site it only receives what the site shows everyone: the free opening. It can't use your subscription: your phone's Safari logins live in Safari, and neither the installed app nor the server can see them. What it does instead:

- **It says so.** A note whose article looks paywalled (the page says it, or the text is short and ends with "subscribe to continue") is marked *partial* with a Quick, cheap breakdown of the free part, instead of pretending it read everything.
- **The same Shortcut in Safari.** While logged in, Share → **Save to AidedMind** sends article text visible in *your* browser. If the same Substack post is waiting from an app share, that text completes the waiting item rather than creating a second breakdown. The Safari branch is optional if you normally read in publication apps.
- **Shares from publication apps.** They normally provide a link, not the subscriber text on screen. If the server cannot read it, the link remains under *Shared links* → **Add text** so you can complete that item later.
- **Paste the full text (works anywhere).** Open the partial note → ••• → **Paste the full article**. In Safari, choose Select All → Copy on the article, then paste. The note keeps its place and anything you wrote.

AidedMind doesn't try to get around paywalls (no crawler tricks, no archive sites): it only ever uses what you can see yourself.

**Partial notes.** When only a caption or description could be read, the note says so and why (for example "Supadata is out of credits"). Each note's Notes tab says where its transcript came from. To retry, open the note → ••• → **Get the full transcript**, or share the link again; either way the note is updated in place and keeps anything you wrote in it.

If Claude is temporarily unavailable and `GEMINI_API_KEY` is configured, AidedMind tries Gemini for the breakdown. The finished note shows the model used. If both services fail, shared links stay queued for retry. Settings → *This month* counts Gemini backup breakdowns separately; Gemini charges are not included in the Claude estimate. **Give me more detail** on a complete note requests a fuller breakdown from its saved source text; it uses one additional breakdown.

**Costs:** Gemini's YouTube-link input is free during Google's preview; afterwards it costs a few cents per video. Supadata's free tier is 100 credits a month (a transcribed TikTok is about 2 credits per minute). Settings → *This month* shows breakdowns, estimated Claude spend, Gemini videos and Supadata transcripts; the exact Claude bill is in the Anthropic Console.

## Map and themes

The Map tab shows every note as a dot. With **Color notes by: Theme** (the default), AidedMind groups your notes into topics and gives each one a color, a soft background area and a name, such as *Sleep · Health* or *Marketing · Growth*.

- **Main topics.** Every breakdown gives the note a **topic**: the one broad subject it's *about*, not what it mentions in passing. A note on journaling that mentions an AI app is about *Journaling*. Claude reuses your existing topic names, so notes on the same subject match up.
- **How themes are found (on your phone, no AI cost).** Sharing a topic counts most. Notes are also related when Claude linked them, when you `[[wikilinked]]` one from the other in your own notes, or when they share tags or concepts. Between notes with *different* topics, shared tags, concepts and Claude's links count much less, so a passing mention doesn't pull a note into the wrong group. Your own `[[wikilinks]]` always count in full. Rare tags and concepts count more than common ones, and ones on every note (or on most of a larger library) are ignored. A clustering method (Louvain community detection) then finds the groups of notes that are more connected to each other than to the rest.
- **Names and colors.** A theme is named after the topic most of its notes share, otherwise its most distinctive tags. Its color follows its main name, so themes keep their colors as the library grows. The same library always gives the same themes.
- **Fixing mistakes.** If a note lands in the wrong theme, open it → ••• → **Topic** and pick or type the right one; your choice sticks, even through a re-analysis. If two notes are linked but shouldn't be, open the note's **Links** tab and tap **×** on that link; a re-analysis won't bring it back.
- **Notes saved before topics existed** get theirs filled in automatically (on the owner account) or from Settings → *Map* → **Sort notes by topic**: one cheap call covers up to 150 notes (about a cent) and counts as one breakdown.
- **Unsorted.** Notes that don't share anything with the rest yet (like a single note on a new topic) stay grey until related notes arrive.
- **When they appear.** Themes need a few notes that share tags, ideas or links. They're most useful from about 15–20 notes.

On the map:

- **Tap a theme** in the row under the map to light up its notes; tap it again to list them. Tap empty space to clear.
- **Tap a dot** to preview a note, or a diamond to see every note that shares that idea.
- The **layers button** switches between coloring by theme and by source (article, YouTube, TikTok, photo, text). The **diamond button** shows or hides shared ideas (grey diamonds when coloring by theme). The **corners button** fits everything on screen.
- **Find on map** highlights notes by title.

Themes also show up elsewhere: as the topic filters in the Library, as each Library row's topic, as a chip under each note's TL;DR (tap it to see the whole theme), and in Obsidian exports (`theme:` in the frontmatter).

**How things are marked.** Sources (Article, YouTube, TikTok, Photos, Text) always use a colored dot or icon tile. Topics always use a colored **#**, e.g. `# Journaling`, in the Library, on notes and under the map. Plain tags are small grey chips on the note page. Settings → *Map* controls the coloring and how finely notes are grouped (*Broad*, *Balanced*, *Detailed*).

## Using the app

| To… | Do this |
|---|---|
| Save a link from any app | Share → **Save to AidedMind** (the Shortcut). It's saved right away; open the app to see its progress |
| Save a paywalled article | Share → **Save to AidedMind**. If the publication app only shares its link, open Library → *Shared links* → **Add text** if needed. In Safari while logged in, the same Shortcut can send the visible article text |
| Save a link or text in the app | **Add** tab → paste → **Break it down**. If Claude is unavailable, the item is saved in *Shared links* for a later breakdown |
| Save photos | **Add** tab → **Add photos** (camera or library, up to 8) |
| Collect finished notes now | **Library** → inbox button (top right). The app also checks whenever it opens and every 20 seconds while something is still being broken down |
| Retry a link that failed | **Library** → *Shared links* → **Try again** |
| Get a TikTok or video's full transcript later | Open the note → ••• → **Get the full transcript** |
| Redo a breakdown in more depth | Open the note → ••• → **Re-analyze in depth (Thorough)** |
| Link your own notes | In a note's **Notes** tab, write `[[Title of another note]]` |
| Remove a wrong link | Open the note → **Links** tab → **×** on the link |
| Move a note to the right theme | Open the note → ••• → **Topic** → pick or type its subject |
| Find something | **Library** → search (titles, topics, summaries, concepts, tags, your notes), or filter by source (top row, dots) or topic (second row, #). Tap a tag on a note to filter by it |
| Sort the Library | **Library** → sort button next to search: newest, oldest, title A–Z, by theme or by source |
| Explore topics | **Map** tab → tap a theme under the map |
| Take notes to Obsidian | Settings → **Export to Obsidian (.zip)** |
| Back up / move to a new phone | Settings → **Back up library**, then **Restore from backup** on the new phone |

## One-time setup (about 15 minutes)

After this, deploys, dependency updates and monitoring run by themselves.

1. **Cloudflare:** create a free account → *Workers & Pages* → *Create* → *Import a repository* → pick `AidedMarketing/AidedMind`.
   - Project name: `aidedmind` (it must match `name` in `worker/wrangler.jsonc`)
   - Root directory: `worker`
   - Build command: *(leave empty)* · Deploy command: `npx wrangler deploy`
   - Every push to `main` now deploys automatically. The storage (Durable Object) is created on first deploy.
   - *Settings → Domains*: make sure the `workers.dev` route is **enabled**.
   - *Settings → Builds → Previews Base*: turn **Builds for Preview branches** off. Preview builds aren't needed (GitHub's `test` check already confirms each change deploys) and Cloudflare's preview setup doesn't match this project's Worker name.
2. **Secrets:** in the Worker → *Settings* → *Variables and Secrets* → *Add*, set **Type: Secret** for each (not Text: deploys replace Text variables with the ones in the repo, so a key saved as Text disappears on the next update):
   - `ANTHROPIC_API_KEY`: your Claude API key
   - `OWNER_TOKEN`: a long random string (your personal, unlimited access token). Generate one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
3. **Optional video transcripts** (same place, also as **Secrets**):
   - `GEMINI_API_KEY`: from aistudio.google.com/apikey. Transcribes YouTube videos, including ones without captions.
   - `SUPADATA_API_KEY`: from supadata.ai (free plan). Transcribes what's said in TikToks.
   - Each one switches on when its key is present. Settings → *Server status* shows what's on, and *Run a full check* tests each key.
4. **Anthropic spend cap:** in the Anthropic Console → *Limits*, set a monthly spend limit so costs can never run away.
5. **GitHub (hands-off updates and monitoring):**
   - *Settings → General → Pull Requests*: turn on **Allow auto-merge**.
   - *Settings → Rules → Rulesets → New branch ruleset*: name `main`, enforcement **Active**, target the **default branch**, tick **Require status checks to pass** and add the `test` check. Leave *Require a pull request* unticked (or without required approvals), so Dependabot's weekly minor/patch updates merge themselves once CI passes. Major version bumps wait for you.
   - *Settings → Secrets and variables → Actions → Variables*: add `APP_URL` = your Worker URL (e.g. `https://aidedmind.<you>.workers.dev`). A daily health check then verifies the app, its storage, your Claude key and your Gemini and Supadata keys, and **GitHub emails you if any of them fails**. If you don't use a transcript service, add `EXPECT_SERVICES` listing the ones you do (e.g. `gemini`), or `none`. Run it any time from *Actions → Health check → Run workflow*.
6. **iPhone:** open the Worker URL in Safari → Share → **Add to Home Screen**. Open it, go to Settings, paste your `OWNER_TOKEN`, tap **Save & Test**, then follow *Save from the Share button*.

## Settings reference

Everything in the app's Settings tab. Choices are saved on the device.

| Section | Setting | What it does |
|---|---|---|
| Breakdown style | Auto / Quick / Balanced / Thorough | Which Claude model breaks things down; see [Breakdown styles](#breakdown-styles). Default Auto |
| Map | Color notes by: Theme / Source | Color the map by topic (with theme areas and names) or by where each note came from. Default Theme |
| Map | Theme detail: Broad / Balanced / Detailed | Fewer, bigger themes or more, smaller ones. Shows how many themes your library has. Default Balanced |
| Map | Shared ideas: Show / Hide | The diamonds linking notes that mention the same concept |
| Map | Sort notes by topic | Shown when some notes have no topic yet (saved before topics existed): fills them in with one cheap call |
| Connection | Server URL | Leave blank when the app is opened from your Worker URL (normal). Only for running the app from another address |
| Connection | Access token | Your `OWNER_TOKEN`, or a token from *Accounts*. **Save & Test** checks it |
| This month | (read-only) | Breakdowns used, estimated Claude spend, Gemini videos, Supadata transcripts |
| Server status | (read-only) | Whether Claude, Gemini and Supadata are on. **Run a full check** tests storage and each key (free) |
| Save from the Share button | (guide) | Step-by-step Shortcut setup with copy buttons for the inbox URL and your token |
| Your data | Export to Obsidian / Back up / Restore | `.zip` of Markdown notes, or a JSON backup of everything (restore merges it back in) |
| Accounts | (owner only) | Add accounts for other people and see each one's usage this month |
| About | App version / Check for updates / Setup guide | Updates normally install by themselves when you open the app |

## Troubleshooting

| What you see | Why, and the fix |
|---|---|
| A video or TikTok note says *partial* / "caption only" | The transcript service failed or isn't set up; the note's **Why:** line says which. Fix the key if needed, then note → ••• → **Get the full transcript** |
| Settings → *Server status* shows Gemini or Supadata **Off** after it worked before | The key was saved as a Text variable and a deploy removed it. Add it again with **Type: Secret** |
| *Server status* says "key rejected" | The key is wrong or was revoked. Gemini keys come from aistudio.google.com/apikey (they usually start with `AIza`) |
| "Supadata is out of credits" | The free plan's 100 monthly credits are used up. They reset monthly, or upgrade on supadata.ai |
| The app doesn't show a new feature | Close and reopen it; updates install on open. Settings → *About* → **Check for updates** checks right away |
| The Shortcut says "Saved" but nothing appears | The server is still breaking it down (a long video can take a few minutes): it shows under *Shared links* in the Library, then appears on its own. If nothing shows anywhere, check the token in the Shortcut matches Settings |
| A note says it's paywalled / partial | Only the free part was readable. Share it again with the same Shortcut from logged-in Safari, or use ••• → **Paste the full article** on the note |
| A shared link needs article text | Library → *Shared links* → **Add text**. The link remains saved and the same item is broken down after you supply text |
| "…is limiting how often AidedMind can read it right now" | The site is throttling requests. AidedMind shows its next retry time. A Substack app share first tries the publication's public post data and page; later retries use one route at a time, respect a longer `Retry-After` response, and stop after four attempts (about 14 minutes if no longer wait is requested). It then offers **Add text** or **Try again** on the saved link. **Add text** is available during the wait. Substack Share links (`open.substack.com/pub/…`) are read from the newsletter's own address |
| The Safari branch of the Shortcut sends no article text | Run it from Safari's Share menu on the article itself. Its JavaScript action must receive the Safari web page input. Short pages are sent as a link so the server can try them; long pages are cut at 400,000 characters |
| "You've used all N breakdowns for this month" | That account's plan limit; the owner token has no limit. Limits reset on the 1st |
| The daily health check email arrived | Open *Actions → Health check* in GitHub: the log names what failed (app, storage, Claude key, or a transcript key) |
| Health page shows `anthropic_error_400` | Usually no credit on the Anthropic account. Add credit in the Anthropic Console |
| No themes on the map | Themes need a few notes that share a topic, tags, ideas or links. Keep saving; *Theme detail → Detailed* also helps with small libraries |
| A note is in the wrong theme | Note → ••• → **Topic** → set its real subject. Settings → *Map* → **Sort notes by topic** if older notes have none |
| Two unrelated notes are linked | Note → **Links** tab → **×** on that link. It stays removed |

The live status page is `https://<your worker>/api/health?deep=1`.

## Accounts and the path to paid

The server already has everything a paid version needs except the payment step:

- **Accounts:** each person gets their own access token, inbox and usage record. As the owner you see an **Accounts** section in Settings: add an account (their token is shown once) and see how many breakdowns each account used this month.
- **Plans and quotas:** `free` (25 breakdowns/month), `pro` (400), `unlimited`, and your `owner` token. Limits are set in `worker/wrangler.jsonc` (`FREE_MONTHLY_CAPTURES`, `PRO_MONTHLY_CAPTURES`). A failed breakdown doesn't count against the quota.
- **Owner API:** `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id` (`{ "plan": "pro" }` or `{ "status": "paused" }`).
- **Token usage and cost per account per month** are recorded, so pricing can be set from real cost data.

Next step when you're ready: a Stripe Checkout + webhook that creates an account (or upgrades its plan) when someone pays.

## Configuration

| Name | Where | |
|---|---|---|
| `ANTHROPIC_API_KEY` | Cloudflare secret | required |
| `OWNER_TOKEN` | Cloudflare secret | required; your unlimited access token |
| `GEMINI_API_KEY` | Cloudflare secret, optional | YouTube transcripts and a backup breakdown when Claude is temporarily unavailable |
| `SUPADATA_API_KEY` | Cloudflare secret, optional | TikTok (and fallback YouTube caption) transcripts |
| `AIDEDMIND_DEFAULT_DEPTH` | `wrangler.jsonc` vars | breakdown style when the app doesn't send one: `auto` (default), `quick`, `balanced` or `thorough` |
| `AIDEDMIND_MODEL_QUICK` / `_BALANCED` / `_THOROUGH` | `wrangler.jsonc` vars | defaults `claude-haiku-4-5` / `claude-sonnet-5-5` / `claude-opus-5-5` |
| `FREE_MONTHLY_CAPTURES` / `PRO_MONTHLY_CAPTURES` | `wrangler.jsonc` vars | default 25 / 400 |
| `GEMINI_MODEL` | `wrangler.jsonc` vars | default `gemini-flash-latest` (Google's current Flash model) |
| `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`, `SUPADATA_BASE_URL` | vars, optional | point the API calls elsewhere (used by the tests; leave unset) |
| `APP_URL` | GitHub Actions variable | enables the daily health check |
| `EXPECT_SERVICES` | GitHub Actions variable, optional | transcript services the health check requires: default `gemini,supadata`; `none` to skip |

Anything in `wrangler.jsonc` vars is public (the repo is public): never put keys there. Keys go in Cloudflare as **Secrets**.

### Breakdown styles

Settings → *Breakdown style*, per device:

| Style | Model | Use it for |
|---|---|---|
| Auto (default) | picks per link: Quick under ~600 words or TikTok captions, Thorough from ~12,000 words, otherwise Balanced | everything; no extra call or cost |
| Quick | Claude Haiku 4.5, no extended thinking | TikToks, short posts; fastest and cheapest |
| Balanced | Claude Sonnet 5.5, medium effort | most articles and videos |
| Thorough | Claude Opus 5.5, medium effort | long or dense pieces; also available per note via ••• → *Re-analyze in depth* |

Summaries and outlines are kept short for skimming; quotes and takeaways get the most attention. Analysis uses Claude structured outputs (the reply always matches the note schema); Thorough also uses Anthropic's server-side refusal fallback (`fallbacks: "default"`). Sources over ~600k characters are rejected rather than silently truncated.

## API reference

All routes are under your Worker URL. Every route except `/api/health` needs the header `X-AidedMind-Token: <token>` (or `Authorization: Bearer <token>`).

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/health` (`?deep=1`) | | `ok`, `checks` (keys; with `deep`, also storage and model access), `services` (`gemini`, `supadata`), and with `deep` any `serviceProblems`. Public, spends nothing |
| `POST /api/auth-check` | `{}` | your plan and this month's usage and spend |
| `POST /api/source` | `{ url }` | the source text (or article HTML for the app to clean up), with `transcriptSource`, `partial` and `transcriptError` for videos |
| `POST /api/analyze` | `{ source, library, depth, concepts, topics }` | the breakdown (`analysis`, including its `topic`), model and style used, usage. Counts one breakdown |
| `POST /api/topics` | `{ notes: [{ id, title, tldr, tags }], topics }` | `{ assignments: { id: topic } }` for up to 150 notes, using the Quick model. Counts one breakdown |
| `POST /api/inbox` | `{ url }`, `{ url, title, text }` (page text you captured), or just the text as the body | saves a share and queues its background breakdown. Uses one breakdown when it succeeds |
| `PATCH /api/inbox/:id` | `{ text }` to supply article text, or `{}` to retry | requeues the same waiting item without losing its link |
| `GET /api/inbox` | | every item with its `status` (`pending`, `processing`, `done`, `failed`), `error`, and for finished items the `result` (source and breakdown) |
| `DELETE /api/inbox/:id` | | removes one (the app does this after collecting a note) |
| `PUT /api/preferences` | `{ depth, topics, concepts, urls }` | breakdown style, topic and concept names, and link fingerprints, used by background breakdowns |
| `POST /api/connections` | `{ note, library }` | suggested links from a finished note to related notes in `library`, using the Quick model; no breakdown is counted |
| `GET /api/admin/users` | | owner only: accounts and their usage |
| `POST /api/admin/users` | `{ plan, label }` | owner only: creates an account; its token is shown once |
| `PATCH /api/admin/users/:id` | `{ plan }` or `{ status }` | owner only: change plan, pause or resume |

## Security

- The server only fetches public `http(s)` links (localhost, private and link-local addresses are refused), with a 3 MB / 15 s cap.
- Every `/api` call except `/api/health` needs an access token; tokens are stored only as SHA-256 hashes and compared in constant time.
- The app builds every element with `textContent` (no `innerHTML`), and the site sends a strict Content-Security-Policy (`web/_headers`).
- The server keeps queued links and finished notes only until the app collects them (30 days at most), plus a small settings record of names and link fingerprints (see [Background breakdowns](#background-breakdowns)). Your library itself never leaves your phone.
- Source content is treated as untrusted by Claude: instructions inside an article, transcript or photo are ignored.

## Local development

```bash
npm install                                    # installs worker dependencies
cp worker/.dev.vars.example worker/.dev.vars   # fill in ANTHROPIC_API_KEY and OWNER_TOKEN (transcript keys optional)
npm run dev                                    # http://localhost:8787 (Cloudflare's runtime, local storage)
npm test                                       # Worker + web tests (Node 22.5+)
npm run check                                  # bundle exactly what Cloudflare will deploy
```

When changing anything in `web/`, bump `CACHE_NAME` in `web/service-worker.js` and `APP_VERSION` in `web/js/app.js` together (a test checks they match), and add new files to the service worker's list, so phones pick up the update.

## Project layout

```
worker/
  wrangler.jsonc        Cloudflare config: static assets, Durable Object, vars
  src/app.js            API routes: auth, quotas, source, analyze, inbox, admin, health
  src/extract.js        link → source (article HTML / YouTube / TikTok), fallback order
  src/article.js        reads the article out of a page's HTML on the server
  src/inbox-processor.js  breaks queued links down in the background, with retries
  src/connections.js    links a finished note to related library notes
  src/transcripts.js    Gemini, Supadata, YouTube description fallbacks, key checks
  src/costs.js          monthly spend estimate from the cost ledger
  src/analyze.js        Claude call, JSON schema (incl. topic), normalization
  src/topics.js         batch topics for notes saved before topics existed
  src/store-core.js     SQLite tables: users, inbox, usage, transcript cache, cost ledger
  src/store.js          Durable Object wrapper
web/
  index.html, tokens.css, app.css, shell.css, manifest.webmanifest, service-worker.js, _headers
  js/app.js             views, routing, sheets, inbox sync, settings, accounts, updates
  js/themes.js          map themes: topics, note similarity, clustering, names, colors
  js/graph.js           canvas map (themes, touch, pinch, label placement)
  js/library.js         related-note picking, concept and topic lists, duplicate links
  js/paywall.js         spots paywalled articles (shared by the phone and the server)
  js/readable.js        article HTML → clean text on the device
  js/photos.js          photo resize and thumbnails on the device
  js/api.js, db.js, markdown.js, zip.js, icons.js
  vendor/Readability.js Mozilla Readability (Apache-2.0)
.github/
  workflows/ci.yml                  tests + bundle check (the required `test` check)
  workflows/health.yml              daily live check, emails you on failure
  workflows/dependabot-automerge.yml
  dependabot.yml
```

## Roadmap

- Review mode: spaced-repetition cards from your quotes and takeaways
- Stripe checkout for paid plans
- PDFs and podcasts
- Optional encrypted sync between devices
