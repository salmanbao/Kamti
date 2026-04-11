#!/usr/bin/env node
const fs = require('fs');

const content = fs.readFileSync('./scripts/check-evm-execute.js', 'utf8');
const lines = content.split('\n');

const combos = [];
let current = null;
let inArray = false;
let inSell = false;
let inBuy = false;

function pushCurrent() {
  if (!current) return;
  // Only push if we have at least sell and buy token with symbol/ecosystem/chainId
  const s = current.sellToken || {};
  const b = current.buyToken || {};
  if (s.symbol && s.ecosystem && s.chainId && b.symbol && b.ecosystem && b.chainId) {
    combos.push(current);
  }
  current = null;
}

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const line = raw.trim();

  if (line.includes('const SWAP_COMBINATIONS = [')) { inArray = true; continue; }
  if (!inArray) continue;
  if (inArray && line === '];') { pushCurrent(); break; }

  // Start of a new combination when we see an index line
  if (line.startsWith('index:')) {
    pushCurrent();
    const m = line.match(/index:\s*(\d+)/);
    current = { index: m ? parseInt(m[1], 10) : undefined, sellToken: {}, buyToken: {} };
    inSell = false; inBuy = false;
    continue;
  }

  if (!current) continue;

  // Detect sellToken/buyToken object entries
  if (line.startsWith('sellToken:')) { inSell = true; inBuy = false; }
  if (line.startsWith('buyToken:')) { inBuy = true; inSell = false; }

  // Capture symbol
  const sym = line.match(/symbol:\s*'([^']+)'/);
  if (sym) {
    if (inSell) current.sellToken.symbol = sym[1];
    if (inBuy) current.buyToken.symbol = sym[1];
  }

  // Capture ecosystem
  const eco = line.match(/ecosystem:\s*'([^']+)'/);
  if (eco) {
    if (inSell) current.sellToken.ecosystem = eco[1];
    if (inBuy) current.buyToken.ecosystem = eco[1];
  }

  // Capture chainId (may be number or string)
  const cid = line.match(/chainId:\s*([^,\s}]+)/);
  if (cid) {
    const val = cid[1].replace(/[',]/g, '');
    if (inSell) current.sellToken.chainId = val;
    if (inBuy) current.buyToken.chainId = val;
  }
}

// Build duplicate map by exact pair key
const map = new Map();
for (const c of combos) {
  const key = `${c.sellToken.symbol}|${c.sellToken.ecosystem}|${c.sellToken.chainId}->${c.buyToken.symbol}|${c.buyToken.ecosystem}|${c.buyToken.chainId}`;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(c.index);
}

const duplicates = [];
for (const [key, indices] of map.entries()) {
  if (indices.length > 1) duplicates.push({ key, indices: indices.sort((a,b)=>a-b) });
}

console.log('\n=== Duplicate Combination Analysis (Exact Sell->Buy Pair) ===');
console.log(`Total combos parsed: ${combos.length}`);
if (duplicates.length === 0) {
  console.log('✓ No exact duplicate combinations found.');
} else {
  console.log(`❌ Found ${duplicates.length} duplicate pair group(s):\n`);
  duplicates.forEach((d, i) => console.log(`${i+1}. ${d.key} at indices [${d.indices.join(', ')}]`));
}
