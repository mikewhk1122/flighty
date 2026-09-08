# HKG–CTS 票價板 (public)

A public, no-login fare board for the HKG ↔ CTS (Hong Kong ↔ New Chitose/Sapporo)
round trip, 9–16 Jan 2027. A GitHub Actions workflow checks Google Flights (via
[SerpApi](https://serpapi.com)) every 12 hours and commits the result to
`data/prices.json`; `index.html` reads that file and renders the chart/table —
no backend, no database, no login required to view.

## One-time setup (do this after pushing the code)

1. **Push this folder's contents to a new GitHub repo** (see the commands the
   assistant gave you, or use GitHub's web UI).
2. **Enable GitHub Pages**: repo → *Settings* → *Pages* → under "Build and
   deployment", set **Source: Deploy from a branch**, **Branch: main**, folder
   **/ (root)** → Save. The site will be live at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.
3. **Enable Actions** (usually on by default for a new repo): repo → *Actions*
   tab → if prompted, click "I understand my workflows, go ahead and enable
   them".
4. **Get a SerpApi key**: sign up (free) at
   [serpapi.com](https://serpapi.com), copy your API key from the dashboard,
   add it as a repo secret named **`SERPAPI_KEY`** (*Settings → Secrets and
   variables → Actions → New repository secret*).
5. **Optional — run it once immediately** instead of waiting for the first
   scheduled run: *Actions* tab → "Fare check" workflow → *Run workflow*.

That's it — from then on, the workflow fires at 09:10 and 21:10 Asia/Hong_Kong
time (every 12h), updates `data/prices.json`, and the Pages site picks up the
change automatically (no separate deploy step needed).

## How it works

- `scripts/check-price.mjs` — calls SerpApi's `google_flights` engine with
  the route/dates/currency fixed (HKG↔CTS, 9–16 Jan 2027, HKD), which returns
  the same flight combos Google Flights itself shows, already structured as
  JSON (price, duration, stops, airline — no page-scraping or HTML parsing).
  Picks the single cheapest fare and the cheapest fare with an outbound leg
  ≤8h, and writes the result into `data/prices.json` keyed by this run's full
  timestamp — every run gets its own entry, so more frequent checks mean more
  data points, not overwritten ones.
- `.github/workflows/daily-check.yml` (workflow name: "Fare check") — runs
  that script on a cron (every 12h) and commits the updated JSON straight to
  `main`, retrying with a rebase if another commit landed on `main` first.
- `index.html` — a static page, no build step. Fetches `data/prices.json` on
  load and renders the chart/table.

## Running the check locally

```bash
SERPAPI_KEY=your_key_here npm run check
```

(No `npm install` needed — the script only uses Node's built-in `fetch`, no
dependencies.) This updates `data/prices.json` in place. Open `index.html`
through a local static server (not `file://`, since `fetch()` needs http) to
preview, e.g.:

```bash
npx http-server . -p 4173
```

## Optional: Discord notifications

Either or both of these can be set up independently, as GitHub repository
secrets (*Settings → Secrets and variables → Actions*). If none are set, the
workflow just skips notifications and still updates `data/prices.json`.

**A channel message**, via an incoming webhook — no bot needed:
1. In Discord, open the target channel's settings (or *Server Settings →
   Integrations*) → **Webhooks → New Webhook**, pick the channel, copy the URL.
2. Add it as secret **`DISCORD_WEBHOOK_URL`**.

**A DM to one or more people**, via a real Discord Bot application (never a
self-bot / personal-account automation — that violates Discord's ToS):
1. Create an app at [discord.com/developers/applications](https://discord.com/developers/applications)
   → **Bot** tab → **Reset Token** → copy it → add as secret **`DISCORD_BOT_TOKEN`**.
2. **OAuth2 → URL Generator** → check scope `bot` (no permissions needed) →
   open the generated URL → invite it to any server every recipient is
   also in (Discord requires the bot to share a server with someone before
   it can DM them — invite it to a server everyone in the group is already
   on, once, and it covers all of them).
3. For each person: turn on **Developer Mode** (User Settings → Advanced),
   right-click their name → **Copy User ID**. Add secret **`DISCORD_USER_ID`**
   with either one id, or several separated by commas (e.g.
   `111111111111111111,222222222222222222`) to DM more than one person.

## No write-back from the public page

The public page is view-only — there's no backend to safely accept anonymous
public writes. If a price looks wrong, open a GitHub issue on this repo (the
page links to one) and whoever maintains the repo can correct
`data/prices.json` directly.

## Limitations

- **No automatic baggage-inclusion check.** SerpApi *can* return whether a
  fare includes a checked bag, but only via two extra chained API calls per
  fare (mirroring Google Flights' own outbound → return → itinerary-summary
  flow). At this check frequency (twice daily × 2 fares) that would run
  ~300 calls/month against SerpApi's free 250/month limit. We chose to drop
  automatic baggage checking rather than pay for a plan — check bag
  inclusion manually on Google Flights when it's time to actually book.
- **SerpApi's free plan caps out at 250 searches/month.** At 1 call per
  check × 2 checks/day, this uses ~60/month — comfortable headroom. If the
  check frequency is ever increased further, watch this limit.
- Prices reflect what SerpApi's Google Flights engine returns, which itself
  reflects what Google's partners reported — Google's own fine print says
  this can lag up to ~24h behind live availability. Treat the board as a
  trend indicator; verify the real price on Google Flights before booking.
