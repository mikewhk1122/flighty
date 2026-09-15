# flighty Discord bot — `/check`

A Cloudflare Worker that lets you type `/check` in a DM (or any server the
bot is in) to get the current HKG↔CTS fare right now, instead of waiting
for the next scheduled check. Runs on-demand — no server to keep alive,
no Gateway connection, nothing polling in the background.

## Why a Worker, not just the existing bot code

The bot's DM feature (in `../scripts/check-price.mjs`) only ever *sends*
messages, triggered by a cron job that runs briefly and exits. A slash
command needs the opposite: something that can *receive* an interaction
from Discord and reply within 3 seconds. Discord supports this without a
persistent connection via an **Interactions Endpoint URL** — an HTTPS
endpoint Discord POSTs to whenever someone uses the command. A Cloudflare
Worker (free tier, always warm, no cold-start server to manage) is exactly
that endpoint.

`/check` does a live SerpApi lookup and replies with an embed — it does
**not** write to `data/prices.json` or count toward the board's history;
that stays the automated cron's job. Think of it as "peek now" vs. the
board's "official" logged checks.

## One-time setup

Already done for this deployment, documented here for the next time this
needs to be redone (token rotation, moving to a new account, etc.):

1. **Get the app's Application ID and Public Key** from the Discord
   Developer Portal → your application → *General Information*. Both are
   non-secret; put them in `wrangler.toml` under `[vars]`.
2. **Register the `/check` command** (one-time, or whenever the command
   definition changes) — needs the bot token:
   ```bash
   curl -X PUT "https://discord.com/api/v10/applications/<APPLICATION_ID>/commands" \
     -H "Authorization: Bot <BOT_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '[{"name":"check","description":"Check the current HKG-CTS fare right now","type":1}]'
   ```
3. **Deploy the Worker**:
   ```bash
   cd discord-bot
   npx wrangler login              # one-time OAuth to your Cloudflare account
   npx wrangler secret put SERPAPI_KEY   # paste your SerpApi key when prompted
   npx wrangler deploy
   ```
   Wrangler prints the deployed URL, e.g.
   `https://flighty-discord-bot.<your-subdomain>.workers.dev`.
4. **Point Discord at it**: Developer Portal → application → *General
   Information* → **Interactions Endpoint URL** → paste that URL → Save.
   Discord immediately sends a test PING; the Worker must answer correctly
   or the save is rejected (a good sign if it saves — the endpoint is live
   and verifying signatures correctly).

## Redeploying after a code change

```bash
cd discord-bot
npx wrangler deploy
```

No need to re-register the command or reset any tokens unless the command
name/description changed or the bot token was rotated.

## Files

- `src/index.mjs` — the whole Worker: signature verification, PING
  handling, and the `/check` command logic (SerpApi call + reply).
- `wrangler.toml` — Worker config and the two public (non-secret) vars.
  `SERPAPI_KEY` is set separately via `wrangler secret put` so it's never
  written to a file or committed.
