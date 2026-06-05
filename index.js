const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PW_KEY = process.env.POKEWALLET_KEY;
const PW_BASE = 'https://api.pokewallet.io';

const WATCHLIST = [
  { name: 'Rayquaza VMAX Alt Art',  set: 'Evolving Skies',       query: 'Rayquaza VMAX',  setCode: 'SWSH07', cardNumber: '217/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Umbreon VMAX Alt Art',   set: 'Evolving Skies',       query: 'Umbreon VMAX',   setCode: 'SWSH07', cardNumber: '215/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Sylveon VMAX Alt Art',   set: 'Evolving Skies',       query: 'Sylveon VMAX',   setCode: 'SWSH07', cardNumber: '212/203', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina V Alt Art',     set: 'Lost Origin',          query: 'Giratina V',     setCode: 'SWSH11', cardNumber: '201/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Giratina VSTAR Alt Art', set: 'Lost Origin',          query: 'Giratina VSTAR', setCode: 'SWSH11', cardNumber: '196/196', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Mew VMAX Alt Art',       set: 'Fusion Strike',        query: 'Mew VMAX',       setCode: 'SWSH08', cardNumber: '268/264', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Lugia V Alt Art',        set: 'Silver Tempest',       query: 'Lugia V',        setCode: 'SWSH12', cardNumber: '186/195', cycle: 'rotation-boom', signal: 'rotate' },
  { name: 'Charizard ex SIR',       set: 'Obsidian Flames',      query: 'Charizard ex',   setCode: 'SV03',   cardNumber: '228/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Charizard ex SAR',       set: 'Obsidian Flames',      query: 'Charizard ex',   setCode: 'SV03',   cardNumber: '223/197', cycle: 'supply-dryup',  signal: 'buy'    },
  { name: 'Umbreon ex SAR',         set: 'Prismatic Evolutions', query: 'Umbreon ex',     setCode: 'PRE',    cardNumber: '232/243', cycle: 'post-release',  signal: 'watch'  },
  { name: 'Espeon ex SAR',          set: 'Prismatic Evolutions', query: 'Espeon ex',      setCode: 'PRE',    cardNumber: '236/243', cycle: 'post-release',  signal: 'watch'  },
  { name: 'Pikachu ex SAR',         set: 'Prismatic Evolutions', query: 'Pikachu ex',     setCode: 'PRE',    cardNumber: '244/243', cycle: 'post-release',  signal: 'watch'  },
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

async function fetchCard(query, setCode, cardNumber) {
  if (!PW_KEY) return null;
  try {
    const res = await fetch(`${PW_BASE}/search?q=${encodeURIComponent(query)}&limit=20`, {
      headers: { 'X-API-Key': PW_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const results = data.results || [];

    for (const card of results) {
      const num = card.card_info?.card_number || '';
      const code = card.card_info?.set_code || '';
      if (num === cardNumber && code === setCode) {
        const price = card.tcgplayer?.prices?.[0]?.market_price;
        if (price) return { price, source: 'PokéWallet' };
      }
    }

    for (const card of results) {
      const num = card.card_info?.card_number || '';
      if (num === cardNumber) {
        const price = card.tcgplayer?.prices?.[0]?.market_price;
        if (price) return { price, source: 'PokéWallet' };
      }
    }

    return null;
  } catch(e) { return null; }
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
    const data = await fetchCard(card.query, card.setCode, card.cardNumber);
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HitRate Intelligence running on port ${PORT}`);
});
