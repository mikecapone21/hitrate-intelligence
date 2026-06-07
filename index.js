const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const { execFile }      = require('child_process');
const { createClient }  = require('@supabase/supabase-js');
const RSSParser         = require('rss-parser');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API keys & base URLs ───────────────────────────────────────────────────
const PW_KEY       = process.env.POKEWALLET_KEY;
const PT_KEY       = process.env.POKETRACE_KEY;
const TCG_KEY      = process.env.POKEMONTCG_KEY;
const YT_KEY       = process.env.YOUTUBE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const PW_BASE     = 'https://api.pokewallet.io';
const PT_BASE     = 'https://api.poketrace.com/v1';
const TCG_BASE    = 'https://api.pokemontcg.io/v2';
const TCGDEX_BASE = 'https://api.tcgdex.net/v2/en';
const YT_BASE     = 'https://www.googleapis.com/youtube/v3';

const PYTHON = '/nix/store/flbj8bq2vznkcwss7sm0ky8rd0k6kar7-python-wrapped-0.1.0/bin/python3';

const supabase  = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const rssParser = new RSSParser({ timeout: 10000 });

if (!supabase) console.warn('[supabase] No credentials — price logging disabled');
if (!YT_KEY)   console.warn('[youtube]  No API key — buzz detection disabled');

// ── Cache TTLs ─────────────────────────────────────────────────────────────
const PRICE_TTL_MS    = 30 * 60 * 1000;
const TRENDS_TTL_MS   =  6 * 60 * 60 * 1000;
const TCG_SETS_TTL_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_TTL_MS  =  6 * 60 * 60 * 1000;
const NEWS_TTL_MS     =  1 * 60 * 60 * 1000;

let priceCache   = { data: null, fetchedAt: null, inFlight: false };
let trendsCache  = { data: null, fetchedAt: null, inFlight: false };
let setsCache    = { data: null, fetchedAt: null, inFlight: false };
let youtubeCache = { data: null, fetchedAt: null, inFlight: false };
let newsCache    = { data: null, fetchedAt: null, inFlight: false };
const cardsCache = new Map();

// ── Watchlist ──────────────────────────────────────────────────────────────
const WATCHLIST = [
  { name: 'Rayquaza VMAX Alt Art',   pwQuery: 'Rayquaza VMAX Alternate Art',    set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '217/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Umbreon VMAX Alt Art',    pwQuery: 'Umbreon VMAX Alt Art',            set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '215/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Sylveon VMAX Alt Art',    pwQuery: 'Sylveon VMAX Alt Art',            set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '212/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina V Alt Art',      pwQuery: 'Giratina V Alt Art Lost Origin',  set: 'Lost Origin',          setCode: 'SWSH11', cardNumber: '201/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina VSTAR Alt Art',  pwQuery: 'Giratina VSTAR 201',              set: 'Lost Origin',          setCode: 'SWSH11', cardNumber: '201/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Mew VMAX Alt Art',        pwQuery: 'Mew VMAX Alt Art',                set: 'Fusion Strike',        setCode: 'SWSH08', cardNumber: '268/264', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Lugia V Alt Art',         pwQuery: 'Lugia V Alt Art',                 set: 'Silver Tempest',       setCode: 'SWSH12', cardNumber: '186/195', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Charizard ex Hyper Rare', pwQuery: 'Charizard ex Obsidian Flames',    set: 'Obsidian Flames',      setCode: 'OBF',    cardNumber: '228/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Charizard ex SIR',        pwQuery: 'Charizard ex Obsidian Flames',    set: 'Obsidian Flames',      setCode: 'OBF',    cardNumber: '223/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Umbreon ex SIR',          pwQuery: 'Umbreon ex Prismatic Evolutions', set: 'Prismatic Evolutions', setCode: 'PRE',    cardNumber: '232/243', pwCardNumber: '161/131', cycle: 'post-release', signal: 'watch' },
  { name: 'Espeon ex SIR',           pwQuery: 'Espeon ex Prismatic Evolutions',  set: 'Prismatic Evolutions', setCode: 'PRE',    cardNumber: '236/243', pwCardNumber: '155/131', cycle: 'post-release', signal: 'watch' },
  { name: 'Pikachu ex Hyper Rare',   pwQuery: 'Pikachu ex Prismatic Evolutions', set: 'Prismatic Evolutions', setCode: 'PRE',    cardNumber: '244/243', pwCardNumber: '179/131', cycle: 'post-release', signal: 'watch' },
];

const SET_CYCLES = [
  { set: 'Evolving Skies',       stage: 'rotation-boom', note: 'Out of print · no reprint risk · SWSH era closed' },
  { set: 'Lost Origin',          stage: 'rotation-boom', note: 'Giratina supply tightening · rotated 2026' },
  { set: 'Fusion Strike',        stage: 'rotation-boom', note: 'Mew VMAX out of print · prices climbing' },
  { set: 'Silver Tempest',       stage: 'rotation-boom', note: 'Lugia V AA · supply drying fast' },
  { set: 'Obsidian Flames',      stage: 'supply-dryup',  note: 'Rotated April 2026 · Charizard ex floor forming' },
  { set: 'Prismatic Evolutions', stage: 'post-release',  note: 'Still printing heavily · accumulate the dip' },
];

const NEWS_SOURCES = [
  // RSS feeds that work server-side
  { name: 'Bulbapedia',    url: 'https://bulbapedia.bulbagarden.net/w/api.php?hidebots=1&urlversion=1&days=7&limit=50&action=feedrecentchanges&feedformat=rss', type: 'rss'  },
  // HTML scrape (pokemon.com/serebii serve HTML; pokebeach/limitless have no public RSS)
  { name: 'Pokémon.com',   url: 'https://www.pokemon.com/us/pokemon-news/',  type: 'html' },
  { name: 'Serebii',       url: 'https://www.serebii.net/news/',              type: 'html' },
  { name: 'Limitless TCG', url: 'https://limitlesstcg.com/',                  type: 'html' },
  { name: 'PokéBeach',     url: 'https://www.pokebeach.com/',                 type: 'html' },
];

// ── Utilities ─────────────────────────────────────────────────────────────
function numericPart(n) { return n.split('/')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Price fetching: PokeTrace (primary) → PokéWallet (fallback) → TCGdex ──

async function fetchPT(card) {
  if (!PT_KEY) return null;
  const q = `${card.name} ${numericPart(card.cardNumber)}`;
  try {
    const res = await fetch(
      `${PT_BASE}/cards?search=${encodeURIComponent(q)}&set=${encodeURIComponent(card.setCode)}&number=${encodeURIComponent(card.cardNumber)}&market=US&limit=10`,
      { headers: { 'X-API-Key': PT_KEY } }
    );
    if (!res.ok) {
      if (res.status === 429) console.warn(`[PT] Rate limited for ${card.name}`);
      return null;
    }
    const data = await res.json();
    for (const r of (data.data || [])) {
      const num      = (r.number || r.card_number || '').toString();
      const code     = (r.set_id || r.setCode    || '').toString().toUpperCase();
      const numMatch = num === card.cardNumber || num === numericPart(card.cardNumber);
      const setMatch = !code || code === card.setCode.toUpperCase();
      if (numMatch && setMatch) {
        const tiers = r.priceTiers || r.price_tiers || [];
        const raw   = tiers.find(t => (t.tier || t.name || '').toLowerCase().includes('raw'));
        const price = raw?.marketPrice || raw?.market_price;
        if (price) return { price, source: 'PokeTrace' };
      }
    }
  } catch(e) { console.error('[PT] fetch error:', e.message); }
  return null;
}

async function fetchPW(card) {
  if (!PW_KEY) return null;
  const q = card.pwQuery;
  try {
    const res = await fetch(`${PW_BASE}/search?q=${encodeURIComponent(q)}&limit=25`, {
      headers: { 'X-API-Key': PW_KEY }
    });
    if (!res.ok) {
      if (res.status === 429) console.warn(`[PW] Rate limited for ${card.name}`);
      else console.warn(`[PW] HTTP ${res.status} for ${card.name}`);
      return null;
    }
    const data    = await res.json();
    const results = data.results || [];
    if (results.length === 0) return null;

    const getPrice = (r) => {
      const prices = r.tcgplayer?.prices || [];
      const best   = prices.find(p => p.sub_type_name === 'Holofoil') || prices[0];
      return best?.market_price || null;
    };

    const wantNums = new Set([
      card.cardNumber, numericPart(card.cardNumber),
      ...(card.pwCardNumber ? [card.pwCardNumber, numericPart(card.pwCardNumber)] : [])
    ]);

    for (const r of results) {
      const num  = (r.card_info?.card_number || '').toString();
      const code = (r.card_info?.set_code    || '').toString().toUpperCase();
      if (wantNums.has(num) && code === card.setCode.toUpperCase()) {
        const price = getPrice(r);
        if (price) return { price, source: 'PokéWallet' };
      }
    }
    for (const r of results) {
      const num = (r.card_info?.card_number || '').toString();
      if (wantNums.has(num)) {
        const price = getPrice(r);
        if (price) return { price, source: 'PokéWallet' };
      }
    }
    if (results.length === 1) {
      const price = getPrice(results[0]);
      if (price) return { price, source: 'PokéWallet' };
    }
  } catch(e) { console.error('[PW] fetch error:', e.message); }
  return null;
}

async function fetchTCGdex(card) {
  // TCGdex is a card-database API with no pricing — used to confirm card existence
  try {
    const setId = card.setCode.toLowerCase();
    const num   = numericPart(card.cardNumber);
    const res   = await fetch(`${TCGDEX_BASE}/cards/${setId}/${num}`);
    if (!res.ok) return null;
    // No price data available from TCGdex
    return null;
  } catch(e) { return null; }
}

// ── Supabase price logging ────────────────────────────────────────────────
async function logPricesToSupabase(cards) {
  if (!supabase) return;
  const rows = cards
    .filter(c => c.price !== null)
    .map(c => ({
      card_id:     `${c.setCode.toLowerCase()}-${c.cardNumber.replace('/', '-')}`,
      card_name:   c.name,
      price:       c.price,
      source:      c.source,
      recorded_at: new Date().toISOString(),
    }));
  if (!rows.length) return;
  const { error } = await supabase.from('card_prices').insert(rows);
  if (error) console.error('[supabase] insert error:', error.message);
  else console.log(`[supabase] logged ${rows.length} price rows`);
}

// ── Score / target helpers ────────────────────────────────────────────────
function buyTarget(price, cycle) {
  if (!price) return null;
  if (cycle === 'supply-dryup')  return parseFloat((price * 0.92).toFixed(2));
  if (cycle === 'post-release')  return parseFloat((price * 0.88).toFixed(2));
  if (cycle === 'rotation-boom') return parseFloat((price * 0.94).toFixed(2));
  return null;
}

function signalScore(cycle) {
  if (cycle === 'rotation-boom') return 91;
  if (cycle === 'supply-dryup')  return 78;
  return 62;
}

// ── Fetch all prices ──────────────────────────────────────────────────────
async function fetchAllPrices() {
  const results = [];
  for (let i = 0; i < WATCHLIST.length; i++) {
    const card = WATCHLIST[i];
    if (i > 0) await sleep(1000);
    // Priority: PokeTrace → PokéWallet → TCGdex (TCGdex has no prices; structural fallback only)
    let data = await fetchPT(card);
    if (!data) { await sleep(300); data = await fetchPW(card); }
    if (!data) { data = await fetchTCGdex(card); }
    results.push({
      name:       card.name,
      set:        card.set,
      setCode:    card.setCode,
      cardNumber: card.cardNumber,
      cycle:      card.cycle,
      signal:     card.signal,
      price:      data?.price  || null,
      source:     data?.source || null,
      buyTarget:  buyTarget(data?.price, card.cycle),
      score:      signalScore(card.cycle),
    });
    console.log(`[price] ${card.name}: ${data?.price ? '$' + data.price + ' (' + data.source + ')' : 'no price'}`);
  }
  return results;
}

async function refreshPriceCache() {
  if (priceCache.inFlight) return;
  priceCache.inFlight = true;
  console.log('[price cache] Starting refresh…');
  try {
    const cards = await fetchAllPrices();
    priceCache.data      = { cards, cycles: SET_CYCLES, updated: new Date().toISOString() };
    priceCache.fetchedAt = Date.now();
    console.log('[price cache] Refresh complete.');
    // Log to Supabase asynchronously — don't block response
    logPricesToSupabase(cards).catch(e => console.error('[supabase] async error:', e.message));
  } catch(e) {
    console.error('[price cache] Refresh failed:', e.message);
  } finally {
    priceCache.inFlight = false;
  }
}

// ── Google Trends ─────────────────────────────────────────────────────────
function runTrendsScript(keywords) {
  return new Promise((resolve) => {
    execFile(PYTHON, ['trends.py', ...keywords], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[trends] Script error:', err.message, stderr);
        resolve({});
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch(e) { console.error('[trends] JSON parse error:', e.message); resolve({}); }
    });
  });
}

async function refreshTrendsCache() {
  if (trendsCache.inFlight) return;
  trendsCache.inFlight = true;
  console.log('[trends cache] Starting refresh…');
  try {
    const keywords = WATCHLIST.map(c => c.name);
    const raw = await runTrendsScript(keywords);
    trendsCache.data      = raw;
    trendsCache.fetchedAt = Date.now();
    console.log('[trends cache] Refresh complete.');
  } catch(e) {
    console.error('[trends cache] Refresh failed:', e.message);
  } finally {
    trendsCache.inFlight = false;
  }
}

// ── YouTube buzz detection ────────────────────────────────────────────────
async function fetchYouTubeBuzzForCard(cardName) {
  if (!YT_KEY) return [];
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const searchRes = await fetch(
      `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(cardName + ' pokemon card')}&type=video&publishedAfter=${sevenDaysAgo}&maxResults=50&key=${YT_KEY}`
    );
    if (!searchRes.ok) {
      console.warn(`[youtube] Search HTTP ${searchRes.status} for "${cardName}"`);
      return [];
    }
    const searchData = await searchRes.json();
    if (searchData.error) {
      console.warn(`[youtube] API error: ${searchData.error.message}`);
      return [];
    }
    const videoIds = (searchData.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return [];

    const statsRes = await fetch(
      `${YT_BASE}/videos?part=snippet,statistics&id=${videoIds.join(',')}&key=${YT_KEY}`
    );
    if (!statsRes.ok) return [];
    const statsData = await statsRes.json();

    return (statsData.items || [])
      .filter(v => parseInt(v.statistics?.viewCount || 0) >= 10000)
      .map(v => ({
        videoId:     v.id,
        title:       v.snippet.title,
        channel:     v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        viewCount:   parseInt(v.statistics.viewCount),
        url:         `https://www.youtube.com/watch?v=${v.id}`,
      }))
      .sort((a, b) => b.viewCount - a.viewCount);
  } catch(e) {
    console.error(`[youtube] error for "${cardName}":`, e.message);
    return [];
  }
}

async function refreshYoutubeCache() {
  if (youtubeCache.inFlight) return;
  youtubeCache.inFlight = true;
  console.log('[youtube] Starting buzz refresh…');
  try {
    const result = {};
    for (let i = 0; i < WATCHLIST.length; i++) {
      if (i > 0) await sleep(500);
      const card = WATCHLIST[i];
      result[card.name] = await fetchYouTubeBuzzForCard(card.name);
    }
    youtubeCache.data      = result;
    youtubeCache.fetchedAt = Date.now();
    const total = Object.values(result).reduce((s, v) => s + v.length, 0);
    console.log(`[youtube] Refresh complete. ${total} buzz videos found.`);
  } catch(e) {
    console.error('[youtube] Refresh failed:', e.message);
  } finally {
    youtubeCache.inFlight = false;
  }
}

// ── News intelligence ─────────────────────────────────────────────────────
const NEWS_UA = 'Mozilla/5.0 (compatible; HitRate-Intelligence/1.0)';

async function fetchFeedLenient(url) {
  // Try standard RSS parse first; fall back to raw-fetch + amp-fix for malformed feeds
  try {
    return await rssParser.parseURL(url);
  } catch(_) {}
  try {
    const res = await fetch(url, { headers: { 'User-Agent': NEWS_UA } });
    if (!res.ok) return null;
    let xml = await res.text();
    // Fix bare & not part of a valid named/numeric entity
    xml = xml.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
    return await rssParser.parseString(xml);
  } catch(e) {
    return null;
  }
}

async function fetchNewsAlerts() {
  const watchTerms = [...new Set([
    ...WATCHLIST.map(c => c.name.toLowerCase()),
    ...WATCHLIST.map(c => c.set.toLowerCase()),
  ])];

  const alerts  = [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const source of NEWS_SOURCES) {
    try {
      if (source.type === 'html') {
        // Simple HTML scrape — fetch page, strip tags, search for watchlist terms
        const res = await fetch(source.url, { headers: { 'User-Agent': NEWS_UA } });
        if (!res.ok) { console.warn(`[news] ${source.name}: HTTP ${res.status}`); continue; }
        const html = await res.text();
        const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        for (const term of watchTerms) {
          if (text.includes(term)) {
            alerts.push({
              source:      source.name,
              headline:    `${source.name} mentions "${term}"`,
              url:         source.url,
              publishedAt: new Date().toISOString(),
              matchedTerm: term,
            });
          }
        }
        continue;
      }

      // RSS / Atom mode with lenient fallback
      const feed = await fetchFeedLenient(source.url);
      if (!feed) { console.warn(`[news] ${source.name}: could not parse feed`); continue; }

      for (const item of (feed.items || [])) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        if (pubDate < weekAgo) continue;
        const text    = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`.toLowerCase();
        const matched = watchTerms.find(t => text.includes(t));
        if (matched) {
          alerts.push({
            source:      source.name,
            headline:    item.title || '(no title)',
            url:         item.link  || null,
            publishedAt: item.pubDate || new Date().toISOString(),
            matchedTerm: matched,
          });
        }
      }
    } catch(e) {
      console.warn(`[news] Failed to fetch ${source.name}: ${e.message}`);
    }
  }

  alerts.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return alerts;
}

async function refreshNewsCache() {
  if (newsCache.inFlight) return;
  newsCache.inFlight = true;
  console.log('[news] Starting refresh…');
  try {
    newsCache.data      = await fetchNewsAlerts();
    newsCache.fetchedAt = Date.now();
    console.log(`[news] Refresh complete. ${newsCache.data.length} alerts found.`);
  } catch(e) {
    console.error('[news] Refresh failed:', e.message);
  } finally {
    newsCache.inFlight = false;
  }
}

// ── Pokemon TCG Developer API helpers ─────────────────────────────────────
function tcgHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (TCG_KEY) h['X-Api-Key'] = TCG_KEY;
  return h;
}

async function tcgFetchAllSets() {
  const res = await fetch(`${TCG_BASE}/sets?orderBy=releaseDate&pageSize=250`, { headers: tcgHeaders() });
  if (!res.ok) throw new Error(`TCG sets HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || [])
    .filter(s => s.legalities)
    .map(s => ({
      id:           s.id,
      name:         s.name,
      series:       s.series,
      releaseDate:  s.releaseDate,
      total:        s.total,
      printedTotal: s.printedTotal,
      ptcgoCode:    s.ptcgoCode || null,
    }));
}

async function tcgFetchAllCards(setId) {
  const cards = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${TCG_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&page=${page}&pageSize=250&orderBy=number`,
      { headers: tcgHeaders() }
    );
    if (!res.ok) throw new Error(`TCG cards HTTP ${res.status}`);
    const json  = await res.json();
    const batch = json.data || [];
    for (const c of batch) {
      cards.push({ id: c.id, name: c.name, number: c.number, rarity: c.rarity || null, supertype: c.supertype || null });
    }
    if (batch.length < 250) break;
    page++;
  }
  return cards;
}

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/watchlist', async (req, res) => {
  const now        = Date.now();
  const priceStale = !priceCache.fetchedAt || (now - priceCache.fetchedAt) > PRICE_TTL_MS;
  if (priceStale && !priceCache.inFlight) refreshPriceCache();

  if (priceCache.data) {
    const cards = priceCache.data.cards.map(c => ({
      ...c,
      trend: trendsCache.data?.[c.name] || null,
    }));
    return res.json({
      ...priceCache.data,
      cards,
      cacheAge:   priceCache.fetchedAt ? Math.round((now - priceCache.fetchedAt) / 1000) : null,
      refreshing: priceCache.inFlight,
    });
  }

  while (priceCache.inFlight || !priceCache.data) await sleep(500);
  const cards = priceCache.data.cards.map(c => ({
    ...c,
    trend: trendsCache.data?.[c.name] || null,
  }));
  res.json({ ...priceCache.data, cards, cacheAge: 0, refreshing: false });
});

// Alias
app.get('/api/prices', (req, res) => res.redirect(307, '/api/watchlist'));

app.get('/api/youtube', async (req, res) => {
  const now   = Date.now();
  const stale = !youtubeCache.fetchedAt || (now - youtubeCache.fetchedAt) > YOUTUBE_TTL_MS;
  if (stale && !youtubeCache.inFlight) refreshYoutubeCache();
  res.json({
    data:      youtubeCache.data || {},
    fetchedAt: youtubeCache.fetchedAt ? new Date(youtubeCache.fetchedAt).toISOString() : null,
    inFlight:  youtubeCache.inFlight,
  });
});

app.get('/api/news', async (req, res) => {
  const now   = Date.now();
  const stale = !newsCache.fetchedAt || (now - newsCache.fetchedAt) > NEWS_TTL_MS;
  if (stale && !newsCache.inFlight) refreshNewsCache();
  res.json({
    alerts:    newsCache.data || [],
    fetchedAt: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null,
    inFlight:  newsCache.inFlight,
  });
});

app.get('/api/trends', async (req, res) => {
  const now         = Date.now();
  const trendsStale = !trendsCache.fetchedAt || (now - trendsCache.fetchedAt) > TRENDS_TTL_MS;
  if (trendsStale && !trendsCache.inFlight) refreshTrendsCache();
  res.json({
    data:      trendsCache.data || {},
    fetchedAt: trendsCache.fetchedAt ? new Date(trendsCache.fetchedAt).toISOString() : null,
    inFlight:  trendsCache.inFlight,
  });
});

app.get('/api/cache-status', (req, res) => {
  const now = Date.now();
  const age = (cache) => cache.fetchedAt ? Math.round((now - cache.fetchedAt) / 1000) : null;
  res.json({
    price:   { hasCachedData: !!priceCache.data,   fetchedAt: priceCache.fetchedAt   ? new Date(priceCache.fetchedAt).toISOString()   : null, ageSeconds: age(priceCache),   ttlSeconds: PRICE_TTL_MS/1000,    inFlight: priceCache.inFlight   },
    trends:  { hasCachedData: !!trendsCache.data,  fetchedAt: trendsCache.fetchedAt  ? new Date(trendsCache.fetchedAt).toISOString()  : null, ageSeconds: age(trendsCache),  ttlSeconds: TRENDS_TTL_MS/1000,   inFlight: trendsCache.inFlight  },
    youtube: { hasCachedData: !!youtubeCache.data, fetchedAt: youtubeCache.fetchedAt ? new Date(youtubeCache.fetchedAt).toISOString() : null, ageSeconds: age(youtubeCache), ttlSeconds: YOUTUBE_TTL_MS/1000,  inFlight: youtubeCache.inFlight },
    news:    { hasCachedData: !!newsCache.data,    fetchedAt: newsCache.fetchedAt    ? new Date(newsCache.fetchedAt).toISOString()    : null, ageSeconds: age(newsCache),    ttlSeconds: NEWS_TTL_MS/1000,     inFlight: newsCache.inFlight    },
  });
});

app.post('/api/refresh', async (req, res) => {
  if (priceCache.inFlight) return res.json({ ok: false, message: 'Refresh already in progress' });
  priceCache.fetchedAt = null;
  refreshPriceCache();
  res.json({ ok: true, message: 'Price cache refresh started' });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/sets', async (req, res) => {
  const now   = Date.now();
  const stale = !setsCache.fetchedAt || (now - setsCache.fetchedAt) > TCG_SETS_TTL_MS;
  if (!stale && setsCache.data) return res.json({ sets: setsCache.data, cached: true, fetchedAt: new Date(setsCache.fetchedAt).toISOString() });
  if (setsCache.inFlight) {
    while (setsCache.inFlight) await sleep(200);
    return res.json({ sets: setsCache.data || [], cached: true });
  }
  setsCache.inFlight = true;
  try {
    const sets = await tcgFetchAllSets();
    setsCache.data = sets; setsCache.fetchedAt = Date.now();
    res.json({ sets, cached: false, fetchedAt: new Date(setsCache.fetchedAt).toISOString() });
  } catch(e) {
    console.error('[TCG] sets error:', e.message);
    if (setsCache.data) return res.json({ sets: setsCache.data, cached: true, error: e.message });
    res.status(502).json({ error: 'Failed to fetch sets', detail: e.message });
  } finally { setsCache.inFlight = false; }
});

app.get('/api/sets/:setId/cards', async (req, res) => {
  const { setId } = req.params;
  const now    = Date.now();
  const cached = cardsCache.get(setId);
  const stale  = !cached || (now - cached.fetchedAt) > TCG_SETS_TTL_MS;
  if (!stale && cached) return res.json({ setId, cards: cached.data, cached: true, fetchedAt: new Date(cached.fetchedAt).toISOString() });
  try {
    const cards = await tcgFetchAllCards(setId);
    cardsCache.set(setId, { data: cards, fetchedAt: Date.now() });
    res.json({ setId, cards, cached: false, fetchedAt: new Date(Date.now()).toISOString() });
  } catch(e) {
    console.error(`[TCG] cards error for ${setId}:`, e.message);
    if (cached) return res.json({ setId, cards: cached.data, cached: true, error: e.message });
    res.status(502).json({ error: `Failed to fetch cards for set ${setId}`, detail: e.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Startup ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HitRate Intelligence running on port ${PORT}`);
  refreshPriceCache();
  setTimeout(refreshTrendsCache,  5000);   // trends after 5 s
  setTimeout(refreshYoutubeCache, 12000);  // YouTube buzz after 12 s
  setTimeout(refreshNewsCache,    18000);  // news after 18 s
});
