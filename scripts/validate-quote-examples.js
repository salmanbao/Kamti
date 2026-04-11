#!/usr/bin/env node

/**
 * Universal Swap Request Examples Validator
 * 
 * This script validates all example requests from UNIVERSAL_SWAP_REQUEST_EXAMPLES.md
 * against the actual API to ensure they work correctly.
 */

const axios = require('axios');

// Configuration
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';
const ENDPOINT = '/universal-swap/quote';
const DELAY_BETWEEN_REQUESTS = 2000; // 2 seconds to avoid rate limiting

// -------- Helpers for analytics & pretty printing --------
function truncate(str, len = 24) {
  if (str === null || str === undefined) return '';
  const s = String(str);
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function avg(nums) {
  if (!nums || nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function toPct(val, digits = 2) {
  if (typeof val !== 'number' || !isFinite(val)) return '-';
  return `${val.toFixed(digits)}%`;
}

function sortEntriesDesc(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
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
  dogecoin: 'D8AXXiGEZeZnMKTKnC9AWB3YUU4jfMAmYU',
  litecoin: 'ltc1q46m2f9sxghgp5xpuyfgpjwpvt923udmuj7s4m2',
};

// Programmatic example generation based on enabled chains/tokens in unified config
// Mirror of enabled deployments (Phase 1) to avoid importing TS config in Node
const ENABLED = {
  chains: {
    ethereum: { chainId: 1, ecosystem: 'evm' },
    bsc: { chainId: 56, ecosystem: 'evm' },
    avalanche: { chainId: 43114, ecosystem: 'evm' },
    solana: { chainId: 'solana-mainnet', ecosystem: 'solana' },
    bitcoin: { chainId: 'bitcoin-mainnet', ecosystem: 'bitcoin' },
    litecoin: { chainId: 'litecoin-mainnet', ecosystem: 'bitcoin' }, // Litecoin uses bitcoin ecosystem (UTXO-based)
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
      // tron mainnet excluded due to missing wallet in this script
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
  // amount provided as integer number of whole tokens
  return (BigInt(amount) * pow).toString();
}

const DEFAULT_AMOUNTS = {
  // whole token amounts
  SOL: 10,
  ETH: 1,
  BNB: 5,
  AVAX: 20,
  SHIB: 10000000, // 10M SHIB
  USDT: 1000,
  USDC: 1000,
  BTC: 1, // 1 BTC (will be scaled to 1e8); we will override to 0.1 below
  LTC: 5,
};

const ECOSYSTEM_WALLETS = {
  evm: TEST_WALLETS.evm,
  solana: TEST_WALLETS.solana,
  bitcoin: TEST_WALLETS.bitcoin,
};

// Chain-specific wallets for chains that share ecosystems but have different address formats
const CHAIN_SPECIFIC_WALLETS = {
  'litecoin-mainnet': TEST_WALLETS.litecoin,
  'bitcoin-mainnet': TEST_WALLETS.bitcoin,
  'dogecoin-mainnet': TEST_WALLETS.dogecoin,
};

function makeToken(symbol, chainKey) {
  const chain = ENABLED.chains[chainKey];
  return { symbol, chain: { chainId: chain.chainId, ecosystem: chain.ecosystem } };
}

function amountFor(symbol, chainKey) {
  const tokenDeploy = ENABLED.tokens[symbol].find(t => t.chain === chainKey);
  const whole = DEFAULT_AMOUNTS[symbol] || 1;
  // Special: BTC 0.1
  const adjustedWhole = symbol === 'BTC' ? 0.1 : whole;
  if (Number.isInteger(adjustedWhole)) {
    return toUnits(adjustedWhole, tokenDeploy.decimals);
  }
  // handle 0.1 like values
  const [intPart, fracPart = ''] = String(adjustedWhole).split('.');
  const fracScaled = (fracPart + '0'.repeat(tokenDeploy.decimals)).slice(0, tokenDeploy.decimals);
  return (BigInt(intPart || '0') * (BigInt(10) ** BigInt(tokenDeploy.decimals)) + BigInt(fracScaled)).toString();
}

function takerFor(chainKey) {
  // First check if there's a chain-specific wallet
  const chainId = ENABLED.chains[chainKey]?.chainId;
  if (chainId && CHAIN_SPECIFIC_WALLETS[chainId]) {
    return CHAIN_SPECIFIC_WALLETS[chainId];
  }
  // Fall back to ecosystem wallet
  const eco = ENABLED.chains[chainKey].ecosystem;
  return ECOSYSTEM_WALLETS[eco] || TEST_WALLETS.evm;
}

function recipientFor(chainKey) {
  // First check if there's a chain-specific wallet
  const chainId = ENABLED.chains[chainKey]?.chainId;
  if (chainId && CHAIN_SPECIFIC_WALLETS[chainId]) {
    return CHAIN_SPECIFIC_WALLETS[chainId];
  }
  // Fall back to ecosystem wallet
  const eco = ENABLED.chains[chainKey].ecosystem;
  return ECOSYSTEM_WALLETS[eco] || TEST_WALLETS.evm;
}

function chainKeyFromRef(ref) {
  const entries = Object.entries(ENABLED.chains);
  const found = entries.find(([k, v]) => v.chainId === ref.chain.chainId && v.ecosystem === ref.chain.ecosystem);
  return found ? found[0] : null;
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
  // Add recipient for cross-ecosystem to be safe
  if (srcEco !== dstEco) {
    base.request.recipient = recipientFor(dstKey || 'ethereum');
  }
  if (opts.preferredBridges) base.request.preferredBridges = opts.preferredBridges;
  cases.push(base);
}

function generateTestCases() {
  const cases = [];

  // 1) Same-chain combinations
  // Ethereum: ETH, USDT, USDC, SHIB
  const ethTokens = ['ETH', 'USDT', 'USDC', 'SHIB'];
  ethTokens.forEach(sellSym => {
    ethTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      const sell = makeToken(sellSym, 'ethereum');
      const buy = makeToken(buySym, 'ethereum');
      addCase(cases, `${sellSym} → ${buySym} (Ethereum)`, sell, buy, amountFor(sellSym, 'ethereum'));
    });
  });

  // BSC: BNB, USDT, USDC
  const bscTokens = ['BNB', 'USDT', 'USDC'];
  bscTokens.forEach(sellSym => {
    bscTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      const sell = makeToken(sellSym, 'bsc');
      const buy = makeToken(buySym, 'bsc');
      addCase(cases, `${sellSym} → ${buySym} (BSC)`, sell, buy, amountFor(sellSym, 'bsc'));
    });
  });

  // Solana: SOL, USDC, USDT
  const solTokens = ['SOL', 'USDC', 'USDT'];
  solTokens.forEach(sellSym => {
    solTokens.forEach(buySym => {
      if (sellSym === buySym) return;
      const sell = makeToken(sellSym, 'solana');
      const buy = makeToken(buySym, 'solana');
      addCase(cases, `${sellSym} → ${buySym} (Solana)`, sell, buy, amountFor(sellSym, 'solana'));
    });
  });

  // 2) Cross-chain same-token routes (USDT, USDC) among Ethereum, BSC, Solana
  const stableTokens = ['USDT', 'USDC'];
  const stableChains = ['ethereum', 'bsc', 'solana'];
  for (let i = 0; i < stableChains.length; i++) {
    for (let j = 0; j < stableChains.length; j++) {
      if (i === j) continue;
      const from = stableChains[i];
      const to = stableChains[j];
      stableTokens.forEach(sym => {
        const sell = makeToken(sym, from);
        const buy = makeToken(sym, to);
        addCase(
          cases,
          `${sym} (${from}) → ${sym} (${to}) - Cross-Chain`,
          sell,
          buy,
          amountFor(sym, from),
          { preferredBridges: to === 'solana' || from === 'solana' ? ['wormhole', 'allbridge'] : undefined }
        );
      });
    }
  }

  // 3) Cross-chain native-to-native between EVM chains
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
      const sell = makeToken(s.sym, s.chain);
      const buy = makeToken(b.sym, b.chain);
      addCase(cases, `${s.sym} (${s.chain}) → ${b.sym} (${b.chain}) - Cross-Chain`, sell, buy, amountFor(s.sym, s.chain), { slippage: 100 });
    }
  }

  // 4) Bitcoin ecosystem cross-chain
  // BTC → ETH/USDT/USDC (to Ethereum)
  ['ETH', 'USDT', 'USDC'].forEach(dst => {
    const sell = makeToken('BTC', 'bitcoin');
    const buy = makeToken(dst, 'ethereum');
    addCase(cases, `BTC → ${dst} (Cross-Chain)`, sell, buy, amountFor('BTC', 'bitcoin'), { slippage: 100 });
  });

  // LTC → BTC (Bitcoin ecosystem) and LTC → ETH (Cross-chain)
  addCase(cases, 'LTC → BTC (Cross-Chain)', makeToken('LTC', 'litecoin'), makeToken('BTC', 'bitcoin'), amountFor('LTC', 'litecoin'), { slippage: 100 });
  addCase(cases, 'LTC → ETH (Cross-Chain)', makeToken('LTC', 'litecoin'), makeToken('ETH', 'ethereum'), amountFor('LTC', 'litecoin'), { slippage: 100 });

  return cases;
}

const testCases = generateTestCases();

// Results tracking
const results = {
  passed: [],
  failed: [],
  errors: []
};

/**
 * Make API request and validate response
 */
async function testRequest(testCase) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${testCase.name}`);
  console.log(`${'='.repeat(80)}`);
  console.log('Request:', JSON.stringify(testCase.request, null, 2));

  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${API_BASE_URL}${ENDPOINT}`,
      testCase.request,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 seconds timeout
      }
    );
    const duration = Date.now() - startTime;

    // Extract the actual data from the wrapped response
    const responseData = response.data.data || response.data;

    console.log(`✅ Success (${duration}ms)`);
    console.log('Response Status:', response.status);
    console.log('Swap Type:', responseData.swapType);
    console.log('Routes Found:', responseData.routes?.length || 0);
    
    if (responseData.recommendedRoute) {
      console.log('Recommended Route:');
      console.log('  - Provider:', responseData.recommendedRoute.provider);
      console.log('  - Output Amount:', responseData.recommendedRoute.outputAmount);
      console.log('  - Estimated Gas:', responseData.recommendedRoute.estimatedGas);
      console.log('  - Quality Score:', responseData.recommendedRoute.qualityScore);
      console.log('  - Estimated Time:', responseData.recommendedRoute.estimatedTime, 'seconds');
    }

    if (responseData.warnings && responseData.warnings.length > 0) {
      console.log('⚠️  Warnings:', responseData.warnings);
    }

    // Validate response structure
    const validationErrors = validateResponse(responseData, testCase);
    if (validationErrors.length > 0) {
      console.log('❌ Validation Errors:', validationErrors);
      results.failed.push({
        name: testCase.name,
        errors: validationErrors,
        response: responseData
      });
    } else {
      results.passed.push({
        name: testCase.name,
        duration,
        response: responseData
      });
    }

  } catch (error) {
    console.log(`❌ Failed`);
    
    if (error.response) {
      console.log('Error Status:', error.response.status);
      console.log('Error Data:', JSON.stringify(error.response.data, null, 2));
      
      results.errors.push({
        name: testCase.name,
        status: error.response.status,
        error: error.response.data,
        request: testCase.request
      });
    } else if (error.request) {
      console.log('No response received:', error.message);
      results.errors.push({
        name: testCase.name,
        error: 'No response from server',
        message: error.message,
        request: testCase.request
      });
    } else {
      console.log('Error:', error.message);
      results.errors.push({
        name: testCase.name,
        error: error.message,
        request: testCase.request
      });
    }
  }
}

/**
 * Validate response structure
 */
function validateResponse(response, testCase) {
  const errors = [];

  // Check required fields
  if (!response.swapType) {
    errors.push('Missing swapType');
  }

  if (!response.routes || !Array.isArray(response.routes)) {
    errors.push('Missing or invalid routes array');
  }

  if (!response.recommendedRoute) {
    errors.push('Missing recommendedRoute');
  } else {
    // Validate recommended route structure
    const route = response.recommendedRoute;
    if (!route.provider) errors.push('Route missing provider');
    if (!route.outputAmount) errors.push('Route missing outputAmount');
    if (!route.estimatedGas) errors.push('Route missing estimatedGas');
    if (!route.steps || !Array.isArray(route.steps)) errors.push('Route missing steps array');
    if (typeof route.estimatedTime !== 'number') errors.push('Route missing estimatedTime');
    if (typeof route.qualityScore !== 'number') errors.push('Route missing qualityScore');
  }

  return errors;
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate validation report
 */
function generateReport() {
  console.log('\n\n');
  console.log('='.repeat(100));
  console.log('UNIVERSAL SWAP QUOTE VALIDATION — ANALYTICS REPORT');
  console.log('='.repeat(100));

  // ---------- Build analytics from results ----------
  const total = testCases.length;
  const passCount = results.passed.length;
  const failCount = results.failed.length;
  const errorCount = results.errors.length;
  const successRate = total ? Math.round((passCount / total) * 10000) / 100 : 0;

  const passedDurations = results.passed.map(p => p.duration);
  const avgDurationMs = avg(passedDurations);

  const swapTypeDist = {};
  const providerFreq = {};
  const routesCounts = [];
  const qualityScores = [];
  const etas = [];

  results.passed.forEach(p => {
    const resp = p.response || {};
    const rr = resp.recommendedRoute || {};
    if (resp.swapType) swapTypeDist[resp.swapType] = (swapTypeDist[resp.swapType] || 0) + 1;
    if (rr.provider) providerFreq[rr.provider] = (providerFreq[rr.provider] || 0) + 1;
    routesCounts.push(safeNumber(resp.routes?.length || 0));
    if (typeof rr.qualityScore === 'number') qualityScores.push(rr.qualityScore);
    if (typeof rr.estimatedTime === 'number') etas.push(rr.estimatedTime);
  });

  const avgRoutes = avg(routesCounts);
  const avgQuality = avg(qualityScores);
  const avgEta = avg(etas);

  // ---------- Summary Table ----------
  console.log('\nSUMMARY');
  console.table([
    { Metric: 'Total Tests', Value: total },
    { Metric: 'Passed', Value: passCount },
    { Metric: 'Failed (Validation)', Value: failCount },
    { Metric: 'Errors (HTTP/API)', Value: errorCount },
    { Metric: 'Success Rate', Value: `${successRate}%` },
    { Metric: 'Avg Duration (ms)', Value: avgDurationMs },
    { Metric: 'Avg Routes Found', Value: avgRoutes },
    { Metric: 'Avg Quality Score', Value: avgQuality || '-' },
    { Metric: 'Avg ETA (s)', Value: avgEta || '-' },
  ]);

  // ---------- Distributions ----------
  if (Object.keys(swapTypeDist).length > 0) {
    console.log('\nSWAP TYPE DISTRIBUTION');
    console.table(Object.entries(swapTypeDist).map(([type, count]) => ({ SwapType: type, Count: count })));
  }

  if (Object.keys(providerFreq).length > 0) {
    const topProviders = sortEntriesDesc(providerFreq).map(([prov, cnt]) => ({ Provider: prov, Count: cnt }));
    console.log('\nTOP RECOMMENDED PROVIDERS');
    console.table(topProviders);
  }

  // ---------- Detailed Tables ----------
  if (results.passed.length > 0) {
    const passedRows = results.passed.map(p => {
      const resp = p.response || {};
      const rr = resp.recommendedRoute || {};
      return {
        Name: truncate(p.name, 34),
        SwapType: resp.swapType || '-',
        Routes: resp.routes?.length || 0,
        Provider: rr.provider || '-',
        Output: truncate(rr.outputAmount || '-'),
        Gas: truncate(rr.estimatedGas || '-'),
        Quality: typeof rr.qualityScore === 'number' ? rr.qualityScore : '-',
        ETA_s: typeof rr.estimatedTime === 'number' ? rr.estimatedTime : '-',
        Duration_ms: p.duration
      };
    });
    console.log('\n✅ PASSED TESTS');
    console.table(passedRows);
  }

  if (results.failed.length > 0) {
    const failedRows = results.failed.map(f => {
      const resp = f.response || {};
      const errStr = Array.isArray(f.errors) ? f.errors.join(' | ') : String(f.errors || '');
      return {
        Name: truncate(f.name, 34),
        SwapType: resp.swapType || '-',
        Routes: resp.routes?.length || 0,
        Errors: truncate(errStr, 120)
      };
    });
    console.log('\n❌ FAILED TESTS (Validation Errors)');
    console.table(failedRows);
  }

  if (results.errors.length > 0) {
    const errorRows = results.errors.map(e => {
      let code = '-';
      let message = '-';
      if (e.error && typeof e.error === 'object') {
        code = e.error.code || e.error?.error?.code || e.error?.error || '-';
        message = e.error.message || e.error?.error?.message || e.error?.error || '-';
      } else if (e.error) {
        message = String(e.error);
      }
      return {
        Name: truncate(e.name, 34),
        Status: e.status || '-',
        Code: truncate(code, 32),
        Message: truncate(message, 120)
      };
    });
    console.log('\n⚠️  TESTS WITH ERRORS (HTTP/API)');
    console.table(errorRows);
  }

  // ---------- Suggested Corrections (raw payloads) ----------
  if (results.errors.length > 0 || results.failed.length > 0) {
    console.log('\n' + '='.repeat(100));
    console.log('SUGGESTED CORRECTIONS');
    console.log('='.repeat(100));
    [...results.errors, ...results.failed].forEach(result => {
      console.log(`\n// ${result.name}`);
      if (result.error && typeof result.error === 'object') {
        console.log('// Error:', result.error.message || result.error.code || result.error);
        if (result.error.details) {
          console.log('// Details:', result.error.details);
        }
      }
      console.log('// Original request:');
      console.log(JSON.stringify(result.request, null, 2));
    });
  }

  // ---------- Footer ----------
  console.log('\n' + '='.repeat(100));
  console.log(`Success Rate: ${successRate}%`);
  console.log('='.repeat(100));

  // Exit with appropriate code
  process.exit(results.errors.length > 0 || results.failed.length > 0 ? 1 : 0);
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('Universal Swap Request Examples Validator');
  console.log(`API Base URL: ${API_BASE_URL}`);
  console.log(`Total Tests: ${testCases.length}`);
  console.log('\n');

  // Check if server is running
  try {
    await axios.get(`${API_BASE_URL}/health`, { timeout: 5000 });
    console.log('✅ Server is running\n');
  } catch (error) {
    console.log('❌ Server is not responding. Please start the server first.');
    console.log('   Run: pnpm run start:dev\n');
    process.exit(1);
  }

  // Run tests sequentially with delay
  for (let i = 0; i < testCases.length; i++) {
    await testRequest(testCases[i]);
    
    // Add delay between requests (except for last one)
    if (i < testCases.length - 1) {
      console.log(`\nWaiting ${DELAY_BETWEEN_REQUESTS}ms before next request...`);
      await sleep(DELAY_BETWEEN_REQUESTS);
    }
  }

  // Generate final report
  generateReport();
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
