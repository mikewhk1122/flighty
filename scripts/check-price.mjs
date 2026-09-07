// Daily HKG <-> CTS fare check. Scrapes Google Flights (headless, HKD/HK/en pinned),
// parses the results text for the cheapest fare and the cheapest fare with an
// outbound leg of 8h or less, and writes both into data/prices.json keyed by
// today's Asia/Hong_Kong date. Run via GitHub Actions on a daily cron.

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'prices.json');

const SEARCH_URL =
  'https://www.google.com/travel/flights?q=Flights%20from%20Hong%20Kong%20to%20Sapporo%20New%20Chitose%20Jan%209%202027%20-%20Jan%2016%202027&curr=HKD&gl=HK&hl=en';

const REASONABLE_MAX_MINUTES = 8 * 60;

function todayHK() {
  // Asia/Hong_Kong is UTC+8, no DST.
  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return hk.toISOString().slice(0, 10);
}

function yesterdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Parse the flat innerText of the results page into flight entries.
// Each entry in the visible text ends with a line like "HK$4,829" followed by
// "round trip" (see fixtures/sample-results.txt for the real shape). We scan
// backward from each such price for the nearest duration ("7 hr 25 min") and
// stop-count ("Nonstop" / "1 stop" / "2 stops") to know if it qualifies as
// a <=8h "reasonable" itinerary.
export function parseFlights(text) {
  // Anchor on "<duration>\n<ROUTE>\n<stops>" — this total-duration line sits
  // directly above the route code in every flight block, distinguishing it
  // from a layover duration ("2 hr 5 min HND"), which is a separate line
  // further down the same block and never immediately precedes the route.
  const legRe = /(\d+)\s*hr(?:\s*(\d+)\s*min)?\r?\n(HKG–CTS|CTS–HKG)\r?\n(Nonstop|\d+\s*stops?)/g;
  const legs = [...text.matchAll(legRe)];

  const priceRe = /HK\$([\d,]+)\s*\r?\n\s*round trip/g;

  const flights = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const blockStart = leg.index;
    const blockEnd = i + 1 < legs.length ? legs[i + 1].index : text.length;
    const block = text.slice(blockStart, blockEnd);

    priceRe.lastIndex = 0;
    const priceMatch = priceRe.exec(block);
    if (!priceMatch) continue; // "Price unavailable" or similar — skip, no usable price

    const minutes = parseInt(leg[1], 10) * 60 + (leg[2] ? parseInt(leg[2], 10) : 0);
    const stopsText = leg[4];
    const stops = /^Nonstop$/i.test(stopsText) ? 0 : parseInt(stopsText, 10);

    const preLeg = text.slice(Math.max(0, blockStart - 60), blockStart);
    const airlineLineMatch = preLeg.match(/\n([^\n]+)\n?$/);

    flights.push({
      price: parseInt(priceMatch[1].replace(/,/g, ''), 10),
      minutes,
      stops,
      airline: airlineLineMatch ? airlineLineMatch[1].trim() : null,
    });
  }
  return flights.filter((f) => Number.isFinite(f.price) && f.price > 0);
}

// Best-effort: open a specific fare's itinerary summary (by clicking the
// matching-price row twice — once to pick the outbound, once the return —
// which is the only place Google Flights actually states whether a checked
// bag is included) and read off the baggage line. Returns 'included',
// 'extra', or null if anything about the flow doesn't go as expected —
// callers must treat null as "unknown", never as a guess.
async function checkBagStatus(page, price) {
  const sel = `[role="link"][aria-label^="From ${price} Hong Kong dollars"]`;
  await page.locator(sel).first().click({ force: true, timeout: 10000 });
  await page.waitForSelector('text=/Choose return|Returning flights/i', { timeout: 20000 });
  await page.waitForTimeout(600);

  await page.locator(sel).first().click({ force: true, timeout: 10000 });
  await page.waitForSelector('text=/Itinerary summary/i', { timeout: 20000 });
  await page.waitForSelector('text=/checked bag/i', { timeout: 20000 });
  await page.waitForTimeout(400);

  const bodyText = await page.evaluate(() => document.body.innerText);
  // A round trip has a departing- and returning-flight baggage line; if
  // either leg charges extra, treat the fare as not fully bag-included.
  let bag = null;
  if (/1st checked bag available for a fee/i.test(bodyText)) bag = 'extra';
  else if (/1st checked bag free/i.test(bodyText)) bag = 'included';

  await page.goBack();
  await page.goBack();
  await page.waitForSelector('text=/HK\\$[0-9,]+/', { timeout: 20000 });
  return bag;
}

const SITE_URL = 'https://mikewhk1122.github.io/flighty/';
const BAG_LABEL = { included: '含行李', extra: '行李另收費', null: '行李未知', undefined: '行李未知' };

// Post today's result to a Discord channel via an incoming webhook — no bot
// process to host, just one POST. Silently does nothing if the
// DISCORD_WEBHOOK_URL secret isn't set (e.g. local runs), and never lets a
// notification failure affect the exit code — the price data is already
// safely written by the time this runs.
async function notifyDiscord({ date, cheapestFlight, reasonableFlight, bagCheap, bagReasonable, prev }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  let deltaLine = '首次記錄';
  let color = 0x8a93a1; // neutral grey
  if (prev && typeof prev.cheapest === 'number') {
    const diff = cheapestFlight.price - prev.cheapest;
    const pct = prev.cheapest ? (diff / prev.cheapest) * 100 : 0;
    if (diff === 0) {
      deltaLine = '同琴日一樣';
    } else {
      deltaLine = `${diff < 0 ? '▼ 跌咗' : '▲ 升咗'} HK$${Math.abs(diff).toLocaleString()}（${Math.abs(pct).toFixed(1)}%）`;
      color = diff < 0 ? 0x1c8a5e : 0xb2394a;
    }
  }

  const body = {
    embeds: [
      {
        title: 'HKG ⇄ CTS 票價更新',
        url: SITE_URL,
        description: `9–16 Jan 2027 · ${date}`,
        color,
        fields: [
          {
            name: '最低價',
            value: `HK$${cheapestFlight.price.toLocaleString()}（${BAG_LABEL[bagCheap]}）\n${describeFlight(cheapestFlight)}`,
            inline: true,
          },
          {
            name: '8小時內',
            value: `HK$${reasonableFlight.price.toLocaleString()}（${BAG_LABEL[bagReasonable]}）\n${describeFlight(reasonableFlight)}`,
            inline: true,
          },
          { name: '對比琴日', value: deltaLine, inline: false },
        ],
        footer: { text: '每日自動查詢 · flighty' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('Discord webhook responded', res.status, await res.text());
    }
  } catch (err) {
    console.error('Discord webhook post failed:', err.message);
  }
}

function describeFlight(f) {
  const parts = [];
  if (f.airline) parts.push(f.airline);
  parts.push(f.stops === 0 ? 'nonstop' : f.stops != null ? `${f.stops} stop${f.stops === 1 ? '' : 's'}` : 'stops unknown');
  if (f.minutes != null) parts.push(`~${Math.floor(f.minutes / 60)}h${String(f.minutes % 60).padStart(2, '0')}m`);
  return parts.join(', ');
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: 'en-HK', timezoneId: 'Asia/Hong_Kong' });

  let text = '';
  let bagCheap = null;
  let bagReasonable = null;
  try {
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Results render client-side after the initial shell; wait for a price to show up.
    await page.waitForSelector('text=/HK\\$[0-9,]+/', { timeout: 30000 });
    await page.waitForTimeout(1500); // let the rest of the list settle
    text = await page.evaluate(() => document.body.innerText);

    const flightsForBag = parseFlights(text);
    if (flightsForBag.length) {
      const cheapestForBag = flightsForBag.reduce((a, b) => (b.price < a.price ? b : a));
      const under8ForBag = flightsForBag.filter((f) => f.minutes != null && f.minutes <= REASONABLE_MAX_MINUTES);
      const reasonableForBag = (under8ForBag.length ? under8ForBag : flightsForBag)
        .reduce((a, b) => (b.price < a.price ? b : a));

      // Best-effort baggage lookup — never let a failure here block the price write.
      try {
        bagCheap = await checkBagStatus(page, cheapestForBag.price);
      } catch (err) {
        console.error('bag check (cheapest) failed, leaving unknown:', err.message);
      }
      try {
        if (reasonableForBag.price !== cheapestForBag.price) {
          bagReasonable = await checkBagStatus(page, reasonableForBag.price);
        } else {
          bagReasonable = bagCheap;
        }
      } catch (err) {
        console.error('bag check (reasonable) failed, leaving unknown:', err.message);
      }
    }
  } finally {
    await browser.close();
  }

  if (!/HK\$[\d,]/.test(text)) {
    console.error('No HK$ prices found on the page — currency pin may have failed, or the page did not load results. Skipping write.');
    console.error('--- page text (first 1000 chars) ---');
    console.error(text.slice(0, 1000));
    process.exitCode = 1;
    return;
  }

  const flights = parseFlights(text);
  if (flights.length === 0) {
    console.error('Found HK$ text but could not parse any flight entries. Skipping write.');
    process.exitCode = 1;
    return;
  }

  const cheapestFlight = flights.reduce((a, b) => (b.price < a.price ? b : a));
  const underEight = flights.filter((f) => f.minutes != null && f.minutes <= REASONABLE_MAX_MINUTES);
  const reasonableFlight = (underEight.length ? underEight : flights.slice().sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9)))
    .reduce((a, b) => (b.price < a.price ? b : a));

  const date = todayHK();
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

  const prevDate = yesterdayOf(date);
  const prev = store[prevDate];

  store[date] = {
    cheapest: cheapestFlight.price,
    reasonable: reasonableFlight.price,
    ...(bagCheap ? { bagCheap } : {}),
    ...(bagReasonable ? { bagReasonable } : {}),
    currency: 'HKD',
    source: 'auto',
    loggedBy: 'Automated daily check',
    loggedAt: new Date().toISOString(),
    note,
  };

  await writeFile(DATA_PATH, JSON.stringify(store, null, 2) + '\n', 'utf8');

  await notifyDiscord({ date, cheapestFlight, reasonableFlight, bagCheap, bagReasonable, prev });

  let summary = `Cheapest HK$${cheapestFlight.price.toLocaleString()} (${describeFlight(cheapestFlight)}, bag: ${bagCheap || 'unknown'}). ` +
    `<=8h fare HK$${reasonableFlight.price.toLocaleString()} (${describeFlight(reasonableFlight)}, bag: ${bagReasonable || 'unknown'}).`;
  if (prev && typeof prev.cheapest === 'number') {
    const diff = cheapestFlight.price - prev.cheapest;
    const pct = prev.cheapest ? (diff / prev.cheapest) * 100 : 0;
    summary += ` Vs yesterday: ${diff === 0 ? 'flat' : (diff < 0 ? '-' : '+') + 'HK$' + Math.abs(diff).toLocaleString() + ` (${pct.toFixed(1)}%)`}.`;
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
