#!/usr/bin/env node
/*
 ROUND-TRIP & MULTI-CHAIN SWAP TEST SCRIPT
 Tests complex swap paths using the universal-swap/execute endpoint
 
 Based on the latest universal-swap controller implementation with:
 - Full token and chain information
 - Automatic token enrichment
 - Cross-chain meta aggregator routing
 - Native token support without gasless flag
 
 SWAP PATHS:
 1. ETH -> SOL -> ETH (Cross-chain round-trip: Ethereum ↔ Solana)
 2. ETH -> BNB -> ETH (Cross-chain round-trip: Ethereum ↔ BSC)
 3. ETH -> BNB -> USDT(Ethereum) (Multi-chain path: Ethereum → BSC → Ethereum)
 4. ETH -> TRX -> ETH (Cross-chain round-trip: Ethereum ↔ Tron)
 5. ETH -> AVAX -> ETH (Cross-chain round-trip: Ethereum ↔ Avalanche)
 6. ETH -> POL -> ETH (Cross-chain round-trip: Ethereum ↔ Polygon)
 7. ETH -> ARB -> ETH (Cross-chain round-trip: Ethereum ↔ Arbitrum)
 8. ETH -> BASE -> ETH (Cross-chain round-trip: Ethereum ↔ Base)

 Usage:
   node scripts/check-round-trip-swaps.js
   
   OR
   
   npm run check:round-trip

 Configuration:
   All settings are configured as constants at the top of the script (lines 38-70):
   
   - SWAP_PATH          : Index of swap path to execute (0-3)
   - USE_TRUE_ROUND_TRIP: Execute as single round-trip request (true/false)
   - PRIVATE_KEY_EVM    : EVM private key (hex format with 0x prefix)
   - PRIVATE_KEY_SOLANA : Solana private key (base58 format)
   - PRIVATE_KEY_TRON   : Tron private key (hex format WITHOUT 0x prefix)
   - BASE_URL           : API endpoint (default: http://localhost:3000)
   - SLIPPAGE_BPS       : Slippage tolerance in basis points (default: 500 = 5%)
   - DRY_RUN            : Preview mode without executing (true/false)
   - STEP_DELAY_MS      : Wait time between steps in milliseconds
   - SWAP_FULL_BALANCE  : Auto-adjust for gas fees on native tokens (true/false)
   - ETH_WALLET         : Ethereum wallet address
   - SOL_WALLET         : Solana wallet address
*/

const http = require('http');

// ============================================================================
// CONFIGURATION - Set all parameters here
// ============================================================================

// Swap path selection (0-7)
// 0: ETH -> SOL -> ETH (Cross-chain round-trip)
// 1: ETH -> BNB -> ETH (Cross-chain round-trip)
// 2: ETH -> BNB -> USDT(Ethereum) (Multi-chain path)
// 3: ETH -> TRX -> ETH (Cross-chain round-trip)
// 4: ETH -> AVAX -> ETH (Cross-chain round-trip)
// 5: ETH -> POL -> ETH (Cross-chain round-trip)
// 6: ETH -> ARB -> ETH (Cross-chain round-trip)
// 7: ETH -> BASE -> ETH (Cross-chain round-trip)
const SWAP_PATH = 3;

// Round-trip execution mode
// true: Execute as single request with finalOutputToken (automatic leg-2 with dynamic gas adjustment)
// false: Execute as two separate swaps (manual step-by-step control)
const USE_TRUE_ROUND_TRIP = true;

// Private key configuration
// EVM chains (Ethereum, BSC, etc.): Hex format with 0x prefix
const PRIVATE_KEY_EVM = '0xafa5b710c1edaddc3067318d15db8252535681cebc9a5919637d6419d633fe94';

// Solana: Base58 format
const PRIVATE_KEY_SOLANA = '3D8rh7dwcBri8YgjaeLKqZQEqkdqcwag4A12YTMSkQwCGgETZewt8Xrk2Cx5gcmuHqsQthoWPiu5ntAj77y81Ukt';

// Tron: Hex format WITHOUT 0x prefix
const PRIVATE_KEY_TRON = 'afa5b710c1edaddc3067318d15db8252535681cebc9a5919637d6419d633fe94';

// API Configuration
const BASE_URL = 'http://localhost:3000';

// Slippage tolerance in basis points (500 = 5%)
const SLIPPAGE_BPS = 500;

// Dry run mode - set to true to preview without executing
const DRY_RUN = false;

// Wait time between steps in milliseconds
const STEP_DELAY_MS = 5000;

// Swap full balance - automatically adjust amount to reserve gas fees
// Useful for native tokens (ETH, BNB, SOL) when swapping entire balance
// Set to true for Step 2 to swap all received tokens from Step 1
const SWAP_FULL_BALANCE = true;

// Wallet addresses (optional - defaults provided below)
const ETH_WALLET = '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516';
const SOL_WALLET = 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt';
const TRON_WALLET = 'TBVFsjt26nZBRZisqmgG9N7oPsQ81ucF6o';

// ============================================================================
// SWAP PATH CONFIGURATIONS
// ============================================================================

const SWAP_PATHS = [
  // Path 0: ETH -> SOL -> ETH (Cross-chain round-trip)
  {
    index: 0,
    name: 'ETH -> SOL -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Solana and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> SOL',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'SOL',
          address: 'So11111111111111111111111111111111111111111',
          chain: { ecosystem: 'solana', chainId: 'solana-mainnet' }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: SOL_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'SOL -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'SOL',
          address: 'So11111111111111111111111111111111111111111',
          chain: { ecosystem: 'solana', chainId: 'solana-mainnet' }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: SOL_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_SOLANA,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 1: ETH -> BNB -> ETH (Cross-chain round-trip)
  {
    index: 1,
    name: 'ETH -> BNB -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to BSC and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> BNB',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'BNB',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 56 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'BNB -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'BNB',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 56 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 2: ETH -> BNB -> USDT(Ethereum) (Multi-chain path)
  {
    index: 2,
    name: 'ETH -> BNB -> USDT(Ethereum) (Multi-chain Path)',
    description: 'Ethereum to BSC to USDT on Ethereum',
    isRoundTrip: false, // Multi-chain path (not a true round-trip)
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> BNB',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'BNB',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 56 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'BNB -> USDT(Ethereum)',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'BNB',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 56 }
        },
        buyToken: {
          symbol: 'USDT',
          address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 3: ETH -> TRX -> ETH (Cross-chain round-trip)
  {
    index: 3,
    name: 'ETH -> TRX -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Tron and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> TRX',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'TRX',
          address: 'native',
          chain: { ecosystem: 'tron', chainId: 'tron-mainnet' }
        },
        sellAmount: '1000000000000000', // 0.001 ETH (~$10)
        senderWallet: ETH_WALLET,
        recipientWallet: TRON_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'TRX -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'TRX',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'tron', chainId: 'tron-mainnet' }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: TRON_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_TRON,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 4: ETH -> AVAX -> ETH (Cross-chain round-trip)
  {
    index: 4,
    name: 'ETH -> AVAX -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Avalanche and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> AVAX',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'AVAX',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 43114 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'AVAX -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'AVAX',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 43114 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: '0x10a700ea4f0d6f7Ec46AFa7eb2056db80a23d516',
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 5: ETH -> POL -> ETH (Cross-chain round-trip)
  {
    index: 5,
    name: 'ETH -> POL -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Polygon and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> POL',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'POL',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 137 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'POL -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'POL',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 137 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 6: ETH -> ARB -> ETH (Cross-chain round-trip)
  {
    index: 6,
    name: 'ETH -> ARB -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Arbitrum and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> ARB',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 42161 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'ARB -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 42161 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  },

  // Path 7: ETH -> BASE -> ETH (Cross-chain round-trip)
  {
    index: 7,
    name: 'ETH -> BASE -> ETH (Cross-chain Round-trip)',
    description: 'Ethereum to Base and back to Ethereum',
    isRoundTrip: true, // Can be executed as single round-trip request
    steps: [
      {
        stepNumber: 1,
        name: 'ETH -> BASE',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 8453 }
        },
        sellAmount: '1000000000000000', // 0.001 ETH
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: false,
      },
      {
        stepNumber: 2,
        name: 'BASE -> ETH',
        swapType: 'cross-chain',
        category: 'meta',
        sellToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 8453 }
        },
        buyToken: {
          symbol: 'ETH',
          address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
          chain: { ecosystem: 'evm', chainId: 1 }
        },
        sellAmount: 'AUTO', // Will use output from step 1
        senderWallet: ETH_WALLET,
        recipientWallet: ETH_WALLET,
        privateKey: PRIVATE_KEY_EVM,
        swapFullBalance: SWAP_FULL_BALANCE,
      }
    ]
  }
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };

    const req = http.request(opts, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try {
          const json = chunks ? JSON.parse(chunks) : {};
          resolve({ statusCode: res.statusCode, body: json });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: { raw: chunks, parseError: e.message } });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOutputAmount(responseData) {
  // Try to extract output amount from various possible locations
  if (!responseData) return null;

  // Check currencies.buy.estimatedAmount
  if (responseData.currencies?.buy?.estimatedAmount?.raw) {
    return responseData.currencies.buy.estimatedAmount.raw;
  }

  // Check route.estimatedOutputAmount
  if (responseData.route?.estimatedOutputAmount?.raw) {
    return responseData.route.estimatedOutputAmount.raw;
  }

  // Check legacy buyAmount field
  if (responseData.buyAmount) {
    return responseData.buyAmount;
  }

  // Check transaction for actual output
  if (responseData.transaction?.outputAmount) {
    return responseData.transaction.outputAmount;
  }

  return null;
}

async function executeRoundTrip(baseUrl, swapPath, slippageBps, dryRun) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`ROUND-TRIP SWAP: ${swapPath.name}`);
  console.log('='.repeat(80));

  const step1 = swapPath.steps[0];
  const step2 = swapPath.steps[1];

  const payload = {
    sellToken: step1.sellToken,
    buyToken: step1.buyToken,
    finalOutputToken: step2.buyToken,
    sellAmount: step1.sellAmount,
    taker: step1.senderWallet,
    recipient: step1.recipientWallet, // Use intermediate recipient (where leg-1 tokens land)
    privateKey: step1.privateKey,
    solanaPrivateKey: step1.buyToken.chain.ecosystem === 'solana' || step2.sellToken.chain.ecosystem === 'solana' ? PRIVATE_KEY_SOLANA : undefined,
    tronPrivateKey: step1.buyToken.chain.ecosystem === 'tron' || step2.sellToken.chain.ecosystem === 'tron' ? PRIVATE_KEY_TRON : undefined,
    slippageToleranceBps: slippageBps,
    swapFullBalance: step1.swapFullBalance || false,
    async:true,
    webhookUrl: ' http://localhost:3001/webhook', // No webhooks for this test
    
  };

  console.log('\n📋 Round-Trip Configuration:');
  console.log('  Mode: Single Request (Automatic Leg-2)');
  console.log('');
  console.log('📤 Leg 1 - Sell:');
  console.log('  Token:', step1.sellToken.symbol);
  console.log('  Address:', step1.sellToken.address);
  console.log('  Chain:', `${step1.sellToken.chain.ecosystem}:${step1.sellToken.chain.chainId}`);
  console.log('  Amount:', step1.sellAmount);
  console.log('  From:', step1.senderWallet);
  console.log('');
  console.log('🔄 Leg 1 - Buy (Intermediate):');
  console.log('  Token:', step1.buyToken.symbol);
  console.log('  Address:', step1.buyToken.address);
  console.log('  Chain:', `${step1.buyToken.chain.ecosystem}:${step1.buyToken.chain.chainId}`);
  console.log('  To:', step2.senderWallet);
  console.log('');
  console.log('📥 Leg 2 - Final Output:');
  console.log('  Token:', step2.buyToken.symbol);
  console.log('  Address:', step2.buyToken.address);
  console.log('  Chain:', `${step2.buyToken.chain.ecosystem}:${step2.buyToken.chain.chainId}`);
  console.log('  To:', step2.recipientWallet);
  console.log('');
  console.log('⚙️  Settings:');
  console.log('  Slippage:', (slippageBps / 100).toFixed(2) + '%');
  console.log('  Swap Full Balance:', step1.swapFullBalance ? 'Yes (Leg 1)' : 'No');
  console.log('  Gas Adjustment:', 'Automatic (Leg 2 native token)');
  console.log('  Private Keys:', 
    'EVM: ✓' + 
    ', Solana: ' + (payload.solanaPrivateKey ? '✓' : '✗') +
    ', Tron: ' + (payload.tronPrivateKey ? '✓' : '✗')
  );
  console.log('');

  if (dryRun) {
    console.log('🔍 DRY RUN - Request Preview:');
    console.log(JSON.stringify(payload, null, 2));
    return { success: true, dryRun: true, data: null };
  }

  const url = `${baseUrl}/universal-swap/execute`;
  console.log(`🚀 Executing round-trip swap via ${url}...\n`);

  const startTime = Date.now();
  const res = await postJson(url, payload);
  const duration = Date.now() - startTime;

  const success = res.statusCode >= 200 && res.statusCode < 300 && res.body?.success !== false;

  if (success) {
    console.log('✅ Round-trip swap completed successfully!');
    console.log(`⏱️  Duration: ${duration}ms`);
    
    const data = res.body.data || {};
    
    console.log('\n📊 Results:');
    console.log('  Execution ID:', data.executionId || '(n/a)');
    console.log('  Status:', data.status || '(unknown)');
    
    if (data.transactionHashes && data.transactionHashes.length > 0) {
      console.log('\n🔗 Transactions:');
      data.transactionHashes.forEach((hash, idx) => {
        console.log(`  Leg ${idx + 1}:`, hash);
      });
    }

    if (data.steps && data.steps.length > 0) {
      console.log('\n📝 Execution Steps:');
      data.steps.forEach((step, idx) => {
        console.log(`  Step ${idx + 1}: ${step.description || step.action || 'N/A'}`);
        if (step.status) console.log(`    Status: ${step.status}`);
      });
    }

    if (data.trackingUrls && data.trackingUrls.length > 0) {
      console.log('\n🔍 Tracking:');
      data.trackingUrls.forEach((t) => console.log(`  ${t.description}: ${t.url}`));
    }

    return {
      success: true,
      data: data,
      duration: duration,
      isRoundTrip: true,
    };
  } else {
    console.log('❌ Round-trip swap failed!');
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log('Status Code:', res.statusCode);
    
    if (res.body?.error) {
      console.log('\n❗ Error:');
      console.log('  Message:', res.body.error.message || res.body.error);
      if (res.body.error.details) {
        console.log('  Details:', JSON.stringify(res.body.error.details, null, 2));
      }
    } else {
      console.log('\n❗ Response:');
      console.log(JSON.stringify(res.body, null, 2));
    }

    return {
      success: false,
      error: res.body?.error || res.body,
      duration: duration,
      isRoundTrip: true,
    };
  }
}

async function executeStep(baseUrl, step, slippageBps, dryRun) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`STEP ${step.stepNumber}: ${step.name}`);
  console.log('='.repeat(80));

  const payload = {
    sellToken: step.sellToken,
    buyToken: step.buyToken,
    sellAmount: step.sellAmount,
    taker: step.senderWallet,
    recipient: step.recipientWallet,
    privateKey: step.privateKey,
    slippageToleranceBps: slippageBps,
    swapFullBalance: step.swapFullBalance || false,
  };

  console.log('\n📋 Step Configuration:');
  console.log('  Swap Type:', step.swapType);
  console.log('  Category:', step.category);
  console.log('');
  console.log('📤 Sell:');
  console.log('  Token:', step.sellToken.symbol);
  console.log('  Address:', step.sellToken.address);
  console.log('  Chain:', `${step.sellToken.chain.ecosystem}:${step.sellToken.chain.chainId}`);
  console.log('  Amount:', step.sellAmount);
  console.log('  From:', step.senderWallet);
  console.log('');
  console.log('📥 Buy:');
  console.log('  Token:', step.buyToken.symbol);
  console.log('  Address:', step.buyToken.address);
  console.log('  Chain:', `${step.buyToken.chain.ecosystem}:${step.buyToken.chain.chainId}`);
  console.log('  To:', step.recipientWallet);
  console.log('');
  console.log('⚙️  Settings:');
  console.log('  Slippage:', (slippageBps / 100).toFixed(2) + '%');
  console.log('  Swap Full Balance:', step.swapFullBalance ? 'Yes' : 'No');
  console.log('  Private Key:', step.privateKey ? '✓ Provided' : '✗ Missing');
  console.log('');

  if (dryRun) {
    console.log('🔍 DRY RUN - Request Preview:');
    console.log(JSON.stringify(payload, null, 2));
    return { success: true, dryRun: true, data: null };
  }

  const url = `${baseUrl}/universal-swap/execute`;
  console.log(`🚀 Executing swap via ${url}...\n`);

  const startTime = Date.now();
  const res = await postJson(url, payload);
  const duration = Date.now() - startTime;

  const success = res.statusCode >= 200 && res.statusCode < 300 && res.body?.success !== false;

  if (success) {
    console.log('✅ Step completed successfully!');
    console.log(`⏱️  Duration: ${duration}ms`);
    
    const data = res.body.data || {};
    
    console.log('\n📊 Results:');
    console.log('  Execution ID:', data.executionId || '(n/a)');
    console.log('  Provider:', data.aggregator || data.provider || '(n/a)');
    
    if (data.currencies) {
      console.log('\n💰 Amounts:');
      if (data.currencies.sell?.amount) {
        console.log('  Sold:', data.currencies.sell.amount.formatted, data.currencies.sell.symbol);
      }
      if (data.currencies.buy?.estimatedAmount) {
        console.log('  Received:', data.currencies.buy.estimatedAmount.formatted, data.currencies.buy.symbol);
      }
      if (data.currencies.buy?.minimumAmount) {
        console.log('  Minimum:', data.currencies.buy.minimumAmount.formatted, data.currencies.buy.symbol);
      }
    }

    if (data.transaction) {
      console.log('\n🔗 Transaction:');
      console.log('  Hash:', data.transaction.transactionHash || '(pending)');
      console.log('  Status:', data.transaction.status || '(unknown)');
      if (data.transaction.gasUsed) {
        console.log('  Gas Used:', data.transaction.gasUsed);
      }
    }

    if (data.trackingUrls && data.trackingUrls.length > 0) {
      console.log('\n🔍 Tracking:');
      data.trackingUrls.forEach((t) => console.log(`  ${t.description}: ${t.url}`));
    }

    // Extract output amount for next step
    const outputAmount = extractOutputAmount(data);
    if (outputAmount) {
      console.log('\n📈 Output Amount (for next step):', outputAmount);
    }

    return {
      success: true,
      data: data,
      outputAmount: outputAmount,
      duration: duration,
    };
  } else {
    console.log('❌ Step failed!');
    console.log(`⏱️  Duration: ${duration}ms`);
    console.log('Status Code:', res.statusCode);
    
    if (res.body?.error) {
      console.log('\n❗ Error:');
      console.log('  Message:', res.body.error.message || res.body.error);
      if (res.body.error.details) {
        console.log('  Details:', JSON.stringify(res.body.error.details, null, 2));
      }
    } else {
      console.log('\n❗ Response:');
      console.log(JSON.stringify(res.body, null, 2));
    }

    return {
      success: false,
      error: res.body?.error || res.body,
      duration: duration,
    };
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

(async () => {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║        ROUND-TRIP & MULTI-CHAIN SWAP TEST SCRIPT              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Validate swap path
  if (SWAP_PATH < 0 || SWAP_PATH >= SWAP_PATHS.length) {
    console.error(`❌ ERROR: Invalid SWAP_PATH=${SWAP_PATH}. Must be between 0 and ${SWAP_PATHS.length - 1}`);
    console.error('\nAvailable paths:');
    SWAP_PATHS.forEach((path) => {
      console.error(`  ${path.index}: ${path.name}`);
    });
    process.exit(1);
  }

  const swapPath = SWAP_PATHS[SWAP_PATH];

  // Display configuration
  console.log('🎯 Configuration:');
  console.log('  Base URL:', BASE_URL);
  console.log('  Swap Path:', swapPath.index);
  console.log('  Path Name:', swapPath.name);
  console.log('  Description:', swapPath.description);
  console.log('  Is Round-Trip:', swapPath.isRoundTrip ? 'Yes' : 'No');
  console.log('  Execution Mode:', (USE_TRUE_ROUND_TRIP && swapPath.isRoundTrip) ? 'Single Request' : 'Step-by-Step');
  console.log('  Total Steps:', swapPath.steps.length);
  console.log('  Slippage:', (SLIPPAGE_BPS / 100).toFixed(2) + '%');
  console.log('  Step Delay:', STEP_DELAY_MS + 'ms');
  console.log('  Swap Full Balance:', SWAP_FULL_BALANCE ? 'Yes (Step 2 auto-adjusts for gas)' : 'No');
  console.log('  Dry Run:', DRY_RUN ? 'Yes' : 'No');
  console.log('  ETH Wallet:', ETH_WALLET);
  console.log('  SOL Wallet:', SOL_WALLET);
  console.log('');

  // Validate private keys
  const missingKeys = [];
  swapPath.steps.forEach((step) => {
    if (!step.privateKey) {
      const ecosystem = step.sellToken.chain.ecosystem;
      const keyName = ecosystem === 'evm' ? 'PRIVATE_KEY_ETH' : 
                      ecosystem === 'solana' ? 'PRIVATE_KEY_SOL' : 'PRIVATE_KEY';
      missingKeys.push(`${keyName} (for ${step.name})`);
    }
  });

  if (missingKeys.length > 0 && !DRY_RUN) {
    console.error('❌ ERROR: Missing or invalid private key:');
    missingKeys.forEach((key) => console.error(`  - ${key}`));
    console.error('\nPlease set private key constants in the script (lines ~50-53):');
    console.error('  PRIVATE_KEY_EVM    = \'0x...\' (hex format for Ethereum, BSC)');
    console.error('  PRIVATE_KEY_SOLANA = \'...\' (base58 format for Solana)');
    process.exit(1);
  }

  // Execute swap path
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    EXECUTING SWAP PATH                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const results = [];
  let totalDuration = 0;

  // Check if we should use single-request round-trip mode
  const useSingleRequest = USE_TRUE_ROUND_TRIP && swapPath.isRoundTrip;

  if (useSingleRequest) {
    console.log('\n💡 Executing as single round-trip request with automatic leg-2 handling\n');
    
    const result = await executeRoundTrip(BASE_URL, swapPath, SLIPPAGE_BPS, DRY_RUN);
    results.push(result);
    totalDuration = result.duration || 0;
  } else {
    console.log('\n💡 Executing step-by-step (manual control)\n');
    
    for (let i = 0; i < swapPath.steps.length; i++) {
      const step = swapPath.steps[i];

      // Auto-fill sell amount from previous step's output
      if (i > 0 && step.sellAmount === 'AUTO') {
        const prevResult = results[i - 1];
        if (prevResult.success && prevResult.outputAmount) {
          step.sellAmount = prevResult.outputAmount;
          console.log(`\n📊 Using output from previous step: ${step.sellAmount}`);
        } else if (DRY_RUN) {
          // In dry run mode, use placeholder amount for preview
          step.sellAmount = '100000000'; // Placeholder for preview
          console.log(`\n📊 [DRY RUN] Using placeholder amount: ${step.sellAmount}`);
        } else {
          console.error(`\n❌ ERROR: Cannot auto-fill sellAmount for step ${step.stepNumber}`);
          console.error('Previous step did not produce output amount or failed.');
          process.exit(1);
        }
      }

      // Execute step
      const result = await executeStep(BASE_URL, step, SLIPPAGE_BPS, DRY_RUN);
      results.push(result);
      totalDuration += result.duration || 0;

      // Stop if step failed
      if (!result.success && !result.dryRun) {
        console.log('\n❌ Swap path execution stopped due to step failure.');
        break;
      }

      // Wait before next step (except for last step or dry run)
      if (i < swapPath.steps.length - 1 && !DRY_RUN) {
        console.log(`\n⏳ Waiting ${STEP_DELAY_MS}ms before next step...`);
        await delay(STEP_DELAY_MS);
      }
    }
  }

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                         SUMMARY                               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('📊 Path Execution Results:');
  console.log('  Path:', swapPath.name);
  console.log('  Execution Mode:', useSingleRequest ? 'Single Round-Trip Request' : 'Step-by-Step');
  console.log('  Total Steps:', swapPath.steps.length);
  console.log('  Completed:', results.filter((r) => r.success).length);
  console.log('  Failed:', results.filter((r) => !r.success && !r.dryRun).length);
  console.log('  Total Duration:', totalDuration + 'ms');
  console.log('');

  if (useSingleRequest) {
    const result = results[0];
    const status = result.dryRun ? '🔍 DRY RUN' : 
                   result.success ? '✅ SUCCESS' : 
                   '❌ FAILED';
    console.log(`Round-Trip: ${swapPath.name} - ${status}`);
  } else {
    results.forEach((result, idx) => {
      const step = swapPath.steps[idx];
      const status = result.dryRun ? '🔍 DRY RUN' : 
                     result.success ? '✅ SUCCESS' : 
                     '❌ FAILED';
      console.log(`Step ${step.stepNumber}: ${step.name} - ${status}`);
      if (result.outputAmount) {
        console.log(`  Output: ${result.outputAmount}`);
      }
    });
  }

  console.log('');

  const allSuccess = results.every((r) => r.success || r.dryRun);
  if (allSuccess && !DRY_RUN) {
    console.log('🎉 All steps completed successfully!');
    process.exit(0);
  } else if (DRY_RUN) {
    console.log('✅ Dry run completed - no swaps were executed.');
    process.exit(0);
  } else {
    console.log('⚠️  Some steps failed - check errors above.');
    process.exit(1);
  }
})();
