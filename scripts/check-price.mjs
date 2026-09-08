// HKG <-> CTS fare check, via SerpApi's Google Flights engine (structured
// JSON of the same Google Flights data — no headless browser, no HTML
// parsing). One search call returns every flight combo Google shows,
// each already priced as a complete round trip, so getting the cheapest
// fare and the cheapest fare with an outbound leg <=8h just means picking
// from that list. Writes the result into data/prices.json keyed by this
// run's full timestamp — every run gets its own entry, so running more
// often adds data points instead of overwriting the previous one.
//
// Note: this does NOT check baggage inclusion. SerpApi can surface that,
// but only via two more chained calls per fare (~5x the call cost), which
// would blow past the free plan's monthly quota at this check frequency —
// see README for the trade-off. Check baggage manually on Google Flights
// when it matters for booking.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'prices.json');

const SEARCH_PARAMS = {
  engine: 'google_flights',
  departure_id: 'HKG',
  arrival_id: 'CTS',
  outbound_date: '2027-01-09',
  return_date: '2027-01-16',
  currency: 'HKD',
  hl: 'en',
  gl: 'hk',
  type: '1', // round trip
};

const REASONABLE_MAX_MINUTES = 8 * 60;
const SITE_URL = 'https://mikewhk1122.github.io/flighty/';

// A human-readable Asia/Hong_Kong timestamp, e.g. "2026-09-08 09:10 HKT".
function nowHKLabel() {
  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = hk.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} HKT`;
}

// The chronologically most recent existing entry, if any.
function findPreviousEntry(store, beforeKey) {
  const keys = Object.keys(store).filter((k) => k < beforeKey).sort();
  if (!keys.length) return null;
  return store[keys[keys.length - 1]];
}

async function fetchFlights(apiKey) {
  const url = new URL('https://serpapi.com/search.json');
  for (const [k, v] of Object.entries(SEARCH_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SerpApi responded ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`SerpApi error: ${data.error}`);
  return data;
}

// Normalize a SerpApi flight-combo entry into the shape the rest of this
// script works with. `total_duration` is the OUTBOUND leg's duration in
// minutes (matches our existing "<=8h outbound" definition); `layovers`
// counts stops on that outbound leg.
function normalize(entry) {
  const legs = entry.flights || [];
  const airlines = [...new Set(legs.map((f) => f.airline).filter(Boolean))];
  return {
    price: entry.price,
    minutes: entry.total_duration ?? null,
    stops: Array.isArray(entry.layovers) ? entry.layovers.length : null,
    airline: airlines.join('/') || null,
  };
}

function describeFlight(f) {
  const parts = [];
  if (f.airline) parts.push(f.airline);
  parts.push(f.stops === 0 ? 'nonstop' : f.stops != null ? `${f.stops} stop${f.stops === 1 ? '' : 's'}` : 'stops unknown');
  if (f.minutes != null) parts.push(`~${Math.floor(f.minutes / 60)}h${String(f.minutes % 60).padStart(2, '0')}m`);
  return parts.join(', ');
}

function buildEmbed({ whenLabel, cheapestFlight, reasonableFlight, prev }) {
  let deltaLine = '首次記錄';
  let color = 0x8a93a1; // neutral grey
  if (prev && typeof prev.cheapest === 'number') {
    const diff = cheapestFlight.price - prev.cheapest;
    const pct = prev.cheapest ? (diff / prev.cheapest) * 100 : 0;
    if (diff === 0) {
      deltaLine = '同上次一樣';
    } else {
      deltaLine = `${diff < 0 ? '▼ 跌咗' : '▲ 升咗'} HK$${Math.abs(diff).toLocaleString()}（${Math.abs(pct).toFixed(1)}%）`;
      color = diff < 0 ? 0x1c8a5e : 0xb2394a;
    }
  }

  return {
    title: 'HKG ⇄ CTS 票價更新',
    url: SITE_URL,
    description: `9–16 Jan 2027 · ${whenLabel}`,
    color,
    fields: [
      { name: '最低價', value: `HK$${cheapestFlight.price.toLocaleString()}\n${describeFlight(cheapestFlight)}`, inline: true },
      { name: '8小時內', value: `HK$${reasonableFlight.price.toLocaleString()}\n${describeFlight(reasonableFlight)}`, inline: true },
      { name: '對比上次查詢', value: deltaLine, inline: false },
    ],
    footer: { text: '自動查詢 · flighty' },
    timestamp: new Date().toISOString(),
  };
}

async function notifyDiscordWebhook(embed) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) console.error('Discord webhook responded', res.status, await res.text());
  } catch (err) {
    console.error('Discord webhook post failed:', err.message);
  }
}

// DM the given Discord user directly, via a real Discord Bot application
// (never a personal/self-bot account — that violates Discord's ToS).
async function notifyDiscordDM(embed) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const userId = process.env.DISCORD_USER_ID;
  if (!token || !userId) return;

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'flighty-fare-bot (https://github.com/mikewhk1122/flighty, 1.0)',
  };

  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!dmRes.ok) {
      console.error('Discord DM-channel open failed:', dmRes.status, await dmRes.text());
      return;
    }
    const channel = await dmRes.json();

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!msgRes.ok) console.error('Discord DM send failed:', msgRes.status, await msgRes.text());
  } catch (err) {
    console.error('Discord DM failed:', err.message);
  }
}

async function main() {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.error('SERPAPI_KEY is not set. Skipping check.');
    process.exitCode = 1;
    return;
  }

  const data = await fetchFlights(apiKey);
  const combos = [...(data.best_flights || []), ...(data.other_flights || [])]
    .map(normalize)
    .filter((f) => Number.isFinite(f.price) && f.price > 0);

  if (combos.length === 0) {
    console.error('SerpApi returned no usable flight combos. Skipping write.');
    console.error(JSON.stringify(data).slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const cheapestFlight = combos.reduce((a, b) => (b.price < a.price ? b : a));
  const underEight = combos.filter((f) => f.minutes != null && f.minutes <= REASONABLE_MAX_MINUTES);
  const reasonableFlight = (underEight.length ? underEight : combos.slice().sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9)))
    .reduce((a, b) => (b.price < a.price ? b : a));

  const loggedAt = new Date().toISOString();
  const docId = loggedAt;
  const whenLabel = nowHKLabel();
  const note =
    `Cheapest: ${describeFlight(cheapestFlight)}.` +
    ` Best <=8h: ${describeFlight(reasonableFlight)}` +
    (underEight.length === 0 ? ' (no itinerary was <=8h; used the shortest available instead).' : '.');

  let store = {};
  try {
    store = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  } catch {
    store = {};
  }

  const prev = findPreviousEntry(store, docId);

  store[docId] = {
    cheapest: cheapestFlight.price,
    reasonable: reasonableFlight.price,
    currency: 'HKD',
    source: 'auto',
    loggedBy: 'Automated check (SerpApi)',
    loggedAt,
    note,
  };

  await writeFile(DATA_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');

  const embed = buildEmbed({ whenLabel, cheapestFlight, reasonableFlight, prev });
  await notifyDiscordWebhook(embed);
  await notifyDiscordDM(embed);

  let summary = `Cheapest HK$${cheapestFlight.price.toLocaleString()} (${describeFlight(cheapestFlight)}). ` +
    `<=8h fare HK$${reasonableFlight.price.toLocaleString()} (${describeFlight(reasonableFlight)}).`;
  if (prev && typeof prev.cheapest === 'number') {
    const diff = cheapestFlight.price - prev.cheapest;
    const pct = prev.cheapest ? (diff / prev.cheapest) * 100 : 0;
    summary += ` Vs previous check: ${diff === 0 ? 'flat' : (diff < 0 ? '-' : '+') + 'HK$' + Math.abs(diff).toLocaleString() + ` (${pct.toFixed(1)}%)`}.`;
  }
  console.log(summary);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('check-price failed:', err);
    process.exitCode = 1;
  });
}
