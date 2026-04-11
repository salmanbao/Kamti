#!/usr/bin/env node

/**
 * Universal Swap Pre-Check Examples Validator
 *
 * This script generates comprehensive pre-check requests from enabled
 * chains/tokens (Phase 1 mirror) and validates the /universal-swap/pre-check endpoint.
 */

const axios = require('axios');

// Configuration
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';
const ENDPOINT = '/universal-swap/pre-check';
const DELAY_BETWEEN_REQUESTS = 1500; // reduce slightly vs quotes

// -------- Helpers --------
function truncate(str, len = 24) {
  if (str === null || str === undefined) return '';
  const s = String(str);
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function avg(nums) {
  if (!nums || nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function safeNumber(n, fallback = 0) {
  const num = Number(n);
  return Number.isFinite(num) ? num : fallback;
}

// Test wallets (DO NOT USE IN PRODUCTION)
const TEST_WALLETS = {
  evm: '0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5',
  solana: 'ChVhatMXYJYSyPEaFETCg6CJBnoyT12WpYShH8DrSc1p',
  bitcoin: 'bc1qe3u6nmpk797jfswcvnnv2ham8wpenvh83de2w3',
  litecoin: 'ltc1q46m2f9sxghgp5xpuyfgpjwpvt923udmuj7s4m2',
};

// Mirror of enabled deployments (Phase 1)
const ENABLED = {
  chains: {
    ethereum: { chainId: 1, ecosystem: 'evm' },
    bsc: { chainId: 56, ecosystem: 'evm' },
    avalanche: { chainId: 43114, ecosystem: 'evm' },
    solana: { chainId: 'solana-mainnet', ecosystem: 'solana' },
    bitcoin: { chainId: 'bitcoin-mainnet', ecosystem: 'bitcoin' },
    litecoin: { chainId: 'litecoin-mainnet', ecosystem: 'bitcoin' },
  },
  tokens: {
    SOL: [{ chain: 'solana', decimals: 9 }],
    ETH: [{ chain: 'ethereum', decimals: 18 }],
    BNB: [{ chain: 'bsc', decimals: 18 }],
    AVAX: [{ chain: 'avalanche', decimals: 18 }],
    SHIB: [{ chain: 'ethereum', decimals: 18 }],
    USDT: [
      { chain: 'ethereum', decimals: 6 },
      { chain: 'bsc', decimals: 18 },
      { chain: 'solana', decimals: 6 },
    ],
    USDC: [
      { chain: 'ethereum', decimals: 6 },
      { chain: 'bsc', decimals: 18 },
      { chain: 'solana', decimals: 6 },
    ],
    BTC: [{ chain: 'bitcoin', decimals: 8 }],
    LTC: [{ chain: 'litecoin', decimals: 8 }],
  },
};

function toUnits(amount, decimals) {
  const pow = BigInt(10) ** BigInt(decimals);
  return (BigInt(amount) * pow).toString();
}

const DEFAULT_AMOUNTS = {
  SOL: 10,
  ETH: 1,
  BNB: 5,
  AVAX: 20,
  SHIB: 10000000,
  USDT: 1000,
  USDC: 1000,
  BTC: 1,
  LTC: 5,
};

const ECOSYSTEM_WALLETS = {
  evm: TEST_WALLETS.evm,
  solana: TEST_WALLETS.solana,
  bitcoin: TEST_WALLETS.bitcoin,
};

function makeToken(symbol, chainKey) {
  const chain = ENABLED.chains[chainKey];
  return { symbol, chain: { chainId: chain.chainId, ecosystem: chain.ecosystem } };
}

function amountFor(symbol, chainKey) {
  const tokenDeploy = ENABLED.tokens[symbol].find(t => t.chain === chainKey);
  const whole = DEFAULT_AMOUNTS[symbol] || 1;
  const adjustedWhole = symbol === 'BTC' ? 0.1 : whole;
  if (Number.isInteger(adjustedWhole)) {
    return toUnits(adjustedWhole, tokenDeploy.decimals);
  }
  const [intPart, fracPart = ''] = String(adjustedWhole).split('.');
  const fracScaled = (fracPart + '0'.repeat(tokenDeploy.decimals)).slice(0, tokenDeploy.decimals);
  return (BigInt(intPart || '0') * (BigInt(10) ** BigInt(tokenDeploy.decimals)) + BigInt(fracScaled)).toString();
}

function chainKeyFromRef(ref) {
  const entries = Object.entries(ENABLED.chains);
  const found = entries.find(([k, v]) => v.chainId === ref.chain.chainId && v.ecosystem === ref.chain.ecosystem);
  return found ? found[0] : null;
}

function takerFor(chainKey) {
  const eco = ENABLED.chains[chainKey].ecosystem;
  return ECOSYSTEM_WALLETS[eco] || TEST_WALLETS.evm;
}

function recipientFor(chainKey) {
  const eco = ENABLED.chains[chainKey].ecosystem;
  return ECOSYSTEM_WALLETS[eco] || TEST_WALLETS.evm;
}

function addCase(cases, name, sell, buy, sellAmount, opts = {}) {
  const srcEco = sell.chain.ecosystem;
  const dstEco = buy.chain.ecosystem;
  const srcKey = chainKeyFromRef(sell);
  const dstKey = chainKeyFromRef(buy);
  const base = {
    name,
    request: {
      sellToken: sell,
      buyToken: buy,
      sellAmount,
      taker: takerFor(srcKey || 'ethereum'),
      slippageToleranceBps: opts.slippage || (srcEco === dstEco ? 50 : 100),
    },
  };
  if (srcEco !== dstEco) {
    base.request.recipient = recipientFor(dstKey || 'ethereum');
  }
  if (opts.preferredBridges) base.request.preferredBridges = opts.preferredBridges;
  cases.push(base);
}

function generateTestCases() {
  const cases = [];

  // Same-chain
  const ethTokens = ['ETH', 'USDT', 'USDC', 'SHIB'];
  ethTokens.forEach(sellSym => {
    ethTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      addCase(
        cases,
        `${sellSym} → ${buySym} (Ethereum)`,
        makeToken(sellSym, 'ethereum'),
        makeToken(buySym, 'ethereum'),
        amountFor(sellSym, 'ethereum')
      );
    });
  });

  const bscTokens = ['BNB', 'USDT', 'USDC'];
  bscTokens.forEach(sellSym => {
    bscTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      addCase(
        cases,
        `${sellSym} → ${buySym} (BSC)`,
        makeToken(sellSym, 'bsc'),
        makeToken(buySym, 'bsc'),
        amountFor(sellSym, 'bsc')
      );
    });
  });

  const solTokens = ['SOL', 'USDC', 'USDT'];
  solTokens.forEach(sellSym => {
    solTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      addCase(
        cases,
        `${sellSym} → ${buySym} (Solana)`,
        makeToken(sellSym, 'solana'),
        makeToken(buySym, 'solana'),
        amountFor(sellSym, 'solana')
      );
    });
  });

  // Cross-chain same-token stables between ETH/BSC/SOL
  const stableTokens = ['USDT', 'USDC'];
  const stableChains = ['ethereum', 'bsc', 'solana'];
  for (let i = 0; i < stableChains.length; i++) {
    for (let j = 0; j < stableChains.length; j++) {
      if (i === j) continue;
      const from = stableChains[i];
      const to = stableChains[j];
      stableTokens.forEach(sym => {
        addCase(
          cases,
          `${sym} (${from}) → ${sym} (${to}) - Cross-Chain`,
          makeToken(sym, from),
          makeToken(sym, to),
          amountFor(sym, from),
          { preferredBridges: to === 'solana' || from === 'solana' ? ['wormhole', 'allbridge'] : undefined }
        );
      });
    }
  }

  // EVM native-to-native cross-chain
  const evmNatives = [
    { sym: 'ETH', chain: 'ethereum' },
    { sym: 'BNB', chain: 'bsc' },
    { sym: 'AVAX', chain: 'avalanche' },
  ];
  for (let i = 0; i < evmNatives.length; i++) {
    for (let j = 0; j < evmNatives.length; j++) {
      if (i === j) continue;
      const s = evmNatives[i];
      const b = evmNatives[j];
      addCase(
        cases,
        `${s.sym} (${s.chain}) → ${b.sym} (${b.chain}) - Cross-Chain`,
        makeToken(s.sym, s.chain),
        makeToken(b.sym, b.chain),
        amountFor(s.sym, s.chain),
        { slippage: 100 }
      );
    }
  }

  // Bitcoin ecosystem
  ['ETH', 'USDT', 'USDC'].forEach(dst => {
    addCase(
      cases,
      `BTC → ${dst} (Cross-Chain)`,
      makeToken('BTC', 'bitcoin'),
      makeToken(dst, 'ethereum'),
      amountFor('BTC', 'bitcoin'),
      { slippage: 100 }
    );
  });

  addCase(
    cases,
    'LTC → BTC (Cross-Chain)',
    makeToken('LTC', 'litecoin'),
    makeToken('BTC', 'bitcoin'),
    amountFor('LTC', 'litecoin'),
    { slippage: 100 }
  );
  addCase(
    cases,
    'LTC → ETH (Cross-Chain)',
    makeToken('LTC', 'litecoin'),
    makeToken('ETH', 'ethereum'),
    amountFor('LTC', 'litecoin'),
    { slippage: 100 }
  );

  return cases;
}

const testCases = generateTestCases();

// Results tracking
const results = {
  passed: [],
  failed: [],
  errors: []
};

async function testRequest(testCase) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing (pre-check): ${testCase.name}`);
  console.log(`${'='.repeat(80)}`);
  console.log('Request:', JSON.stringify(testCase.request, null, 2));

  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${API_BASE_URL}${ENDPOINT}`,
      testCase.request,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const duration = Date.now() - startTime;

    const responseData = response.data.data || response.data; // unwrap if interceptor wraps

    console.log(`✅ Success (${duration}ms)`);
    console.log('Response Status:', response.status);
    console.log('parametersValid:', responseData.parametersValid, 'liquidityAvailable:', responseData.liquidityAvailable);

    // Validate structure
    const validationErrors = validateResponse(responseData, testCase);
    if (validationErrors.length > 0) {
      console.log('❌ Validation Errors:', validationErrors);
      results.failed.push({ name: testCase.name, errors: validationErrors, response: responseData });
    } else {
      results.passed.push({ name: testCase.name, duration, response: responseData });
    }
  } catch (error) {
    console.log('❌ Failed');
    if (error.response) {
      console.log('Error Status:', error.response.status);
      console.log('Error Data:', JSON.stringify(error.response.data, null, 2));
      results.errors.push({ name: testCase.name, status: error.response.status, error: error.response.data, request: testCase.request });
    } else if (error.request) {
      console.log('No response received:', error.message);
      results.errors.push({ name: testCase.name, error: 'No response from server', message: error.message, request: testCase.request });
    } else {
      console.log('Error:', error.message);
      results.errors.push({ name: testCase.name, error: error.message, request: testCase.request });
    }
  }
}

function validateResponse(resp, testCase) {
  const errs = [];
  const mustBool = ['parametersValid', 'liquidityAvailable', 'approvalRequired', 'sufficientBalance'];
  mustBool.forEach(k => {
    if (typeof resp[k] !== 'boolean') errs.push(`Missing/invalid ${k}`);
  });
  if (!('warnings' in resp) || !Array.isArray(resp.warnings)) errs.push('Missing/invalid warnings');
  if (!('details' in resp) || typeof resp.details !== 'object') errs.push('Missing/invalid details');
  // providerHealthy may be null or boolean depending on implementation; accept undefined
  if ('providerHealthy' in resp && !(typeof resp.providerHealthy === 'boolean' || resp.providerHealthy === null)) {
    errs.push('Invalid providerHealthy');
  }
  // Optional: details.routing carries swapType/providerCategory
  return errs;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateReport() {
  console.log('\n\n');
  console.log('='.repeat(100));
  console.log('UNIVERSAL SWAP PRE-CHECK — ANALYTICS REPORT');
  console.log('='.repeat(100));

  const total = testCases.length;
  const pass = results.passed.length;
  const fail = results.failed.length;
  const errors = results.errors.length;
  const successRate = total ? Math.round((pass / total) * 10000) / 100 : 0;

  // Aggregate flags from passed results
  const flags = {
    parametersValid: 0,
    liquidityAvailable: 0,
    approvalRequired: 0,
    sufficientBalance: 0,
  };
  const swapTypeDist = {};
  const categoryDist = {};
  const durations = [];

  results.passed.forEach(p => {
    const r = p.response || {};
    if (r.parametersValid) flags.parametersValid++;
    if (r.liquidityAvailable) flags.liquidityAvailable++;
    if (r.approvalRequired) flags.approvalRequired++;
    if (r.sufficientBalance) flags.sufficientBalance++;
    durations.push(p.duration);
    const routing = r.details?.routing || {};
    if (routing.swapType) swapTypeDist[routing.swapType] = (swapTypeDist[routing.swapType] || 0) + 1;
    if (routing.providerCategory) categoryDist[routing.providerCategory] = (categoryDist[routing.providerCategory] || 0) + 1;
  });

  console.log('\nSUMMARY');
  console.table([
    { Metric: 'Total Tests', Value: total },
    { Metric: 'Passed', Value: pass },
    { Metric: 'Failed (Validation)', Value: fail },
    { Metric: 'Errors (HTTP/API)', Value: errors },
    { Metric: 'Success Rate', Value: `${successRate}%` },
    { Metric: 'Avg Duration (ms)', Value: avg(durations) },
    { Metric: 'parametersValid ✅', Value: flags.parametersValid },
    { Metric: 'liquidityAvailable ✅', Value: flags.liquidityAvailable },
    { Metric: 'approvalRequired ⚠️', Value: flags.approvalRequired },
    { Metric: 'sufficientBalance ✅', Value: flags.sufficientBalance },
  ]);

  if (Object.keys(swapTypeDist).length > 0) {
    console.log('\nSWAP TYPE DISTRIBUTION');
    console.table(Object.entries(swapTypeDist).map(([k, v]) => ({ SwapType: k, Count: v })));
  }
  if (Object.keys(categoryDist).length > 0) {
    console.log('\nPROVIDER CATEGORY DISTRIBUTION');
    console.table(Object.entries(categoryDist).map(([k, v]) => ({ Category: k, Count: v })));
  }

  if (results.passed.length > 0) {
    const rows = results.passed.map(p => {
      const r = p.response || {};
      const rt = r.details?.routing || {};
      return {
        Name: truncate(p.name, 40),
        SwapType: rt.swapType || '-',
        Category: rt.providerCategory || '-',
        Params: r.parametersValid,
        Liquidity: r.liquidityAvailable,
        Approval: r.approvalRequired,
        Balance: r.sufficientBalance,
        Duration_ms: p.duration,
        Warnings: (r.warnings || []).length,
      };
    });
    console.log('\n✅ PASSED PRE-CHECKS');
    console.table(rows);
  }

  if (results.failed.length > 0) {
    const rows = results.failed.map(f => ({
      Name: truncate(f.name, 40),
      Errors: truncate(Array.isArray(f.errors) ? f.errors.join(' | ') : String(f.errors || ''), 120),
    }));
    console.log('\n❌ FAILED PRE-CHECKS (Validation Errors)');
    console.table(rows);
  }

  if (results.errors.length > 0) {
    const rows = results.errors.map(e => {
      let code = '-';
      let message = '-';
      if (e.error && typeof e.error === 'object') {
        code = e.error.code || e.error?.error?.code || e.error?.error || '-';
        message = e.error.message || e.error?.error?.message || e.error?.error || '-';
      } else if (e.error) {
        message = String(e.error);
      }
      return { Name: truncate(e.name, 40), Status: e.status || '-', Code: truncate(code, 32), Message: truncate(message, 120) };
    });
    console.log('\n⚠️  HTTP/API ERRORS');
    console.table(rows);
  }

  console.log('\n' + '='.repeat(100));
  console.log(`Success Rate: ${successRate}%`);
  console.log('='.repeat(100));

  process.exit(results.errors.length > 0 || results.failed.length > 0 ? 1 : 0);
}

async function runTests() {
  console.log('Universal Swap Pre-Check Examples Validator');
  console.log(`API Base URL: ${API_BASE_URL}`);
  console.log(`Total Tests: ${testCases.length}`);
  console.log('\n');

  // Health check — controller exposes GET /universal-swap/health
  try {
    await axios.get(`${API_BASE_URL}/universal-swap/health`, { timeout: 5000 });
    console.log('✅ Service is healthy\n');
  } catch (error) {
    console.log('❌ Service is not responding. Please start the server first.');
    console.log('   Run: pnpm run start:dev\n');
    process.exit(1);
  }

  for (let i = 0; i < testCases.length; i++) {
    await testRequest(testCases[i]);
    if (i < testCases.length - 1) {
      console.log(`\nWaiting ${DELAY_BETWEEN_REQUESTS}ms before next request...`);
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  generateReport();
}

runTests().catch(err => { console.error('Fatal error:', err); process.exit(1); });
