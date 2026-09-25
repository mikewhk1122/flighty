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
const SITE_URL = 'https://flight.mikewky.com/';
const ALT_DATA_PATH = path.join(__dirname, '..', 'data', 'alt-dates.json');

// Alternative 7-night date ranges shown on the board's "compare dates"
// table. Checked far less often than the main trip to stay inside SerpApi's
// free 250 searches/month: only on the 01:10 and 13:10 UTC runs, one range
// per run in rotation, so each range refreshes every 2 days (~60/month on
// top of the main trip's ~120). ALT_CHECK=all checks every range at once
// (used to seed the data; costs one search per range).
const ALT_RANGES = [
  ['2027-01-08', '2027-01-15'],
  ['2027-01-10', '2027-01-17'],
  ['2027-01-11', '2027-01-18'],
  ['2027-01-12', '2027-01-19'],
];

function altRangesDueNow(now = new Date()) {
  if (process.env.ALT_CHECK === 'all') return ALT_RANGES;
  const hour = now.getUTCHours();
  // Only the runs near 01:10 and 13:10 UTC (the cron also fires at 07:10
  // and 19:10, and GitHub may start a scheduled run late).
  const half = hour >= 0 && hour < 6 ? 0 : hour >= 12 && hour < 18 ? 1 : null;
  if (half === null) return [];
  const days = Math.floor(now.getTime() / 86400000);
  return [ALT_RANGES[(days * 2 + half) % ALT_RANGES.length]];
}

// Pick the three tracked fares (cheapest, cheapest <=8h outbound, cheapest
// nonstop) plus Google's own price-level verdict out of one SerpApi result.
function analyze(data) {
  const combos = [...(data.best_flights || []), ...(data.other_flights || [])]
    .map(normalize)
    .filter((f) => Number.isFinite(f.price) && f.price > 0);
  if (combos.length === 0) return null;
  const cheapestFlight = combos.reduce((a, b) => (b.price < a.price ? b : a));
  const underEight = combos.filter((f) => f.minutes != null && f.minutes <= REASONABLE_MAX_MINUTES);
  const reasonableFlight = (underEight.length ? underEight : combos.slice().sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9)))
    .reduce((a, b) => (b.price < a.price ? b : a));
  const nonstopCombos = combos.filter((f) => f.stops === 0);
  const nonstopFlight = nonstopCombos.length ? nonstopCombos.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const insights = data.price_insights || {};
  return {
    cheapestFlight,
    reasonableFlight,
    nonstopFlight,
    hadUnderEight: underEight.length > 0,
    level: insights.price_level || null, // "low" | "typical" | "high"
    typicalRange: Array.isArray(insights.typical_price_range) ? insights.typical_price_range : null,
  };
}

const LEVEL_LABEL = { low: '偏低', typical: '一般', high: '偏高' };

// Check whichever alternative ranges are due and append a snapshot per range
// to data/alt-dates.json. Never throws — a failure here must not cost the
// main trip's check (which has already been written by the time this runs).
async function checkAltRanges(apiKey) {
  const due = altRangesDueNow();
  if (!due.length) return;

  let store = {};
  try {
    store = JSON.parse(await readFile(ALT_DATA_PATH, 'utf8'));
  } catch {
    store = {};
  }

  for (const [outbound, ret] of due) {
    const key = `${outbound}_${ret}`;
    try {
      const a = analyze(await fetchFlights(apiKey, outbound, ret));
      if (!a) {
        console.error(`Alt range ${key}: no usable flight combos, skipped.`);
        continue;
      }
      const entry = store[key] || { outbound, return: ret, history: [] };
      entry.history.push({
        checkedAt: new Date().toISOString(),
        cheapest: a.cheapestFlight.price,
        reasonable: a.reasonableFlight.price,
        ...(a.nonstopFlight ? { nonstop: a.nonstopFlight.price } : {}),
        level: a.level,
        typicalRange: a.typicalRange,
        note:
          `Cheapest: ${describeFlight(a.cheapestFlight)}. Best <=8h: ${describeFlight(a.reasonableFlight)}.` +
          (a.nonstopFlight ? ` Cheapest nonstop: ${describeFlight(a.nonstopFlight)}.` : ' No nonstop.'),
      });
      store[key] = entry;
      console.log(`Alt ${key}: cheapest HK$${a.cheapestFlight.price}, nonstop ${a.nonstopFlight ? 'HK$' + a.nonstopFlight.price : '—'}, level ${a.level}.`);
    } catch (err) {
      console.error(`Alt range ${key} failed:`, err.message);
    }
  }

  await writeFile(ALT_DATA_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

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

async function fetchFlights(apiKey, outboundDate = SEARCH_PARAMS.outbound_date, returnDate = SEARCH_PARAMS.return_date) {
  const url = new URL('https://serpapi.com/search.json');
  for (const [k, v] of Object.entries(SEARCH_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set('outbound_date', outboundDate);
  url.searchParams.set('return_date', returnDate);
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
    // SerpApi omits `layovers` entirely for nonstop combos rather than
    // sending an empty array — treat "no layovers field" as 0 stops, not
    // "unknown" (which used to make nonstop flights misreport as such).
    stops: Array.isArray(entry.layovers) ? entry.layovers.length : 0,
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

function buildEmbed({ whenLabel, cheapestFlight, reasonableFlight, nonstopFlight, level, typicalRange, prev }) {
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
      {
        name: '直飛',
        value: nonstopFlight ? `HK$${nonstopFlight.price.toLocaleString()}\n${describeFlight(nonstopFlight)}` : '暫時冇直飛航班',
        inline: true,
      },
      { name: '對比上次查詢', value: deltaLine, inline: true },
      ...(level
        ? [{
          name: 'Google 價格水平',
          value: `${LEVEL_LABEL[level] || level}` +
            (typicalRange ? `（一般 HK$${typicalRange[0].toLocaleString()}–${typicalRange[1].toLocaleString()}）` : ''),
          inline: true,
        }]
        : []),
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

// DM each configured Discord user directly, via a real Discord Bot
// application (never a personal/self-bot account — that violates Discord's
// ToS). DISCORD_USER_ID may hold one id or a comma-separated list — each
// recipient must already share a server with the bot (Discord requires this
// before it will open a DM), see README. One recipient's failure doesn't
// stop the others.
async function notifyDiscordDM(embed) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const rawIds = process.env.DISCORD_USER_ID;
  if (!token || !rawIds) return;

  const userIds = rawIds.split(',').map((id) => id.trim()).filter(Boolean);
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'flighty-fare-bot (https://github.com/mikewhk1122/flighty, 1.0)',
  };

  for (const userId of userIds) {
    try {
      const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers,
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!dmRes.ok) {
        console.error(`Discord DM-channel open failed for ${userId}:`, dmRes.status, await dmRes.text());
        continue;
      }
      const channel = await dmRes.json();

      const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!msgRes.ok) console.error(`Discord DM send failed for ${userId}:`, msgRes.status, await msgRes.text());
    } catch (err) {
      console.error(`Discord DM failed for ${userId}:`, err.message);
    }
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
  const analysis = analyze(data);

  if (!analysis) {
    console.error('SerpApi returned no usable flight combos. Skipping write.');
    console.error(JSON.stringify(data).slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const { cheapestFlight, reasonableFlight, nonstopFlight, hadUnderEight, level, typicalRange } = analysis;

  const loggedAt = new Date().toISOString();
  const docId = loggedAt;
  const whenLabel = nowHKLabel();
  const note =
    `Cheapest: ${describeFlight(cheapestFlight)}.` +
    ` Best <=8h: ${describeFlight(reasonableFlight)}` +
    (hadUnderEight ? '.' : ' (no itinerary was <=8h; used the shortest available instead).') +
    (nonstopFlight ? ` Cheapest nonstop: ${describeFlight(nonstopFlight)}.` : ' No nonstop itinerary was available.');

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
    ...(nonstopFlight ? { nonstop: nonstopFlight.price } : {}),
    ...(level ? { level } : {}),
    ...(typicalRange ? { typicalRange } : {}),
    currency: 'HKD',
    source: 'auto',
    loggedBy: 'Automated check (SerpApi)',
    loggedAt,
    note,
  };

  await writeFile(DATA_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');

  const embed = buildEmbed({ whenLabel, cheapestFlight, reasonableFlight, nonstopFlight, level, typicalRange, prev });
  await notifyDiscordWebhook(embed);
  await notifyDiscordDM(embed);

  await checkAltRanges(apiKey);

  let summary = `Cheapest HK$${cheapestFlight.price.toLocaleString()} (${describeFlight(cheapestFlight)}). ` +
    `<=8h fare HK$${reasonableFlight.price.toLocaleString()} (${describeFlight(reasonableFlight)}). ` +
    (nonstopFlight ? `Nonstop HK$${nonstopFlight.price.toLocaleString()} (${describeFlight(nonstopFlight)}).` : 'No nonstop available.');
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
