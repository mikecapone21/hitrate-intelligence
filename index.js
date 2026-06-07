const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const { execFile } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PW_KEY  = process.env.POKEWALLET_KEY;
const PT_KEY  = process.env.POKETRACE_KEY;
const TCG_KEY = process.env.POKEMONTCG_KEY;
const PW_BASE  = 'https://api.pokewallet.io';
const PT_BASE  = 'https://api.poketrace.com/v1';
const TCG_BASE = 'https://api.pokemontcg.io/v2';

const PYTHON  = '/nix/store/flbj8bq2vznkcwss7sm0ky8rd0k6kar7-python-wrapped-0.1.0/bin/python3';

// Price cache: refresh every 30 min to stay within hourly API limits
const PRICE_TTL_MS  = 30 * 60 * 1000;
// Trends cache: refresh every 6 hours (Google Trends data moves slowly)
const TRENDS_TTL_MS = 6 * 60 * 60 * 1000;

let priceCache  = { data: null, fetchedAt: null, inFlight: false };
let trendsCache = { data: null, fetchedAt: null, inFlight: false };

// TCG sets cache: 24 h (sets are released infrequently)
const TCG_SETS_TTL_MS = 24 * 60 * 60 * 1000;
let setsCache = { data: null, fetchedAt: null, inFlight: false };

// Per-set cards cache: keyed by setId, 24 h
const cardsCache = new Map(); // setId → { data, fetchedAt }

const WATCHLIST = [
  { name: 'Rayquaza VMAX Alt Art',  pwQuery: 'Rayquaza VMAX Alternate Art',    set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '217/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Umbreon VMAX Alt Art',   pwQuery: 'Umbreon VMAX Alt Art',            set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '215/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Sylveon VMAX Alt Art',   pwQuery: 'Sylveon VMAX Alt Art',            set: 'Evolving Skies',       setCode: 'SWSH07', cardNumber: '212/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina V Alt Art',     pwQuery: 'Giratina V Alt Art Lost Origin',    set: 'Lost Origin',          setCode: 'SWSH11', cardNumber: '201/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina VSTAR Alt Art', pwQuery: 'Giratina VSTAR 201',                   set: 'Lost Origin',          setCode: 'SWSH11', cardNumber: '201/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Mew VMAX Alt Art',       pwQuery: 'Mew VMAX Alt Art',                 set: 'Fusion Strike',        setCode: 'SWSH08', cardNumber: '268/264', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Lugia V Alt Art',        pwQuery: 'Lugia V Alt Art',                  set: 'Silver Tempest',       setCode: 'SWSH12', cardNumber: '186/195', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Charizard ex Hyper Rare', pwQuery: 'Charizard ex Obsidian Flames',     set: 'Obsidian Flames',      setCode: 'OBF',    cardNumber: '228/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Charizard ex SIR',       pwQuery: 'Charizard ex Obsidian Flames',     set: 'Obsidian Flames',      setCode: 'OBF',    cardNumber: '223/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Umbreon ex SIR',         pwQuery: 'Umbreon ex Prismatic Evolutions',  set: 'Prismatic Evolutions', setCode: 'PRE', cardNumber: '232/243', pwCardNumber: '161/131', cycle: 'post-release',  signal: 'watch'  },
  { name: 'Espeon ex SIR',          pwQuery: 'Espeon ex Prismatic Evolutions',   set: 'Prismatic Evolutions', setCode: 'PRE', cardNumber: '236/243', pwCardNumber: '155/131', cycle: 'post-release',  signal: 'watch'  },
  { name: 'Pikachu ex Hyper Rare',  pwQuery: 'Pikachu ex Prismatic Evolutions',  set: 'Prismatic Evolutions', setCode: 'PRE', cardNumber: '244/243', pwCardNumber: '179/131', cycle: 'post-release',  signal: 'watch'  },
];

const SET_CYCLES = [
  { set: 'Evolving Skies',       stage: 'rotation-boom', note: 'Out of print · no reprint risk · SWSH era closed' },
  { set: 'Lost Origin',          stage: 'rotation-boom', note: 'Giratina supply tightening · rotated 2026' },
  { set: 'Fusion Strike',        stage: 'rotation-boom', note: 'Mew VMAX out of print · prices climbing' },
  { set: 'Silver Tempest',       stage: 'rotation-boom', note: 'Lugia V AA · supply drying fast' },
  { set: 'Obsidian Flames',      stage: 'supply-dryup',  note: 'Rotated April 2026 · Charizard ex SIR & SAR floor forming' },
  { set: 'Prismatic Evolutions', stage: 'post-release',  note: 'Still printing heavily · accumulate the dip' },
];

function numericPart(n) { return n.split('/')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Price fetching ──────────────────────────────────────────────────────────

async function fetchPW(card) {
  if (!PW_KEY) return null;
  // Use the curated pwQuery (name-only — appending card numbers breaks PW search)
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

    // Build the list of card numbers to match (TCGPlayer + optional PW-specific numbering)
    const wantNums = new Set([
      card.cardNumber, numericPart(card.cardNumber),
      ...(card.pwCardNumber ? [card.pwCardNumber, numericPart(card.pwCardNumber)] : [])
    ]);

    // Priority 1: set code + card number exact match
    for (const r of results) {
      const num  = (r.card_info?.card_number || '').toString();
      const code = (r.card_info?.set_code    || '').toString().toUpperCase();
      if (wantNums.has(num) && code === card.setCode.toUpperCase()) {
        const price = getPrice(r);
        if (price) return { price, source: 'PokéWallet' };
      }
    }
    // Priority 2: card number match only (set code may differ between PW and TCGPlayer)
    for (const r of results) {
      const num = (r.card_info?.card_number || '').toString();
      if (wantNums.has(num)) {
        const price = getPrice(r);
        if (price) return { price, source: 'PokéWallet' };
      }
    }
    // Priority 3: single-result queries are highly specific — use as fallback
    if (results.length === 1) {
      const price = getPrice(results[0]);
      if (price) return { price, source: 'PokéWallet' };
    }
  } catch(e) { console.error('[PW] fetch error:', e.message); }
  return null;
}

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
      const num     = (r.number || r.card_number || '').toString();
      const code    = (r.set_id || r.setCode    || '').toString().toUpperCase();
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

async function fetchAllPrices() {
  const results = [];
  for (let i = 0; i < WATCHLIST.length; i++) {
    const card = WATCHLIST[i];
    if (i > 0) await sleep(1000);
    let data = await fetchPW(card);
    if (!data) { await sleep(500); data = await fetchPT(card); }
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
    console.log(`[price] ${card.name}: ${data?.price ? '$' + data.price : 'no price'}`);
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
  } catch(e) {
    console.error('[price cache] Refresh failed:', e.message);
  } finally {
    priceCache.inFlight = false;
  }
}

// ── Google Trends fetching ──────────────────────────────────────────────────

function runTrendsScript(keywords) {
  return new Promise((resolve) => {
    execFile(PYTHON, ['trends.py', ...keywords], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[trends] Script error:', err.message, stderr);
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch(e) {
        console.error('[trends] JSON parse error:', e.message, stdout);
        resolve({});
      }
    });
  });
}

async function refreshTrendsCache() {
  if (trendsCache.inFlight) return;
  trendsCache.inFlight = true;
  console.log('[trends cache] Starting refresh…');
  try {
    // Use simplified search terms for better Google Trends matches
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

// ── Pokemon TCG Developer API helpers ───────────────────────────────────────

function tcgHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (TCG_KEY) h['X-Api-Key'] = TCG_KEY;
  return h;
}

async function tcgFetchAllSets() {
  const res = await fetch(
    `${TCG_BASE}/sets?q=legalities.standard:legal OR legalities.expanded:legal OR legalities.unlimited:legal&orderBy=releaseDate&pageSize=250`,
    { headers: tcgHeaders() }
  );
  if (!res.ok) throw new Error(`TCG sets HTTP ${res.status}`);
  const json = await res.json();
  // Also fetch a second pass without the legality filter to get all sets ever
  const res2 = await fetch(`${TCG_BASE}/sets?orderBy=releaseDate&pageSize=250`, { headers: tcgHeaders() });
  if (!res2.ok) throw new Error(`TCG sets (all) HTTP ${res2.status}`);
  const json2 = await res2.json();
  const all = json2.data || json.data || [];
  return all
    .filter(s => s.legalities) // English sets always have legalities; filters out some non-English
    .map(s => ({
      id:          s.id,
      name:        s.name,
      series:      s.series,
      releaseDate: s.releaseDate,
      total:       s.total,
      printedTotal: s.printedTotal,
      ptcgoCode:   s.ptcgoCode || null,
    }));
}

async function tcgFetchAllCards(setId) {
  const cards = [];
  let page = 1;
  const pageSize = 250;
  while (true) {
    const res = await fetch(
      `${TCG_BASE}/cards?q=set.id:${encodeURIComponent(setId)}&page=${page}&pageSize=${pageSize}&orderBy=number`,
      { headers: tcgHeaders() }
    );
    if (!res.ok) throw new Error(`TCG cards HTTP ${res.status}`);
    const json = await res.json();
    const batch = json.data || [];
    for (const c of batch) {
      cards.push({
        id:         c.id,
        name:       c.name,
        number:     c.number,
        rarity:     c.rarity     || null,
        supertype:  c.supertype  || null,
      });
    }
    if (batch.length < pageSize) break;
    page++;
  }
  return cards;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/sets — all English sets ever released
app.get('/api/sets', async (req, res) => {
  const now = Date.now();
  const stale = !setsCache.fetchedAt || (now - setsCache.fetchedAt) > TCG_SETS_TTL_MS;

  if (!stale && setsCache.data) return res.json({ sets: setsCache.data, cached: true, fetchedAt: new Date(setsCache.fetchedAt).toISOString() });

  if (setsCache.inFlight) {
    // Wait for in-flight request to finish
    while (setsCache.inFlight) await sleep(200);
    return res.json({ sets: setsCache.data || [], cached: true, fetchedAt: setsCache.fetchedAt ? new Date(setsCache.fetchedAt).toISOString() : null });
  }

  setsCache.inFlight = true;
  try {
    const sets = await tcgFetchAllSets();
    setsCache.data      = sets;
    setsCache.fetchedAt = Date.now();
    res.json({ sets, cached: false, fetchedAt: new Date(setsCache.fetchedAt).toISOString() });
  } catch (e) {
    console.error('[TCG] sets error:', e.message);
    if (setsCache.data) return res.json({ sets: setsCache.data, cached: true, error: e.message });
    res.status(502).json({ error: 'Failed to fetch sets from Pokemon TCG API', detail: e.message });
  } finally {
    setsCache.inFlight = false;
  }
});

// GET /api/sets/:setId/cards — all cards in a set
app.get('/api/sets/:setId/cards', async (req, res) => {
  const { setId } = req.params;
  const now = Date.now();
  const cached = cardsCache.get(setId);
  const stale  = !cached || (now - cached.fetchedAt) > TCG_SETS_TTL_MS;

  if (!stale && cached) return res.json({ setId, cards: cached.data, cached: true, fetchedAt: new Date(cached.fetchedAt).toISOString() });

  try {
    const cards = await tcgFetchAllCards(setId);
    cardsCache.set(setId, { data: cards, fetchedAt: Date.now() });
    res.json({ setId, cards, cached: false, fetchedAt: new Date(Date.now()).toISOString() });
  } catch (e) {
    console.error(`[TCG] cards error for ${setId}:`, e.message);
    if (cached) return res.json({ setId, cards: cached.data, cached: true, error: e.message });
    res.status(502).json({ error: `Failed to fetch cards for set ${setId}`, detail: e.message });
  }
});

app.get('/api/watchlist', async (req, res) => {
  const now       = Date.now();
  const priceStale = !priceCache.fetchedAt || (now - priceCache.fetchedAt) > PRICE_TTL_MS;

  if (priceStale && !priceCache.inFlight) refreshPriceCache();

  if (priceCache.data) {
    // Merge in trend data if available
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

  // First ever load — wait
  while (priceCache.inFlight || !priceCache.data) await sleep(500);
  const cards = priceCache.data.cards.map(c => ({
    ...c,
    trend: trendsCache.data?.[c.name] || null,
  }));
  res.json({ ...priceCache.data, cards, cacheAge: 0, refreshing: false });
});

app.get('/api/trends', async (req, res) => {
  const now         = Date.now();
  const trendsStale = !trendsCache.fetchedAt || (now - trendsCache.fetchedAt) > TRENDS_TTL_MS;
  if (trendsStale && !trendsCache.inFlight) refreshTrendsCache();
  res.json({
    data:       trendsCache.data || {},
    fetchedAt:  trendsCache.fetchedAt ? new Date(trendsCache.fetchedAt).toISOString() : null,
    inFlight:   trendsCache.inFlight,
  });
});

app.get('/api/cache-status', (req, res) => {
  const now = Date.now();
  res.json({
    price: {
      hasCachedData: !!priceCache.data,
      fetchedAt:     priceCache.fetchedAt ? new Date(priceCache.fetchedAt).toISOString() : null,
      ageSeconds:    priceCache.fetchedAt ? Math.round((now - priceCache.fetchedAt) / 1000) : null,
      ttlSeconds:    PRICE_TTL_MS / 1000,
      inFlight:      priceCache.inFlight,
    },
    trends: {
      hasCachedData: !!trendsCache.data,
      fetchedAt:     trendsCache.fetchedAt ? new Date(trendsCache.fetchedAt).toISOString() : null,
      ageSeconds:    trendsCache.fetchedAt ? Math.round((now - trendsCache.fetchedAt) / 1000) : null,
      ttlSeconds:    TRENDS_TTL_MS / 1000,
      inFlight:      trendsCache.inFlight,
    },
  });
});

app.post('/api/refresh', async (req, res) => {
  if (priceCache.inFlight) return res.json({ ok: false, message: 'Refresh already in progress' });
  priceCache.fetchedAt = null;
  refreshPriceCache();
  res.json({ ok: true, message: 'Price cache refresh started' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HitRate Intelligence running on port ${PORT}`);
  refreshPriceCache();
  // Start trends fetch in background after a short delay to not block startup
  setTimeout(refreshTrendsCache, 5000);
});
