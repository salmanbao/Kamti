/**
 * Unified Token and Chain Configuration
 * Single Source of Truth (SSOT) for all token and chain configurations
 *
 * Design Principles:
 * - Single Responsibility: One file manages all token/chain relationships
 * - DRY: No duplication of token data
 * - SOLID: Proper separation of concerns with interfaces
 * - Maintainability: Easy to add/remove tokens and chains
 */

import {
  BlockchainEcosystem,
  TokenStandard,
} from '@swap/dto/universal-swap-request.dto';

// ==================== CHAIN ID NORMALIZATION ====================
// Some providers (Rubic, Stargate, etc.) return alternative numeric Solana chain IDs
// We standardize ALL Solana identifiers to the canonical 'solana-mainnet' string used in UNIFIED_CHAINS
// This guarantees that downstream lookups (explorers, provider routing, executors) remain consistent.

const SOLANA_CHAIN_ALIASES: Array<string | number> = [
  'solana-mainnet',
  'solana',
  'sol',
  'mainnet-beta', // Common RPC/network alias
  1399811149, // Rubic numeric Solana ID
  7565164, // Alternate/Stargate style Solana ID observed
  '1399811149',
  '7565164',
  900, // Internal/dev numeric aliases (if surfaced)
  901,
  '900',
  '901',
];

const TRON_CHAIN_ALIASES: Array<string | number> = [
  'tron-mainnet',
  'tron',
  'trx',
  195,
  '195',
];

/**
 * Normalize incoming chainId from external aggregators / requests
 * - Converts any known Solana alias (numeric or string) to 'solana-mainnet'
 * - Leaves all other chain IDs unchanged (EVM numeric IDs, other string IDs)
 */
export function normalizeChainId(chainId: string | number): string | number {
  if (chainId === undefined || chainId === null) return chainId;
  const valueStr = chainId.toString().toLowerCase();
  const match = SOLANA_CHAIN_ALIASES.some(
    (a) => a.toString().toLowerCase() === valueStr,
  );
  if (match) return 'solana-mainnet';
  const tronMatch = TRON_CHAIN_ALIASES.some(
    (a) => a.toString().toLowerCase() === valueStr,
  );
  if (tronMatch) return 'tron-mainnet';
  return chainId;
}

// ==================== CORE INTERFACES ====================

export interface UnifiedTokenConfig {
  // Basic token information
  symbol: string;
  name: string;
  decimals: number;
  ecosystem: BlockchainEcosystem;
  standard: TokenStandard;

  // Token characteristics
  isNative: boolean;
  isStablecoin?: boolean;
  coingeckoId?: string;
  iconUrl?: string;
  description?: string;
  website?: string;
  priority: number;

  // Chain-specific deployments
  chainDeployments: Record<string | number, TokenDeployment>;

  // Admin tracking
  addedBy?: string;
  addedAt?: Date;
  isEnabled: boolean;
}

export interface TokenDeployment {
  address: string;
  isEnabled: boolean;
  isNative?: boolean; // Override for native tokens on specific chains
  decimals?: number; // Override if different on this chain
  addedBy?: string;
  addedAt?: Date;
}

export interface UnifiedChainConfig {
  // Chain identification
  chainId: number | string;
  name: string;
  shortName: string;
  ecosystem: BlockchainEcosystem;

  // Network configuration
  rpcUrls: string[];
  explorerUrls: string[];
  iconUrl?: string;
  isEnabled: boolean;
  isTestnet: boolean;

  // Native currency
  nativeCurrency: {
    symbol: string;
    name: string;
    decimals: number;
    iconUrl?: string;
    isEnabled: boolean;
  };

  // Supported aggregators
  supportedAggregators?: string[];

  // Network-specific settings
  networkConfig?: {
    gasPrice?: string;
    gasLimit?: string;
    confirmations?: number;
  };

  // Admin tracking
  addedBy?: string;
  addedAt?: Date;
}

// ==================== CONFIGURATION ENUMS ====================

export enum ConfigValidationError {
  CHAIN_NOT_FOUND = 'CHAIN_NOT_FOUND',
  CHAIN_DISABLED = 'CHAIN_DISABLED',
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
  TOKEN_DISABLED = 'TOKEN_DISABLED',
  TOKEN_NOT_ON_CHAIN = 'TOKEN_NOT_ON_CHAIN',
  NATIVE_CURRENCY_DISABLED = 'NATIVE_CURRENCY_DISABLED',
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
}

// ==================== UNIFIED TOKEN CONFIGURATION ====================

/**
 * APPROVED INPUT TOKENS ONLY (13 tokens)
 *
 * This project only accepts the following tokens as INPUT for swaps:
 * SOL, DOT, DOGE, SHIB, ADA, SUI, AVAX, BNB, HBAR, LTC, POL, TON, XRP
 *
 * OUTPUT tokens can be any token supported by the integrated providers:
 * - EVM Aggregators (0x, Odos, etc.) - thousands of tokens
 * - Meta Aggregators (Rubic - aggregates 360+ DEXs including Socket, Rango, Router) - cross-chain tokens
 * - Native L1 (THORChain, Maya) - native L1 tokens
 * - Solana Aggregators (Rubic) - SPL tokens
 *
 * Only the 13 tokens below are enabled for INPUT validation.
 * All other tokens (ETH, USDT, etc.) are commented out/disabled.
 */

export const UNIFIED_TOKENS: Record<string, UnifiedTokenConfig> = {
  // Solana Native
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    ecosystem: BlockchainEcosystem.SOLANA,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'solana',
    iconUrl: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
    description: 'Native token of the Solana blockchain',
    website: 'https://solana.com',
    priority: 1,
    isEnabled: true,
    chainDeployments: {
      'solana-mainnet': {
        address: 'So11111111111111111111111111111111111111111',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  WETH: {
    symbol: 'WETH',
    name: 'WETH',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.ERC20,
    isNative: false,
    coingeckoId: 'ethereum',
    iconUrl: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    description: 'Native token of the Ethereum blockchain',
    website: 'https://ethereum.org',
    priority: 2,
    isEnabled: true,
    chainDeployments: {
      1: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        isEnabled: true,
        isNative: false,
      },
    },
  },

  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'ethereum',
    iconUrl: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    description: 'Native token of the Ethereum blockchain',
    website: 'https://ethereum.org',
    priority: 2,
    isEnabled: true,
    chainDeployments: {
      1: {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  // BNB (Native on BSC, Token on other EVM chains)
  BNB: {
    symbol: 'BNB',
    name: 'BNB',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'binancecoin',
    iconUrl:
      'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
    description: 'Native token of BNB Smart Chain',
    website: 'https://www.bnbchain.org',
    priority: 3,
    isEnabled: true,
    chainDeployments: {
      56: {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  // MATIC/POL (Native on Polygon) - DISABLED IN PHASE 1
  POL: {
    symbol: 'POL',
    name: 'Polygon Ecosystem Token',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'polygon-ecosystem-token',
    iconUrl:
      'https://assets.coingecko.com/coins/images/4713/large/matic-token-icon.png',
    description: 'Native token of Polygon blockchain',
    website: 'https://polygon.technology',
    priority: 4,
    isEnabled: true,
    chainDeployments: {
      137: {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  // AVAX (Native on Avalanche)
  AVAX: {
    symbol: 'AVAX',
    name: 'Avalanche',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'avalanche-2',
    iconUrl:
      'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
    description: 'Native token of Avalanche blockchain',
    website: 'https://www.avax.network',
    priority: 5,
    isEnabled: true,
    chainDeployments: {
      43114: {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  // Cross-chain tokens - DOT DISABLED IN PHASE 1
  DOT: {
    symbol: 'DOT',
    name: 'Polkadot',
    decimals: 10,
    ecosystem: BlockchainEcosystem.SUBSTRATE,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'polkadot',
    iconUrl:
      'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
    description: 'Native token of Polkadot network',
    website: 'https://polkadot.network',
    priority: 6,
    isEnabled: false,
    chainDeployments: {
      'polkadot-mainnet': {
        address: 'native',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  DOGE: {
    symbol: 'DOGE',
    name: 'Dogecoin',
    decimals: 8,
    ecosystem: BlockchainEcosystem.BITCOIN,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'dogecoin',
    iconUrl: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
    description: 'Dogecoin cryptocurrency',
    website: 'https://dogecoin.com',
    priority: 7,
    isEnabled: false,
    chainDeployments: {
      'dogecoin-mainnet': {
        address: 'native',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  SHIB: {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.ERC20,
    isNative: false,
    coingeckoId: 'shiba-inu',
    iconUrl: 'https://assets.coingecko.com/coins/images/11939/large/shiba.png',
    description: 'Shiba Inu meme token',
    website: 'https://shibatoken.com',
    priority: 8,
    isEnabled: true,
    chainDeployments: {
      1: {
        address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
        isEnabled: true,
      },
    },
  },

  // ARB (Native on Arbitrum) - DISABLED FOR PHASE 1
  ARB: {
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    ecosystem: BlockchainEcosystem.EVM,
    standard: TokenStandard.ERC20,
    isNative: false,
    coingeckoId: 'arbitrum',
    iconUrl:
      'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg',
    description: 'Arbitrum governance token',
    website: 'https://arbitrum.io',
    priority: 9,
    isEnabled: false, // PHASE 1: Disabled
    chainDeployments: {
      42161: {
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        isEnabled: true,
      },
      1: {
        address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1',
        isEnabled: true,
      },
    },
  },

  // === CARDANO ECOSYSTEM (ADA) === - DISABLED FOR PHASE 1
  ADA: {
    symbol: 'ADA',
    name: 'Cardano',
    decimals: 6,
    ecosystem: BlockchainEcosystem.CARDANO,
    standard: TokenStandard.NATIVE,
    isEnabled: false, // PHASE 1: Disabled
    isNative: true,
    coingeckoId: 'cardano',
    iconUrl: 'https://assets.coingecko.com/coins/images/975/large/cardano.png',
    description: 'Native token of Cardano blockchain',
    website: 'https://cardano.org',
    priority: 10,
    chainDeployments: {
      'cardano-mainnet': {
        address: 'native',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  // === SUI ECOSYSTEM (SUI) === - DISABLED FOR PHASE 1
  SUI: {
    symbol: 'SUI',
    name: 'Sui',
    decimals: 9,
    ecosystem: BlockchainEcosystem.SUI,
    standard: TokenStandard.SUI_COIN,
    isNative: true,
    coingeckoId: 'sui',
    iconUrl:
      'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg',
    description: 'Native token of Sui blockchain',
    website: 'https://sui.io',
    priority: 11,
    isEnabled: false, // PHASE 1: Disabled
    chainDeployments: {
      'sui-mainnet': {
        address:
          '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  // HBAR is now supported with Hedera ecosystem - DISABLED FOR PHASE 1
  HBAR: {
    symbol: 'HBAR',
    name: 'Hedera',
    decimals: 8,
    ecosystem: BlockchainEcosystem.HEDERA,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'hedera-hashgraph',
    iconUrl:
      'https://assets.coingecko.com/coins/images/3441/large/Hedera_Hashgraph.png',
    description: 'Native token of Hedera Hashgraph',
    website: 'https://hedera.com',
    priority: 12,
    isEnabled: false, // PHASE 1: Disabled
    chainDeployments: {
      'hedera-mainnet': {
        address: 'native',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  LTC: {
    symbol: 'LTC',
    name: 'Litecoin',
    decimals: 8,
    ecosystem: BlockchainEcosystem.BITCOIN,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'litecoin',
    iconUrl: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
    description: 'Litecoin cryptocurrency',
    website: 'https://litecoin.org',
    priority: 13,
    isEnabled: true,
    chainDeployments: {
      'litecoin-mainnet': {
        address: 'native',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  BTC: {
    symbol: 'BTC',
    name: 'Bitcoin',
    decimals: 8,
    ecosystem: BlockchainEcosystem.BITCOIN,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'bitcoin',
    iconUrl: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    description: 'Bitcoin cryptocurrency',
    website: 'https://bitcoin.org',
    priority: 14,
    isEnabled: true,
    chainDeployments: {
      'bitcoin-mainnet': {
        address: 'native',
        isEnabled: true,
        isNative: true,
      },
    },
  },

  // TON is now supported with TON ecosystem
  TON: {
    symbol: 'TON',
    name: 'The Open Network',
    decimals: 9,
    ecosystem: BlockchainEcosystem.TON,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'the-open-network',
    iconUrl:
      'https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png',
    description: 'Native token of TON blockchain',
    website: 'https://ton.org',
    priority: 15,
    isEnabled: false, // PHASE 1: Disabled
    chainDeployments: {
      'ton-mainnet': {
        address: 'native',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  // XRP is now supported with XRPL ecosystem - DISABLED FOR PHASE 1
  XRP: {
    symbol: 'XRP',
    name: 'XRP',
    decimals: 6,
    ecosystem: BlockchainEcosystem.XRPL,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'ripple',
    iconUrl:
      'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
    description: 'Native token of XRP Ledger',
    website: 'https://xrpl.org',
    priority: 16,
    isEnabled: false, // PHASE 1: Disabled
    chainDeployments: {
      'xrpl-mainnet': {
        address: 'native',
        isEnabled: false,
        isNative: true,
      },
    },
  },

  // USDT - Multi-chain stablecoin (PHASE 1: ERC20, BEP20, TRC20, Solana)
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6, // Most common, but varies by chain
    ecosystem: BlockchainEcosystem.EVM, // Primary ecosystem
    standard: TokenStandard.ERC20,
    isNative: false,
    isStablecoin: true,
    coingeckoId: 'tether',
    iconUrl: 'https://assets.coingecko.com/coins/images/325/large/Tether.png',
    description: 'Tether USD stablecoin available on multiple chains',
    website: 'https://tether.to',
    priority: 17,
    isEnabled: true,
    chainDeployments: {
      // Ethereum (ERC20)
      1: {
        address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        isEnabled: true,
        decimals: 6,
      },
      // BSC (BEP20)
      56: {
        address: '0x55d398326f99059fF775485246999027B3197955',
        isEnabled: true,
        decimals: 18, // Different on BSC
      },
      // Tron (TRC20)
      'tron-mainnet': {
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        isEnabled: true,
        decimals: 6,
      },
      // Solana
      'solana-mainnet': {
        address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        isEnabled: true,
        decimals: 6,
      },
      // Disabled chains for Phase 1
      137: {
        address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
        isEnabled: false,
        decimals: 6,
      },
      42161: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        isEnabled: false,
        decimals: 6,
      },
      10: {
        address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
        isEnabled: false,
        decimals: 6,
      },
      8453: {
        address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
        isEnabled: false,
        decimals: 6,
      },
      43114: {
        address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
        isEnabled: true,
        decimals: 6,
      },
    },
  },

  // USDC - Multi-chain stablecoin (PHASE 1: ERC20, BEP20, TRC20, Solana)
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6, // Standard across most chains
    ecosystem: BlockchainEcosystem.EVM, // Primary ecosystem
    standard: TokenStandard.ERC20,
    isNative: false,
    isStablecoin: true,
    coingeckoId: 'usd-coin',
    iconUrl:
      'https://assets.coingecko.com/coins/images/6319/large/USD_Coin_icon.png',
    description: 'USD Coin stablecoin available on multiple chains',
    website: 'https://www.circle.com/usdc',
    priority: 18,
    isEnabled: true,
    chainDeployments: {
      // Ethereum (ERC20)
      1: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        isEnabled: true,
        decimals: 6,
      },
      // BSC (BEP20)
      56: {
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        isEnabled: true,
        decimals: 18, // Different on BSC
      },
      // Tron (TRC20)
      'tron-mainnet': {
        address: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
        isEnabled: true,
        decimals: 6,
      },
      // Solana
      'solana-mainnet': {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        isEnabled: true,
        decimals: 6,
      },
      // Disabled chains for Phase 1
      137: {
        address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        isEnabled: false,
        decimals: 6,
      },
      42161: {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        isEnabled: false,
        decimals: 6,
      },
      10: {
        address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        isEnabled: false,
        decimals: 6,
      },
      8453: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        isEnabled: false,
        decimals: 6,
      },
      43114: {
        address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        isEnabled: false,
        decimals: 6,
      },
    },
  },

  // TRX (Native Tron) - DISABLED FOR PHASE 1
  TRX: {
    symbol: 'TRX',
    name: 'Tron',
    decimals: 6,
    ecosystem: BlockchainEcosystem.TRON,
    standard: TokenStandard.NATIVE,
    isNative: true,
    coingeckoId: 'tron',
    iconUrl:
      'https://assets.coingecko.com/coins/images/1094/large/tron-logo.png',
    description: 'Native token of Tron blockchain',
    website: 'https://tron.network',
    priority: 19,
    isEnabled: true,
    chainDeployments: {
      'tron-mainnet': {
        address: 'native',
        isEnabled: true,
        isNative: true,
      },
    },
  },
};

// ==================== UNIFIED CHAIN CONFIGURATION ====================

export const UNIFIED_CHAINS: Record<string, UnifiedChainConfig> = {
  // Ethereum Mainnet
  'ethereum-1': {
    chainId: 1,
    name: 'Ethereum Mainnet',
    shortName: 'ethereum',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://eth-mainnet.nodereal.io/v1/6e53ce6a65b0401fa20f3acf5074c335',
      'https://ethereum.publicnode.com',
      'https://eth.llamarpc.com',
      'https://eth.drpc.org',
      'https://rpc.payload.de',
    ],
    explorerUrls: ['https://etherscan.io'],
    iconUrl: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // BNB Smart Chain
  'bsc-56': {
    chainId: 56,
    name: 'BNB Smart Chain',
    shortName: 'bsc',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://bsc-dataseed1.binance.org',
      'https://bsc.llamarpc.com',
      'https://binance.llamarpc.com',
      'https://bsc-dataseed2.binance.org',
      'https://bsc.publicnode.com',
    ],
    explorerUrls: ['https://bscscan.com'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'BNB',
      name: 'BNB',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Polygon
  'polygon-137': {
    chainId: 137,
    name: 'Polygon',
    shortName: 'polygon',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon-rpc.com',
      'https://rpc-mainnet.matic.network',
      'https://polygon.llamarpc.com',
    ],
    explorerUrls: ['https://polygonscan.com'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/4713/large/matic-token-icon.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'POL',
      name: 'Polygon Ecosystem Token',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/4713/large/matic-token-icon.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Arbitrum One
  'arbitrum-42161': {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'arbitrum',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.llamarpc.com',
      'https://arbitrum-one.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://rpc.owlracle.info/arb/70d38ce1826c4a60bb2a8e05a6c8b20f',
    ],
    explorerUrls: ['https://arbiscan.io'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Avalanche C-Chain
  'avalanche-43114': {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    shortName: 'avalanche',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.llamarpc.com',
      'https://api.avax.network/ext/bc/C/rpc',
      'https://avalanche-c-chain.publicnode.com',
      'https://avalanche.drpc.org',
    ],
    explorerUrls: ['https://snowtrace.io'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'AVAX',
      name: 'Avalanche',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Base
  'base-8453': {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://base.llamarpc.com',
      'https://mainnet.base.org',
      'https://base.publicnode.com',
      'https://base.drpc.org',
    ],
    explorerUrls: ['https://basescan.org'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/7598/large/wrapped_bitcoin_wbtc.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Optimism
  'optimism-10': {
    chainId: 10,
    name: 'Optimism',
    shortName: 'optimism',
    ecosystem: BlockchainEcosystem.EVM,
    rpcUrls: [
      'https://optimism.drpc.org',
      'https://mainnet.optimism.io',
      'https://optimism.llamarpc.com',
      'https://optimism.publicnode.com',
      'https://public-op-mainnet.fastnode.io',
    ],
    explorerUrls: ['https://optimistic.etherscan.io'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/25244/large/Optimism.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      iconUrl:
        'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
      isEnabled: true,
    },
    supportedAggregators: ['0x', 'odos', 'rubic'],
  },

  // Solana Mainnet
  'solana-mainnet': {
    chainId: 'solana-mainnet',
    name: 'Solana Mainnet',
    shortName: 'solana',
    ecosystem: BlockchainEcosystem.SOLANA,
    rpcUrls: [
      // TODO: Add premium RPC provider (Helius, QuickNode, or Alchemy)
      // Example: 'https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY',

      // Free public endpoints (rate-limited, may return 403 errors)
      'https://api.mainnet-beta.solana.com',
      'https://solana-api.projectserum.com',
      'https://solana.publicnode.com',
      'https://rpc.ankr.com/solana',

      // Additional fallback endpoints
      'https://solana-mainnet.rpc.extrnode.com',
      'https://solana.getblock.io/mainnet',
      // Removed: 'https://mainnet.rpcpool.com', // Requires API key, returns 403 Forbidden
    ],
    explorerUrls: ['https://explorer.solana.com'],
    iconUrl: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      iconUrl:
        'https://assets.coingecko.com/coins/images/4128/large/solana.png',
      isEnabled: true,
    },
    supportedAggregators: ['rubic'],
  },

  // Tron Mainnet
  'tron-mainnet': {
    chainId: 'tron-mainnet',
    name: 'Tron Mainnet',
    shortName: 'tron',
    ecosystem: BlockchainEcosystem.TRON,
    rpcUrls: ['https://api.trongrid.io', 'https://api.shasta.trongrid.io'],
    explorerUrls: ['https://tronscan.org'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/1094/large/tron-logo.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'TRX',
      name: 'Tron',
      decimals: 6,
      iconUrl:
        'https://assets.coingecko.com/coins/images/1094/large/tron-logo.png',
      isEnabled: true,
    },
    supportedAggregators: ['rubic', 'symbiosis'],
  },

  // SUI Mainnet
  'sui-mainnet': {
    chainId: 'sui-mainnet',
    name: 'Sui Mainnet',
    shortName: 'sui',
    ecosystem: BlockchainEcosystem.SUI,
    rpcUrls: [
      'https://fullnode.mainnet.sui.io:443',
      'https://sui-mainnet.nodeinfra.com',
      'https://sui-mainnet-rpc.allthatnode.com',
      'https://sui-rpc.publicnode.com',
    ],
    explorerUrls: ['https://suiscan.xyz/mainnet', 'https://suivision.xyz'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'SUI',
      name: 'Sui',
      decimals: 9,
      iconUrl:
        'https://assets.coingecko.com/coins/images/26375/large/sui_asset.jpeg',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // Bitcoin Mainnet
  'bitcoin-mainnet': {
    chainId: 'bitcoin-mainnet',
    name: 'Bitcoin Mainnet',
    shortName: 'bitcoin',
    ecosystem: BlockchainEcosystem.BITCOIN,
    rpcUrls: [
      'https://blockstream.info/api',
      'https://mempool.space/api',
      'https://api.blockcypher.com/v1/btc/main',
      'https://blockchain.info',
    ],
    explorerUrls: ['https://blockstream.info', 'https://blockchain.info'],
    iconUrl: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'BTC',
      name: 'Bitcoin',
      decimals: 8,
      iconUrl: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
      isEnabled: true,
    },
    supportedAggregators: ['rubic'],
  },

  // Litecoin Mainnet
  'litecoin-mainnet': {
    chainId: 'litecoin-mainnet',
    name: 'Litecoin Mainnet',
    shortName: 'litecoin',
    ecosystem: BlockchainEcosystem.BITCOIN,
    rpcUrls: [
      'https://litecoinspace.org/api',
      'https://blockstream.info/litecoin/api',
      'https://api.blockcypher.com/v1/ltc/main',
      'https://ltc.nownodes.io',
    ],
    explorerUrls: [
      'https://blockstream.info/litecoin',
      'https://live.blockcypher.com/ltc',
    ],
    iconUrl: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
    isEnabled: true,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'LTC',
      name: 'Litecoin',
      decimals: 8,
      iconUrl: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png',
      isEnabled: true,
    },
    supportedAggregators: ['rubic'],
  },

  // Polkadot Mainnet
  'polkadot-mainnet': {
    chainId: 'polkadot-mainnet',
    name: 'Polkadot Mainnet',
    shortName: 'polkadot',
    ecosystem: BlockchainEcosystem.SUBSTRATE,
    rpcUrls: [
      'https://polkadot.api.onfinality.io/public',
      'https://rpc.polkadot.io',
      'https://polkadot-rpc.dwellir.com',
      'https://polkadot.public.curie.radiumblock.co/http',
    ],
    explorerUrls: [
      'https://polkadot.subscan.io',
      'https://polkadot.js.org/apps',
    ],
    iconUrl:
      'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'DOT',
      name: 'Polkadot',
      decimals: 10,
      iconUrl:
        'https://assets.coingecko.com/coins/images/12171/large/polkadot.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // Dogecoin Mainnet
  'dogecoin-mainnet': {
    chainId: 'dogecoin-mainnet',
    name: 'Dogecoin Mainnet',
    shortName: 'dogecoin',
    ecosystem: BlockchainEcosystem.BITCOIN,
    rpcUrls: [
      'https://api.blockcypher.com/v1/doge/main',
      'https://dogechain.info/api',
      'https://doge.nownodes.io',
    ],
    explorerUrls: ['https://dogechain.info', 'https://blockchair.com/dogecoin'],
    iconUrl: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'DOGE',
      name: 'Dogecoin',
      decimals: 8,
      iconUrl: 'https://assets.coingecko.com/coins/images/5/large/dogecoin.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // Cardano Mainnet
  'cardano-mainnet': {
    chainId: 'cardano-mainnet',
    name: 'Cardano Mainnet',
    shortName: 'cardano',
    ecosystem: BlockchainEcosystem.CARDANO,
    rpcUrls: [
      'https://cardano-mainnet.blockfrost.io/api/v0',
      'https://cardano-mainnet-api.token.tools',
      'https://ada.nownodes.io',
    ],
    explorerUrls: ['https://cardanoscan.io', 'https://explorer.cardano.org'],
    iconUrl: 'https://assets.coingecko.com/coins/images/975/large/cardano.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'ADA',
      name: 'Cardano',
      decimals: 6,
      iconUrl:
        'https://assets.coingecko.com/coins/images/975/large/cardano.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // Hedera Mainnet
  'hedera-mainnet': {
    chainId: 'hedera-mainnet',
    name: 'Hedera Mainnet',
    shortName: 'hedera',
    ecosystem: BlockchainEcosystem.HEDERA,
    rpcUrls: [
      'https://mainnet-public.mirrornode.hedera.com',
      'https://mainnet.hashio.io/api',
      'https://hedera-mainnet.g.allthatnode.com',
    ],
    explorerUrls: [
      'https://hashscan.io/mainnet',
      'https://explorer.kabuto.sh/mainnet',
    ],
    iconUrl:
      'https://assets.coingecko.com/coins/images/3441/large/Hedera_Hashgraph.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'HBAR',
      name: 'Hedera',
      decimals: 8,
      iconUrl:
        'https://assets.coingecko.com/coins/images/3441/large/Hedera_Hashgraph.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // TON Mainnet
  'ton-mainnet': {
    chainId: 'ton-mainnet',
    name: 'TON Mainnet',
    shortName: 'ton',
    ecosystem: BlockchainEcosystem.TON,
    rpcUrls: [
      'https://toncenter.com/api/v2/jsonRPC',
      'https://mainnet.tonhubapi.com/jsonRPC',
      'https://ton.access.orbs.network/mainnet/http',
    ],
    explorerUrls: ['https://tonscan.org', 'https://explorer.toncoin.org'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'TON',
      name: 'The Open Network',
      decimals: 9,
      iconUrl:
        'https://assets.coingecko.com/coins/images/17980/large/ton_symbol.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },

  // XRP Ledger Mainnet
  'xrpl-mainnet': {
    chainId: 'xrpl-mainnet',
    name: 'XRP Ledger Mainnet',
    shortName: 'xrpl',
    ecosystem: BlockchainEcosystem.XRPL,
    rpcUrls: [
      'https://xrplcluster.com',
      'https://s1.ripple.com:51234',
      'https://xrpl.ws',
      'https://s2.ripple.com:51234',
    ],
    explorerUrls: ['https://livenet.xrpl.org', 'https://xrpscan.com'],
    iconUrl:
      'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
    isEnabled: false,
    isTestnet: false,
    nativeCurrency: {
      symbol: 'XRP',
      name: 'XRP',
      decimals: 6,
      iconUrl:
        'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png',
      isEnabled: false,
    },
    supportedAggregators: ['rubic'],
  },
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get token configuration by symbol with optional chain-specific overrides
 *
 * @param symbol - Token symbol (e.g., 'USDT', 'ETH')
 * @param chainId - Optional chain ID to apply chain-specific overrides (decimals, address)
 * @returns Token configuration with chain-specific overrides applied, or null if not found
 *
 * @example
 * // Get base USDT config (defaults to 6 decimals)
 * const usdtBase = getUnifiedTokenConfig('USDT');
 *
 * // Get USDT config for Ethereum (6 decimals)
 * const usdtEth = getUnifiedTokenConfig('USDT', 1);
 *
 * // Get USDT config for BSC (18 decimals - chain-specific override)
 * const usdtBsc = getUnifiedTokenConfig('USDT', 56);
 */
export function getUnifiedTokenConfig(
  symbol: string,
  chainId?: string | number,
): UnifiedTokenConfig | null {
  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  if (!baseToken) return null;

  // If no chainId provided, return base configuration
  if (chainId === undefined || chainId === null) {
    return baseToken;
  }

  // Normalize chainId to handle aliases
  const normalizedChainId = normalizeChainId(chainId);

  // Find chain-specific deployment
  const deployment = baseToken.chainDeployments[normalizedChainId.toString()];

  if (!deployment) {
    // Token not deployed on this chain - return base config
    return baseToken;
  }

  // Create enriched config with chain-specific overrides
  return {
    ...baseToken,
    // CRITICAL: Always use deployment decimals if available
    // This ensures tokens like USDT use correct decimals per chain:
    // - Ethereum: 6 decimals
    // - BSC: 18 decimals
    // - Tron: 6 decimals
    decimals: deployment.decimals ?? baseToken.decimals,
    // Use chain-specific address
    address: deployment.address,
    // Include chain context for reference
    chainId: normalizedChainId,
    // Preserve deployment-specific flags
    isNative: deployment.isNative ?? baseToken.isNative,
  } as UnifiedTokenConfig & { address: string; chainId: string | number };
}

/**
 * Get chain configuration by chain ID or key
 *
 * Multi-strategy lookup to handle various chain ID formats:
 * 1. Direct key lookup (e.g., 'ethereum-1', 'solana-mainnet')
 * 2. Numeric chainId matching (e.g., 1 → ethereum-1, 56 → bsc-56)
 * 3. String chainId matching (e.g., 'solana-mainnet' in config)
 *
 * This ensures that normalized IDs (e.g., 7565164 → 'solana-mainnet')
 * can be properly resolved even when the lookup key differs from chainId property.
 */
export function getUnifiedChainConfig(
  chainId: string | number,
): UnifiedChainConfig | null {
  // First apply normalization (e.g. 7565164 -> 'solana-mainnet', 195 -> 'tron-mainnet')
  const normalized = normalizeChainId(chainId);

  // Strategy 1: Direct key lookup
  // Try to find the chain config using the normalized value as the key
  const config = UNIFIED_CHAINS[normalized.toString()];
  if (config) return config;

  // Strategy 2: Numeric chainId match
  // For numeric IDs, search all configs where chainId property matches
  // This handles cases like chainId=1 → 'ethereum-1' key, or chainId=56 → 'bsc-56' key
  if (typeof normalized === 'number') {
    const numericMatch = Object.values(UNIFIED_CHAINS).find(
      (chain) => chain.chainId === normalized,
    );
    if (numericMatch) return numericMatch;
  }

  // Strategy 3: String chainId match
  // For string IDs, search configs where chainId property matches the normalized value
  // This handles non-EVM chains like Solana where chainId='solana-mainnet' (string, not number)
  if (typeof normalized === 'string') {
    const stringMatch = Object.values(UNIFIED_CHAINS).find(
      (chain) =>
        chain.chainId === normalized || chain.chainId.toString() === normalized,
    );
    if (stringMatch) return stringMatch;
  }

  // Strategy 4: Parse as number and retry
  // Final fallback: try parsing string as number for edge cases
  const maybeNumber =
    typeof normalized === 'string' ? parseInt(normalized, 10) : null;
  if (maybeNumber !== null && !Number.isNaN(maybeNumber)) {
    const parsedNumericMatch = Object.values(UNIFIED_CHAINS).find(
      (chain) => chain.chainId === maybeNumber,
    );
    if (parsedNumericMatch) return parsedNumericMatch;
  }

  // No match found - return null
  // Log available chains for debugging
  console.warn(
    `Chain ${chainId} (normalized: ${normalized}) not found. Available chains: ${Object.keys(UNIFIED_CHAINS).join(', ')}`,
  );
  return null;
}

/**
 * Get all tokens available on a specific chain
 */
export function getTokensOnChain(
  chainId: string | number,
): UnifiedTokenConfig[] {
  const normalizedChainId = normalizeChainId(chainId);
  const chainKey = normalizedChainId.toString();
  return Object.values(UNIFIED_TOKENS).filter(
    (token) =>
      chainKey in token.chainDeployments &&
      token.chainDeployments[chainKey].isEnabled,
  );
}

/**
 * Get token address on a specific chain
 */
export function getTokenAddress(
  symbol: string,
  chainId: string | number,
): string | null {
  const token = getUnifiedTokenConfig(symbol, chainId);
  if (!token) return null;

  const normalizedChainId = normalizeChainId(chainId);
  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  if (!baseToken) return null;

  const deployment = baseToken.chainDeployments[normalizedChainId.toString()];
  return deployment?.isEnabled ? deployment.address : null;
}

/**
 * Validate token decimals for a specific chain
 *
 * Ensures that the expected decimals match the configured decimals for a token on a chain.
 * This is critical for tokens with varying decimals across chains (USDT, USDC, etc.)
 *
 * @param tokenAddress - Token address or symbol
 * @param chainId - Chain ID to validate against
 * @param expectedDecimals - Optional expected decimals to validate
 * @returns Validation result with actual decimals and any mismatches
 *
 * @example
 * // Validate USDT decimals on Ethereum (should be 6)
 * validateTokenDecimals('USDT', 1, 6); // ✓ Valid
 *
 * // Validate USDT decimals on BSC (should be 18, not 6)
 * validateTokenDecimals('USDT', 56, 6); // ✗ Invalid - mismatch
 */
export function validateTokenDecimals(
  tokenAddress: string,
  chainId: string | number,
  expectedDecimals?: number,
): {
  isValid: boolean;
  actualDecimals?: number;
  expectedDecimals?: number;
  message?: string;
  warning?: string;
} {
  // Try to find token by symbol first
  let token = getUnifiedTokenConfig(tokenAddress, chainId);

  // If not found by symbol, try to find by address
  if (!token) {
    const normalizedChainId = normalizeChainId(chainId);
    const foundToken = Object.values(UNIFIED_TOKENS).find((t) => {
      const deployment = t.chainDeployments[normalizedChainId.toString()];
      return deployment?.address.toLowerCase() === tokenAddress.toLowerCase();
    });

    if (foundToken) {
      token = getUnifiedTokenConfig(foundToken.symbol, chainId);
    }
  }

  if (!token) {
    return {
      isValid: false,
      message: `Token ${tokenAddress} not found in configuration for chain ${chainId}`,
    };
  }

  const actualDecimals = token.decimals;

  // If expected decimals not provided, just return actual decimals
  if (expectedDecimals === undefined) {
    return {
      isValid: true,
      actualDecimals,
      warning: 'No expected decimals provided for validation',
    };
  }

  // Validate decimals match
  if (actualDecimals !== expectedDecimals) {
    return {
      isValid: false,
      actualDecimals,
      expectedDecimals,
      message: `Decimals mismatch for ${token.symbol} on chain ${chainId}. Expected: ${expectedDecimals}, Actual: ${actualDecimals}`,
    };
  }

  return {
    isValid: true,
    actualDecimals,
    expectedDecimals,
  };
}

/**
 * Check if token is supported on chain
 */
export function isTokenSupportedOnChain(
  symbol: string,
  chainId: string | number,
): boolean {
  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  if (!baseToken || !baseToken.isEnabled) return false;

  const normalizedChainId = normalizeChainId(chainId);
  const deployment = baseToken.chainDeployments[normalizedChainId.toString()];
  return deployment?.isEnabled || false;
}

/**
 * Check if chain is supported
 */
export function isChainSupported(chainId: string | number): boolean {
  const chain = getUnifiedChainConfig(chainId);
  return chain?.isEnabled || false;
}

/**
 * Get all supported chains
 */
export function getSupportedChains(): UnifiedChainConfig[] {
  return Object.values(UNIFIED_CHAINS).filter((chain) => chain.isEnabled);
}

/**
 * Get all supported tokens
 */
export function getSupportedTokens(): UnifiedTokenConfig[] {
  return Object.values(UNIFIED_TOKENS).filter((token) => token.isEnabled);
}

/**
 * Get cross-chain deployments for a token
 */
export function getTokenCrossChainDeployments(
  symbol: string,
): Record<string, TokenDeployment> {
  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  return baseToken?.chainDeployments || {};
}

/**
 * Configuration validation
 */
export function validateTokenChainConfiguration(
  symbol: string,
  chainId: string | number,
): {
  isValid: boolean;
  error?: ConfigValidationError;
  message?: string;
} {
  // Normalize chainId for consistent lookups
  const normalizedChainId = normalizeChainId(chainId);

  // Check if chain exists
  const chain = getUnifiedChainConfig(normalizedChainId);
  if (!chain) {
    return {
      isValid: false,
      error: ConfigValidationError.CHAIN_NOT_FOUND,
      message: `Chain ${chainId} (normalized: ${normalizedChainId}) is not configured`,
    };
  }

  // Check if chain is enabled
  if (!chain.isEnabled) {
    return {
      isValid: false,
      error: ConfigValidationError.CHAIN_DISABLED,
      message: `Chain ${chainId} is disabled`,
    };
  }

  // Check if token exists
  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  if (!baseToken) {
    return {
      isValid: false,
      error: ConfigValidationError.TOKEN_NOT_FOUND,
      message: `Token ${symbol} is not configured`,
    };
  }

  // Check if token is enabled globally
  if (!baseToken.isEnabled) {
    return {
      isValid: false,
      error: ConfigValidationError.TOKEN_DISABLED,
      message: `Token ${symbol} is globally disabled`,
    };
  }

  // Check if token is deployed on chain
  const deployment = baseToken.chainDeployments[normalizedChainId.toString()];
  if (!deployment) {
    return {
      isValid: false,
      error: ConfigValidationError.TOKEN_NOT_ON_CHAIN,
      message: `Token ${symbol} is not deployed on chain ${chainId}`,
    };
  }

  // Check if token deployment is enabled
  if (!deployment.isEnabled) {
    return {
      isValid: false,
      error: ConfigValidationError.TOKEN_DISABLED,
      message: `Token ${symbol} is disabled on chain ${chainId}`,
    };
  }

  return { isValid: true };
}

// ==================== INPUT TOKEN RESTRICTIONS ====================

/**
 * List of approved input tokens only - PHASE 1
 * These are the ONLY tokens that can be used as sellToken in swap requests
 *
 * Phase 1 includes: SOL, BTC, USDC, ETH, USDT, DOGE, SHIB, AVAX, BNB, LTC
 */
export const APPROVED_INPUT_TOKENS = [
  'SOL', // Solana
  'TRX', // Tron
  'BTC', // Bitcoin
  'USDC', // USD Coin (Multi-chain: ERC20, BEP20, TRC20, Solana)
  'ETH', // Ethereum
  'WETH', // Ethereum
  'POL', // Polygon
  'USDT', // Tether USD (Multi-chain: ERC20, BEP20, TRC20, Solana)
  'DOGE', // Dogecoin
  'SHIB', // Shiba Inu (ERC20)
  'AVAX', // Avalanche
  'BNB', // BNB Chain
  'LTC', // Litecoin
] as const;

/**
 * Type for approved input tokens
 */
export type ApprovedInputToken = (typeof APPROVED_INPUT_TOKENS)[number];

/**
 * Check if token symbol is approved for input (sellToken)
 */
export function isApprovedInputToken(symbol: string): boolean {
  return APPROVED_INPUT_TOKENS.includes(
    symbol.toUpperCase() as ApprovedInputToken,
  );
}

/**
 * Get only approved input tokens from unified configuration
 */
export function getApprovedInputTokens(): UnifiedTokenConfig[] {
  return APPROVED_INPUT_TOKENS.map((symbol) =>
    getUnifiedTokenConfig(symbol),
  ).filter(
    (token): token is UnifiedTokenConfig => token !== null && token.isEnabled,
  );
}

/**
 * Validate sellToken against approved input list
 */
export function validateInputToken(symbol: string): {
  isValid: boolean;
  error?: string;
  approvedTokens?: string[];
} {
  if (!isApprovedInputToken(symbol)) {
    return {
      isValid: false,
      error: `Token ${symbol} is not approved for input. Only the following tokens can be used as sellToken: ${APPROVED_INPUT_TOKENS.join(', ')}`,
      approvedTokens: [...APPROVED_INPUT_TOKENS],
    };
  }

  const baseToken = UNIFIED_TOKENS[symbol.toUpperCase()];
  if (!baseToken || !baseToken.isEnabled) {
    return {
      isValid: false,
      error: `Token ${symbol} is not enabled or configured`,
      approvedTokens: [...APPROVED_INPUT_TOKENS],
    };
  }

  return { isValid: true };
}
