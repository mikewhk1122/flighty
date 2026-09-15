// Cloudflare Worker: Discord Interactions endpoint for the /check slash
// command. Discord POSTs every interaction here (instead of requiring a
// persistent Gateway connection) — this is what makes an on-demand,
// serverless bot possible instead of needing an always-running process.
//
// Flow for /check:
//   1. Verify the request really came from Discord (Ed25519 signature).
//   2. Reply immediately with a "deferred" response (type 5) — Discord
//      requires an ack within 3s, and the SerpApi round trip may take
//      longer than that.
//   3. In the background (ctx.waitUntil), do the real work and PATCH the
//      deferred message with the real answer.
//
// Route/dates are duplicated from scripts/check-price.mjs deliberately —
// this Worker is deployed independently of the GitHub Actions cron job and
// has no access to that file at runtime, so keep the two in sync by hand
// if the trip's dates ever change.

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

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Discord's required signature check. Cloudflare's Workers runtime
// supports Ed25519 verification natively via Web Crypto under the
// non-standard algorithm name "NODE-ED25519" — no external library needed.
async function verifyDiscordSignature(body, signatureHex, timestamp, publicKeyHex) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'NODE-ED25519',
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

// Same shape as scripts/check-price.mjs's normalize()/describeFlight() —
// see that file's comments for why `layovers` being absent means 0 stops,
// not "unknown".
function normalize(entry) {
  const legs = entry.flights || [];
  const airlines = [...new Set(legs.map((f) => f.airline).filter(Boolean))];
  return {
    price: entry.price,
    minutes: entry.total_duration ?? null,
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

function nowHKLabel() {
  const hk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const iso = hk.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} HKT`;
}

async function fetchFlights(apiKey) {
  const url = new URL('https://serpapi.com/search.json');
  for (const [k, v] of Object.entries(SEARCH_PARAMS)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', apiKey);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi responded ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`SerpApi error: ${data.error}`);
  return data;
}

// Best-effort comparison against the public board's most recent automated
// entry. Never throws — a failure here just means no delta line, not a
// failed command.
async function fetchBoardDelta(cheapestPrice) {
  try {
    const res = await fetch(`${SITE_URL}data/prices.json`, { cf: { cacheTtl: 0 } });
    if (!res.ok) return null;
    const store = await res.json();
    const keys = Object.keys(store).sort();
    if (!keys.length) return null;
    const last = store[keys[keys.length - 1]];
    if (typeof last.cheapest !== 'number') return null;
    const diff = cheapestPrice - last.cheapest;
    const pct = last.cheapest ? (diff / last.cheapest) * 100 : 0;
    if (diff === 0) return '同板上最新自動記錄一樣';
    return `${diff < 0 ? '▼ 平咗' : '▲ 貴咗'} HK$${Math.abs(diff).toLocaleString()}（${Math.abs(pct).toFixed(1)}%）—— 對比板上最新自動記錄`;
  } catch {
    return null;
  }
}

async function handleCheckCommand(interaction, env) {
  const followupUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;

  try {
    const data = await fetchFlights(env.SERPAPI_KEY);
    const combos = [...(data.best_flights || []), ...(data.other_flights || [])]
      .map(normalize)
      .filter((f) => Number.isFinite(f.price) && f.price > 0);

    if (combos.length === 0) throw new Error('SerpApi returned no usable flight combos');

    const cheapestFlight = combos.reduce((a, b) => (b.price < a.price ? b : a));
    const underEight = combos.filter((f) => f.minutes != null && f.minutes <= REASONABLE_MAX_MINUTES);
    const reasonableFlight = (underEight.length ? underEight : combos.slice().sort((a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9)))
      .reduce((a, b) => (b.price < a.price ? b : a));
    const nonstopCombos = combos.filter((f) => f.stops === 0);
    const nonstopFlight = nonstopCombos.length ? nonstopCombos.reduce((a, b) => (b.price < a.price ? b : a)) : null;

    const deltaLine = await fetchBoardDelta(cheapestFlight.price);

    const fields = [
      { name: '最低價', value: `HK$${cheapestFlight.price.toLocaleString()}\n${describeFlight(cheapestFlight)}`, inline: true },
      { name: '8小時內', value: `HK$${reasonableFlight.price.toLocaleString()}\n${describeFlight(reasonableFlight)}`, inline: true },
      {
        name: '直飛',
        value: nonstopFlight ? `HK$${nonstopFlight.price.toLocaleString()}\n${describeFlight(nonstopFlight)}` : '暫時冇直飛航班',
        inline: true,
      },
    ];
    if (deltaLine) fields.push({ name: '對比自動記錄', value: deltaLine, inline: false });

    const embed = {
      title: 'HKG ⇄ CTS 即時票價',
      url: SITE_URL,
      description: `9–16 Jan 2027 · 即時查詢 · ${nowHKLabel()}`,
      color: 0x22688a,
      fields,
      footer: { text: '即時查詢 · flighty /check（呢次查詢冇寫入歷史記錄）' },
      timestamp: new Date().toISOString(),
    };

    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    await fetch(followupUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `❌ 查詢失敗：${err.message}` }),
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('flighty Discord bot is running.', { status: 200 });
    }

    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const body = await request.text();

    if (!signature || !timestamp) {
      return new Response('Missing signature headers', { status: 401 });
    }
    const valid = await verifyDiscordSignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!valid) {
      return new Response('Invalid request signature', { status: 401 });
    }

    const interaction = JSON.parse(body);

    // PING — Discord sends this once when you save the Interactions
    // Endpoint URL, to confirm the endpoint is alive and verifies correctly.
    if (interaction.type === 1) {
      return jsonResponse({ type: 1 });
    }

    // APPLICATION_COMMAND
    if (interaction.type === 2 && interaction.data?.name === 'check') {
      ctx.waitUntil(handleCheckCommand(interaction, env));
      return jsonResponse({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    return jsonResponse({ type: 4, data: { content: '未知指令。' } });
  },
};
