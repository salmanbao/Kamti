#!/usr/bin/env node
/*
 COMPREHENSIVE SWAP COMBINATIONS TEST SCRIPT
 Generated from unified-token-configuration.config.ts (ENABLED chains and tokens only)
 
 - Uses inline execute mode (no prior routeId required)
 - Supports multiple swap combinations (EVM, Solana, Cross-chain, etc.)
 - Prints concise success/failure info and explorer URL if present
 - Total: 76 unique swap combinations (on-chain + cross-chain + native L1)

 ENABLED CHAINS (10):
 - Ethereum (1), BSC (56), Polygon (137), Arbitrum (42161), Avalanche (43114)
 - Base (8453), Optimism (10), Solana, Tron, Bitcoin, Litecoin
 
 ENABLED TOKENS (10):
 - SOL, ETH, BNB, AVAX, SHIB, LTC, BTC, USDT (multi-chain), USDC (multi-chain)

 Usage:
   1. Set SWAP_INDEX environment variable to select a swap combination (0-based)
   2. Optionally set DRY_RUN=1 to preview without executing
   
   Examples:
   SWAP_INDEX=0 npm run check:evm-execute    # ETH -> USDT (Ethereum)
   SWAP_INDEX=15 npm run check:evm-execute   # SOL -> USDT (Solana)
   SWAP_INDEX=31 DRY_RUN=1 npm run check:evm-execute  # Preview USDT (ETH) -> USDT (SOL)
   SWAP_INDEX=0 SWAP_FULL_BALANCE=1 npm run check:evm-execute  # Swap full ETH balance (adjusted for gas)

 Environment variables:
   SWAP_INDEX        - Index of swap combination to use (default: 0)
   PRIVATE_KEY       - Hex private key (0x... for EVM, base58 for Solana)
   BASE_URL          - API base URL (default: http://localhost:3000)
   DRY_RUN           - If '1', prints the request without sending
   SWAP_FULL_BALANCE - If '1', enables full balance swap mode (adjusts amount for gas fees)
                        Only applies to native token swaps (ETH, MATIC, BNB, SOL, etc.)
*/

const http = require('http');

// ============================================================================
// SWAP COMBINATIONS - All supported swap scenarios
// ============================================================================

const SWAP_COMBINATIONS = [
  // ==================== EVM ON-CHAIN SWAPS (Ethereum) ====================
  {
    index: 0,
    status: 'tested',
    name: 'ETH -> USDT (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '1000000000000000', // 0.001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 1,
    status: 'tested',
    name: 'ETH -> USDC (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000000000000', // 0.00001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 2,
    status: 'tested',
    name: 'ETH -> SHIB (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000000000000', // 0.00001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 3,
    status: 'tested',
    name: 'USDT -> ETH (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '3249291', // 0.06 USDT (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 4,
    status: 'tested',
    name: 'USDT -> USDC (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '20000', // 0.02 USDT (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 5,
    status: 'tested',
    name: 'USDC -> ETH (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '4960374', // 0.02 USDC (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 6,
    status: 'tested',
    name: 'USDC -> USDT (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000', // 0.01 USDC (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 7,
    status: 'tested',
    name: 'USDC -> SHIB (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000', // 0.01 USDC (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 8,
    status: 'tested',
    name: 'SHIB -> ETH (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '1000000000000000000000', // 0.1 SHIB (18 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 9,
    status: 'tested',
    name: 'SHIB -> USDC (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '1000000000000000000000', // 1000 SHIB (18 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // ==================== EVM ON-CHAIN SWAPS (BSC) ====================
  {
    index: 10,
    status: 'tested',
    name: 'BNB -> USDC (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '1000000000000000', // 0.001 BNB
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 11,
    status: 'tested',
    name: 'BNB -> USDT (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '1000000000000000', // 0.001 BNB
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 12,
    status: 'tested',
    name: 'USDT -> USDC (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '10000000000000000', // 0.01 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 13,
    status: 'tested',
    name: 'USDC -> USDT (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '10000000000000000', // 0.01 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 14,
    status: 'tested',
    name: 'USDT -> BNB (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '1813715296137410999', // ~1.81 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // ==================== SOLANA ON-CHAIN SWAPS ====================
  {
    index: 15,
    status: 'tested',
    name: 'SOL -> USDT (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '20000000', // 0.02 SOL (9 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 16,
    status: 'tested',
    name: 'SOL -> USDC (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '20000000', // 0.02 SOL (9 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 17,
    status: 'not-tested',
    name: 'USDC -> USDT (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '3072459', // ~0.01 USDC (6 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 18,
    status: 'tested',
    name: 'USDT -> SOL (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '2737889', // ~0.01 USDT (6 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 19,
    status: 'not-tested',
    name: 'USDT -> USDC (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '34047530', // 0.01 USDT (6 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 20,
    status: 'tested',
    name: 'USDC -> SOL (Solana)',
    swapType: 'on-chain',
    category: 'solana',
    sellToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '3072459', // ~0.01 USDC (6 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },

  // ==================== AVALANCHE SWAPS ====================
  {
    index: 21,
    status: 'tested',
    name: 'AVAX -> USDT (Avalanche)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '10000000000000000', // 0.01 AVAX
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 22,
    status: 'not-tested',
    name: 'USDT -> AVAX (Avalanche)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '500000', // 0.5 USDT (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // ==================== CROSS-CHAIN SWAPS (Meta Aggregators) ====================
  {
    index: 23,
    status: 'tested',
    name: 'USDT (BSC) -> USDT (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '5768828000000000000', // 0.1 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 24,
    status: 'tested',
    name: 'USDT (Ethereum) -> USDT (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '3447155', // 0.1 USDT (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 25,
    status: 'tested',
    name: 'USDC (BSC) -> USDT (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '900000000000000000', // 0.9 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 26,
    status: 'not-tested',
    name: 'USDT (BSC) -> USDT (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '5476680000000000000', // 0.1 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 27,
    status: 'tested',
    name: 'USDT (BSC) -> USDC (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000000000000000', // 0.1 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 28,
    status: 'tested',
    name: 'USDT (Solana) -> USDT (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '3180305', // 3 USDT (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 29,
    status: 'not-tested',
    name: 'USDT (Solana) -> USDC (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '3264224', // 0.1 USDT (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 30,
    status: 'tested',
    name: 'USDT (Solana) -> USDC (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '5424698', // 0.1 USDT (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 31,
    status: 'not-tested',
    name: 'USDT (Solana) -> USDT (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '100000', // 0.1 USDT (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 32,
    status: 'tested',
    name: 'ETH (Ethereum) -> BNB (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '998000000000000000', // 0.999 ETH
    walletAddress: '0xCE595038831E6FD4c64751C594AaA9D94CD20a21',
  },
  {
    index: 33,
    status: 'tested',
    name: 'USDT (Ethereum) -> USDT (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '5490083', // 0.9 USDT (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 34,
    status: 'tested',
    name: 'AVAX (Avalanche) -> BNB (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '560000000000000000', // 0.56 AVAX
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 35,
    status: 'tested',
    name: 'BNB (BSC) -> AVAX (Avalanche)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '10000000000000000', // 0.01 BNB
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 36,
    status: 'tested',
    name: 'ETH (Ethereum) -> AVAX (Avalanche)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '1000000000000000', // 0.001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 37,
    status: 'tested',
    name: 'BNB (BSC) -> SOL (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '1000000000000000', // 0.001 BNB
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 38,
    status: 'tested',
    name: 'BNB (BSC) -> ETH (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '3477361098852335', // 0.01 BNB
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 39,
    status: 'tested',
    name: 'ETH (Ethereum) -> SOL (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '2443941021521314', // 0.001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // ==================== NATIVE L1 SWAPS (Bitcoin/Litecoin via THORChain/Maya) ====================
  {
    index: 40,
    status: 'not-tested',
    name: 'BTC -> USDT (Ethereum)',
    swapType: 'native-swap',
    category: 'meta',
    sellToken: { symbol: 'BTC', address: 'native', chain: { ecosystem: 'bitcoin', chainId: 'bitcoin-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000', // 0.0001 BTC (8 decimals)
    walletAddress: process.env.BITCOIN_WALLET || 'YourBitcoinWalletAddress',
  },
  {
    index: 41,
    status: 'not-tested',
    name: 'BTC -> USDC (Ethereum)',
    swapType: 'native-swap',
    category: 'meta',
    sellToken: { symbol: 'BTC', address: 'native', chain: { ecosystem: 'bitcoin', chainId: 'bitcoin-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '10000', // 0.0001 BTC (8 decimals)
    walletAddress: process.env.BITCOIN_WALLET || 'YourBitcoinWalletAddress',
  },
  {
    index: 42,
    status: 'not-tested',
    name: 'LTC -> BTC',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'LTC', address: 'native', chain: { ecosystem: 'bitcoin', chainId: 'litecoin-mainnet' } },
    buyToken: { symbol: 'BTC', address: 'native', chain: { ecosystem: 'bitcoin', chainId: 'bitcoin-mainnet' } },
    sellAmount: '100000', // 0.001 LTC (8 decimals)
    walletAddress: process.env.LITECOIN_WALLET || 'YourLitecoinWalletAddress',
  },
  {
    index: 43,
    status: 'not-tested',
    name: 'LTC -> ETH',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'LTC', address: 'native', chain: { ecosystem: 'bitcoin', chainId: 'litecoin-mainnet' } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000', // 0.001 LTC (8 decimals)
    walletAddress: process.env.LITECOIN_WALLET || 'YourLitecoinWalletAddress',
  },

  // ==================== APPENDED SWAP EXTENSIONS ====================
  // On-chain (Ethereum) missing SHIB <-> USDT pairs
  {
    index: 44,
    status: 'tested',
    name: 'USDT -> SHIB (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '5887345', // 0.01 USDT (6 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 45,
    status: 'tested',
    name: 'SHIB -> USDT (Ethereum)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '594212589726122171741456', // sample SHIB amount
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // On-chain (BSC) missing USDC -> BNB
  {
    index: 46,
    status: 'not-tested',
    name: 'USDC -> BNB (BSC)',
    swapType: 'on-chain',
    category: 'evm-aggregators',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '3173119674607486373', // 0.01 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain native gaps
  {
    index: 47,
    status: 'tested',
    name: 'SOL (Solana) -> ETH (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '59543335', // 0.02 SOL
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 48,
    status: 'tested',
    name: 'SOL (Solana) -> BNB (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '26292551', // 0.02 SOL
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 49,
    status: 'tested',
    name: 'AVAX (Avalanche) -> ETH (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '208700000000000000', // 0.01 AVAX
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain USDC BSC ⇄ Ethereum bridges
  {
    index: 50,
    status: 'not-tested',
    name: 'USDC (BSC) -> USDC (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000000000000000', // 0.1 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 51,
    status: 'not-tested',
    name: 'USDC (Ethereum) -> USDC (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain Avalanche USDT bridges
  {
    index: 52,
    status: 'tested',
    name: 'USDT (Avalanche) -> USDT (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '5554590', // 0.1 USDT (6 decimals on Avalanche)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 53,
    status: 'tested',
    name: 'USDT (Ethereum) -> USDT (Avalanche)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '5500000', // 0.1 USDT (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 54,
    status: 'tested',
    name: 'USDT (Avalanche) -> USDT (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '5624500', // 0.1 USDT (6 decimals on Avalanche)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 55,
    status: 'tested',
    name: 'USDT (BSC) -> USDT (Avalanche)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '5571812350933961375', // 0.1 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain Tron USDT bridges
  {
    index: 56,
    status: 'not-tested',
    name: 'USDT (Tron) -> USDT (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000', // 0.1 USDT (6 decimals on Tron)
    walletAddress: process.env.TRON_WALLET || 'YourTronWalletAddress',
  },
  {
    index: 57,
    status: 'not-tested',
    name: 'USDT (Ethereum) -> USDT (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '100000', // 0.1 USDT (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 58,
    status: 'not-tested',
    name: 'USDT (Tron) -> USDT (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '100000', // 0.1 USDT (6 decimals on Tron)
    walletAddress: process.env.TRON_WALLET || 'YourTronWalletAddress',
  },
  {
    index: 59,
    status: 'not-tested',
    name: 'USDT (BSC) -> USDT (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '100000000000000000', // 0.1 USDT (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain Tron USDC bridges
  {
    index: 60,
    status: 'not-tested',
    name: 'USDC (Tron) -> USDC (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Tron)
    walletAddress: process.env.TRON_WALLET || 'YourTronWalletAddress',
  },
  {
    index: 61,
    status: 'not-tested',
    name: 'USDC (Ethereum) -> USDC (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 62,
    status: 'not-tested',
    name: 'USDC (Tron) -> USDC (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Tron)
    walletAddress: process.env.TRON_WALLET || 'YourTronWalletAddress',
  },
  {
    index: 63,
    status: 'not-tested',
    name: 'USDC (BSC) -> USDC (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '100000000000000000', // 0.1 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },

  // Cross-chain Solana USDC bridges
  {
    index: 64,
    status: 'not-tested',
    name: 'USDC (Solana) -> USDC (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 65,
    status: 'not-tested',
    name: 'USDC (Ethereum) -> USDC (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Ethereum)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 66,
    status: 'not-tested',
    name: 'USDC (Solana) -> USDC (BSC)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    sellAmount: '100000', // 0.1 USDC (6 decimals on Solana)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 67,
    status: 'not-tested',
    name: 'USDC (BSC) -> USDC (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', chain: { ecosystem: 'evm', chainId: 56 } },
    buyToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '100000000000000000', // 0.1 USDC (18 decimals on BSC)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  // ==================== TRON NATIVE (TRX) CROSS-CHAIN SWAPS ====================
  {
    index: 68,
    status: 'tested',
    name: 'TRX (Tron) -> ETH (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'TRX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '19376589', // 30 TRX (6 decimals)
    walletAddress: 'TBVFsjt26nZBRZisqmgG9N7oPsQ81ucF6o',
  },
  {
    index: 69,
    status: 'tested',
    name: 'ETH (Ethereum) -> TRX (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '940958901558841', // 0.001 ETH
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  {
    index: 70,
    status: 'not-tested',
    name: 'TRX (Tron) -> SOL (Solana)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    sellAmount: '38301356', // 1 TRX (6 decimals)
    walletAddress: 'TBVFsjt26nZBRZisqmgG9N7oPsQ81ucF6o',
  },
  {
    index: 71,
    status: 'not-tested',
    name: 'SOL (Solana) -> TRX (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'SOL', address: 'So11111111111111111111111111111111111111111', chain: { ecosystem: 'solana', chainId: 'solana-mainnet' } },
    buyToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '20000000', // 0.02 SOL (9 decimals)
    walletAddress: 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',
  },
  {
    index: 72,
    status: 'not-tested',
    name: 'TRX (Tron) -> AVAX (Avalanche)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    sellAmount: '21658419', // 1 TRX (6 decimals)
    walletAddress: 'TBVFsjt26nZBRZisqmgG9N7oPsQ81ucF6o',
  },
  {
    index: 73,
    status: 'not-tested',
    name: 'AVAX (Avalanche) -> TRX (Tron)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'AVAX', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 43114 } },
    buyToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '10000000000000000', // 0.01 AVAX
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  // ==================== POLYGON CROSS-CHAIN SWAPS ====================
  {
    index: 74,
    status: 'not-tested',
    name: 'POL (Polygon) -> ETH (Ethereum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'POL', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 137 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '28218805776114736584', // 25 POL (18 decimals)
    walletAddress: '0xf2c65290960128B45949aF55CA91947c1728fd62',
  },
  // ==================== TRON ON-CHAIN SWAPS ====================
  {
    index: 75,
    status: 'not-tested',
    name: 'TRX -> USDT (Tron)',
    swapType: 'on-chain',
    category: 'meta',
    sellToken: { symbol: 'TRX', address: 'native', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    sellAmount: '3000000', // 3 TRX (6 decimals)
    walletAddress: 'TQCMxLNcrEAzJMixcZKiVcxVAv6gGzcjGo',
  },
  {
    index: 76,
    status: 'not-tested',
    name: 'TRON (USDT) -> ETH (USDT)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: { ecosystem: 'tron', chainId: 'tron-mainnet' } },
    buyToken: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '18000000',
    walletAddress: 'TQCMxLNcrEAzJMixcZKiVcxVAv6gGzcjGo',
  },
  {
    index: 77,
    status: 'tested',
    name: 'Eth -> wETH',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '100000000000000', 
    walletAddress: '0xCE595038831E6FD4c64751C594AaA9D94CD20a21',
  },

  {
    index: 78,
    status: 'tested',
    name: 'Eth (Ethereum) -> ETH (Arbitrum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 42161 } },
    sellAmount: '6400000000000000', 
    walletAddress: '0xCE595038831E6FD4c64751C594AaA9D94CD20a21',
  },


  {
    index: 79,
    status: 'tested',
    name: 'Eth (Ethereum) -> ETH (Arbitrum)',
    swapType: 'cross-chain',
    category: 'meta',
    sellToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 42161 } },
    buyToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chain: { ecosystem: 'evm', chainId: 1 } },
    sellAmount: '6300000000000000', 
    walletAddress: '0xc9c0fF2269D6B85e4A8b298E4371713BF075C4F1',
  },


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

function getWalletForChain(chainId, ecosystem) {
  // Map of chainId to wallet address
  const CHAIN_WALLETS = {
    // EVM chains
    1: '0xA3f6686241F9e83C0eB25fc79D63c310a6d125C6',       // Ethereum
    56: '0x6A6E8B62BE8132e8Ec1499d61EFdD1Ea4Df3Da5e',      // BSC
    43114: '0x6A6E8B62BE8132e8Ec1499d61EFdD1Ea4Df3Da5e',   // Avalanche
    
    // Solana
    'solana-mainnet': 'GYox5gfG3vUNXtTga3oCajNN55j6mXMGdQpXGeVaC4Yt',

    // Tron
    'tron-mainnet': 'TQCMxLNcrEAzJMixcZKiVcxVAv6gGzcjGo',
    // Bitcoin ecosystem
    'bitcoin-mainnet': process.env.BITCOIN_WALLET || 'YourBitcoinWalletAddress',
    'litecoin-mainnet': process.env.LITECOIN_WALLET || 'YourLitecoinWalletAddress',
  };

  return CHAIN_WALLETS[chainId] || CHAIN_WALLETS[1]; // fallback to Ethereum wallet
}

(async () => {
  // ============================================================================
  // CONFIGURATION
  // ============================================================================
  
  const BASE_URL = 'http://localhost:4000';
  
  // Get swap index from environment (default: 0 = ETH -> USDT)
  const SWAP_INDEX = 79;
  
  // Get private key from environment
  // const PRIVATE_KEY = '3D8rh7dwcBri8YgjaeLKqZQEqkdqcwag4A12YTMSkQwCGgETZewt8Xrk2Cx5gcmuHqsQthoWPiu5ntAj77y81Ukt';
  // const PRIVATE_KEY = 'afa5b710c1edaddc3067318d15db8252535681cebc9a5919637d6419d633fe94';
  const PRIVATE_KEY = '0xd4acd4c0b09e13f8fdcb25cdf35a5193cb12de9b06ad11ec77e8cb0167f64068';

  // Slippage in basis points (0.5% = 50, 1% = 100)
  const SLIPPAGE_BPS = 500;
  
  // Swap full balance flag - when true, automatically adjusts swap amount to account for gas fees
  // Only applies to native token swaps (ETH, MATIC, BNB, etc.)
  // Set via environment variable: SWAP_FULL_BALANCE=1
  const SWAP_FULL_BALANCE = false;
  
  // Set to true to only print the request without sending
  const DRY_RUN = false;

  // ============================================================================
  // SELECT SWAP COMBINATION
  // ============================================================================
  
  // Validate index
  if (SWAP_INDEX < 0 || SWAP_INDEX >= SWAP_COMBINATIONS.length) {
    console.error(`ERROR: Invalid SWAP_INDEX=${SWAP_INDEX}. Must be between 0 and ${SWAP_COMBINATIONS.length - 1}`);
    process.exit(1);
  }
  
  const combination = SWAP_COMBINATIONS[SWAP_INDEX];
  
  // Resolve wallet addresses for source and destination chains
  const USER_WALLET =  "0xc9c0fF2269D6B85e4A8b298E4371713BF075C4F1"; //getWalletForChain(combination.sellToken.chain.chainId, combination.sellToken.chain.ecosystem);
  const RECIPIENT =  "0xA3f6686241F9e83C0eB25fc79D63c310a6d125C6"; //getWalletForChain(combination.buyToken.chain.chainId, combination.buyToken.chain.ecosystem);
  
  // ============================================================================
  // DISPLAY SWAP DETAILS
  // ============================================================================
  
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║              UNIVERSAL SWAP EXECUTION                         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log('🔄 Swap Details:');
  console.log('  Index:', combination.index);
  console.log('  Name:', combination.name);
  console.log('  Type:', combination.swapType);
  console.log('  Category:', combination.category);
  console.log('');
  
  console.log('📤 Sell Token:');
  console.log('  Symbol:', combination.sellToken.symbol);
  console.log('  Address:', combination.sellToken.address);
  console.log('  Chain:', combination.sellToken.chain.chainId);
  console.log('  Ecosystem:', combination.sellToken.chain.ecosystem);
  console.log('  Amount:', combination.sellAmount);
  console.log('  Wallet:', USER_WALLET);
  console.log('');
  
  console.log('📥 Buy Token:');
  console.log('  Symbol:', combination.buyToken.symbol);
  console.log('  Address:', combination.buyToken.address);
  console.log('  Chain:', combination.buyToken.chain.chainId);
  console.log('  Ecosystem:', combination.buyToken.chain.ecosystem);
  console.log('  Recipient:', RECIPIENT);
  console.log('');
  
  console.log('⚙️  Settings:');
  console.log('  Slippage:', (SLIPPAGE_BPS / 100).toFixed(2) + '%');
  console.log('  Swap Full Balance:', SWAP_FULL_BALANCE ? 'Yes (amount will be adjusted for gas)' : 'No');
  console.log('  Private Key:', PRIVATE_KEY ? '✓ Provided' : '✗ Missing');
  console.log('  Dry Run:', DRY_RUN ? 'Yes' : 'No');
  console.log('');
  
  // ============================================================================
  // BUILD PAYLOAD
  // ============================================================================
  
  const payload = {
    // Provide full token objects to align with controller's enriched flow
    sellToken: combination.sellToken,
    buyToken: combination.buyToken,
    sellAmount: combination.sellAmount,

    // Identity and signing
    taker: USER_WALLET,
    userWallet: USER_WALLET,
    recipient: RECIPIENT, // 0x570EcB097D64Ed1C42D81DfffeEc6eD096525d66
    receiver: RECIPIENT,
    privateKey: PRIVATE_KEY,

    // Slippage preference
    slippageToleranceBps: SLIPPAGE_BPS,

    // Native token full balance swap flag
    // When true, automatically adjusts swap amount to account for gas fees
    // Only applies to native token swaps (ETH, MATIC, BNB, SOL, etc.)
    swapFullBalance: SWAP_FULL_BALANCE,
  };

  const url = `${BASE_URL}/universal-swap/execute`;
  
  // ============================================================================
  // EXECUTE SWAP
  // ============================================================================
  
  if (DRY_RUN) {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    DRY RUN MODE                               ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    console.log('Would POST to:', url);
    console.log('\nPayload:');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    EXECUTING SWAP                             ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  console.log('POST', url);
  console.log('Sending request...\n');
  
  const res = await postJson(url, payload);

  const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && res.body?.success !== false;

  if (ok) {
    console.log(JSON.stringify(res.body, null, 2));

    const data = res.body.data || {};
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    ✓ SUCCESS                                  ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    console.log('📋 Execution Details:');
    console.log('  Execution ID:', data.executionId || '(n/a)');
    console.log('  Route ID:', data.routeId || '(n/a)');
    console.log('  Provider:', data.provider || '(n/a)');
    console.log('');
    
    console.log('💰 Transaction:');
    console.log('  Sell Amount:', data.sellAmount || '(n/a)');
    console.log('  Buy Amount:', data.buyAmount || '(n/a)');
    console.log('  Price Impact:', data.priceImpact || '(n/a)');
    
    // Display amount adjustment details if present
    if (data.amountAdjustment) {
      console.log('');
      console.log('🔄 Amount Adjustment (for gas fees):');
      console.log('  Original Amount:', data.amountAdjustment.originalAmount || '(n/a)');
      console.log('  Adjusted Amount:', data.amountAdjustment.adjustedAmount || '(n/a)');
      console.log('  Gas Cost:', data.amountAdjustment.gasCost || '(n/a)');
      console.log('  Reason:', data.amountAdjustment.reason || '(n/a)');
      if (data.amountAdjustment.originalOutputAmount && data.amountAdjustment.adjustedOutputAmount) {
        console.log('  Original Output:', data.amountAdjustment.originalOutputAmount);
        console.log('  Adjusted Output:', data.amountAdjustment.adjustedOutputAmount);
      }
    }
    console.log('');
    
    console.log('🔗 Transaction Hashes:');
    if (Array.isArray(data.transactionHashes) && data.transactionHashes.length > 0) {
      data.transactionHashes.forEach((hash, idx) => {
        console.log(`  ${idx + 1}. ${hash}`);
      });
    } else {
      console.log('  (none)');
    }
    console.log('');
    
    const tracking = data.trackingUrls || [];
    if (tracking.length) {
      console.log('🔍 Tracking URLs:');
      tracking.forEach((t) => console.log(`  - [${t.description}] ${t.url}`));
      console.log('');
    }
    
    console.log('✅ Swap executed successfully!\n');
    process.exit(0);
  } else {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║                    ✗ FAILED                                   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    console.error('❌ Status Code:', res.statusCode);
    console.error('');
    if (res.body?.error) {
      console.error('Error Details:');
      console.error('  Message:', res.body.error.message || res.body.error);
      if (res.body.error.details) {
        console.error('  Details:', JSON.stringify(res.body.error.details, null, 2));
      }
    } else {
      console.error('Response Body:');
      console.error(JSON.stringify(res.body, null, 2));
    }
    console.error('');
    process.exit(1);
  }
})();
