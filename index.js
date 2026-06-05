const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PW_KEY = process.env.POKEWALLET_KEY;
const PT_KEY = process.env.POKETRACE_KEY;
const PW_BASE = 'https://api.pokewallet.io';
const PT_BASE = 'https://api.poketrace.com/v1';

const WATCHLIST = [
  { name: 'Rayquaza VMAX Alt Art',   set: 'Evolving Skies',       pwQuery: 'Rayquaza VMAX',   ptQuery: 'rayquaza vmax',          cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Umbreon VMAX Alt Art',    set: 'Evolving Skies',       pwQuery: 'Umbreon VMAX',    ptQuery: 'umbreon vmax',           cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Sylveon VMAX Alt Art',    set: 'Evolving Skies',       pwQuery: 'Sylveon VMAX',    ptQuery: 'sylveon vmax',           cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Giratina V Alt Art',      set: 'Lost Origin',          pwQuery: 'Giratina V',      ptQuery: 'giratina v',             cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Mew VMAX',                set: 'Fusion Strike',        pwQuery: 'Mew VMAX',        ptQuery: 'mew vmax',               cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Lugia V Alt Art',         set: 'Silver Tempest',       pwQuery: 'Lugia V',         ptQuery: 'lugia v',                cycle: 'rotation-boom',  signal: 'rotate' },
  { name: 'Charizard ex SIR',        set: 'Obsidian Flames',      pwQuery: 'Charizard ex',    ptQuery: 'charizard ex obsidian',  cycle: 'supply-dryup',   signal: 'buy'    },
  { name: 'Ninetales SIR',           set: 'Obsidian Flames',      pwQuery: 'Ninetales',       ptQuery: 'ninetales obsidian',     cycle: 'supply-dryup',   signal: 'buy'    },
  { name: 'Umbreon ex SAR',          set: 'Prismatic Evolutions', pwQuery: 'Umbreon ex',      ptQuery: 'umbreon ex prismatic',   cycle: 'post-release',   signal: 'watch'  },
  { name: 'Pikachu ex SAR',          set: 'Prismatic Evolutions', pwQuery: 'Pikachu ex',      ptQuery: 'pikachu ex prismatic',   cycle: 'post-release',   signal: 'watch'  },
  { name: 'Gardevoir ex SAR',        set: 'Scarlet & Violet 151', pwQuery: 'Gardevoir ex',    ptQuery: 'gardevoir ex 151',       cycle: 'supply-dryup',   signal: 'buy'    },
  { name: 'Charizard ex SAR',        set: 'Scarlet & Violet 151', pwQuery: 'Charizard ex',    ptQuery: 'charizard ex 151',       cycle: 'supply-dryup',   signal: 'buy'    },
];

const SET_CYCLES = [
  { set: 'Evolving Skies',       stage: 'rotation-boom',       note: 'Out of print · no reprint risk · SWSH era closed' },
  { set: 'Lost Origin',          stage: 'rotation-boom',       note: 'Giratina supply tightening · rotated 2026' },
  { set: 'Fusion Strike',        stage: 'rotation-boom',       note: 'Mew VMAX out of print · prices climbing' },
  { set: 'Silver Tempest',       stage: 'rotation-boom',       note: 'Lugia V AA · supply drying fast' },
  { set: 'Obsidian Flames',      stage: 'supply-dryup',        note: 'Rotated April 2026 · Charizard ex SIR floor forming' },
  { set: 'Crown Zenith',         stage: 'pre-discontinuation', note: 'Galarian Gallery · print run ending soon' },
  { set: 'Scarlet & Violet 151', stage: 'supply-dryup',        note: 'Demand outpacing supply · reprint unlikely' },
  { set: 'Prismatic Evolutions', stage: 'post-release',        note: 'Still printing heavily · accumulate the dip' },
];

async function fetchPW(query) {
  if (!PW_KEY) return null;
  try {
    const res = await fetch(`${PW_BASE}/search?q=${encodeURIComponent(query)}&limit=10`, {
      headers: { 'X-API-Key': PW_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const card of (data.results || [])) {
      const prices = card.tcgplayer?.prices || [];
      const best = prices.find(p => p.sub_type_name === 'Holofoil') || prices.find(p => p.sub_type_name === 'Normal') || prices[0];
      if (best?.market_price) return { price: best.market_price, low: best.low_price, high: best.high_price, source: 'PokéWallet' };
    }
  } catch(e) {}
  return null;
}

async function fetchPT(query) {
  if (!PT_KEY) return null;
  try {
    const res = await fetch(`${PT_BASE}/cards?search=${encodeURIComponent(query)}&market=US&limit=5`, {
      headers: { 'X-API-Key': PT_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const card of (data.data || [])) {
      const tiers = card.priceTiers || card.price_tiers || [];
      const raw = tiers.find(t => (t.tier || t.name || '').toLowerCase().includes('raw'));
      const price = raw?.marketPrice || raw?.market_price;
      if (price) return { price, source: 'PokeTrace' };
    }
  } catch(e) {}
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

app.get('/api/watchlist', async (req, res) => {
  const results = [];
  for (const card of WATCHLIST) {
    let data = await fetchPW(card.pwQuery);
    if (!data) data = await fetchPT(card.ptQuery);
    results.push({
      name:      card.name,
      set:       card.set,
      cycle:     card.cycle,
      signal:    card.signal,
      price:     data?.price || null,
      source:    data?.source || null,
      buyTarget: buyTarget(data?.price, card.cycle),
      score:     signalScore(card.cycle),
    });
  }
  res.json({ cards: results, cycles: SET_CYCLES, updated: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HitRate Intelligence running on port ${PORT}`);
});
