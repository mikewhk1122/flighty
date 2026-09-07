# HKG–CTS 票價板 (public)

A public, no-login fare board for the HKG ↔ CTS (Hong Kong ↔ New Chitose/Sapporo)
round trip, 9–16 Jan 2027. A GitHub Actions workflow checks Google Flights once
a day and commits the result to `data/prices.json`; `index.html` reads that file
and renders the chart/table — no backend, no database, no login required to view.

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
4. **Optional — run it once immediately** instead of waiting for the first
   scheduled run: *Actions* tab → "Daily fare check" workflow → *Run workflow*.

That's it — from then on, the workflow fires daily at 09:10 Asia/Hong_Kong
time, updates `data/prices.json`, and the Pages site picks up the change
automatically (no separate deploy step needed).

## How it works

- `scripts/check-price.mjs` — launches headless Chromium (Playwright),
  loads a saved Google Flights search with the currency/region pinned to
  HKD/Hong Kong, parses the results for the single cheapest fare and the
  cheapest fare with an outbound leg ≤8h, best-effort checks whether each of
  those two fares includes a checked bag, and writes the result into
  `data/prices.json` keyed by today's date (Asia/Hong_Kong).
- `.github/workflows/daily-check.yml` — runs that script daily via cron and
  commits the updated JSON straight to `main`.
- `index.html` — a static page, no build step. Fetches `data/prices.json` on
  load and renders the same design as the original tracker (chart, stat
  tiles, check-in table, baggage badges).

## Running the check locally

```bash
npm install
npx playwright install --with-deps chromium
npm run check
```

This updates `data/prices.json` in place. Open `index.html` through a local
static server (not `file://`, since `fetch()` needs http) to preview, e.g.:

```bash
npx http-server . -p 4173
```

## No write-back from the public page

The public page is view-only — there's no backend to safely accept anonymous
public writes. If a price looks wrong, open a GitHub issue on this repo (the
page links to one) and whoever maintains the repo can correct
`data/prices.json` directly.

## Limitations

- The scraper reads Google Flights' rendered results text, not an official
  API — if Google changes the page layout, the price check (or just the
  baggage check) may start failing. The workflow log will show what broke.
- The baggage-inclusion check is best-effort: it drills into each fare's
  itinerary summary, which adds a few extra page loads and is more fragile
  than the price check. If it fails, the day's entry is still logged with
  the two prices; the bag badge is simply omitted for that day.
