/**
 * Chain Detection Configuration
 *
 * Centralizes chain ID mappings and ecosystem detection logic.
 * This is the single source of truth for chain identification.
 */

export type Ecosystem = 'evm' | 'solana' | 'tron' | 'bitcoin';

export interface ChainMapping {
  ecosystem: Ecosystem;
  chainIds: Array<number | string>;
  aliases: string[];
}

export interface ChainDetectionConfig {
  // Ecosystem mappings by chain name
  ecosystemMappings: Record<string, ChainMapping>;

  // Provider-specific chain ID mappings
  providerSpecificIds: Record<string, Record<string, number | string>>;
}

/**
 * Default Chain Detection Configuration
 *
 * IMPORTANT:
 * - Rubic uses non-standard chain IDs (e.g., 1151111081099710 for Solana)
 * - Always check both numeric and string representations
 * - Aliases help with case-insensitive matching
 */
export const CHAIN_DETECTION_CONFIG: ChainDetectionConfig = {
  ecosystemMappings: {
    // EVM Chains
    ethereum: {
      ecosystem: 'evm',
      chainIds: [1, '1', 'eth-mainnet', 'ethereum-mainnet'],
      aliases: ['ethereum', 'eth', 'mainnet'],
    },
    bsc: {
      ecosystem: 'evm',
      chainIds: [56, '56', 'bsc-mainnet'],
      aliases: ['bsc', 'binance-smart-chain', 'bnb'],
    },
    polygon: {
      ecosystem: 'evm',
      chainIds: [137, '137', 'polygon-mainnet', 'matic-mainnet'],
      aliases: ['polygon', 'matic'],
    },
    arbitrum: {
      ecosystem: 'evm',
      chainIds: [42161, '42161', 'arbitrum-mainnet'],
      aliases: ['arbitrum', 'arb'],
    },
    optimism: {
      ecosystem: 'evm',
      chainIds: [10, '10', 'optimism-mainnet'],
      aliases: ['optimism', 'op'],
    },
    avalanche: {
      ecosystem: 'evm',
      chainIds: [43114, '43114', 'avalanche-mainnet'],
      aliases: ['avalanche', 'avax'],
    },
    fantom: {
      ecosystem: 'evm',
      chainIds: [250, '250', 'fantom-mainnet'],
      aliases: ['fantom', 'ftm'],
    },

    // Non-EVM Chains
    solana: {
      ecosystem: 'solana',
      chainIds: [
        900, // Convention: mainnet
        901, // Convention: devnet
        1151111081099710, // Rubic primary Solana mainnet chainId
        7565164, // Rubic variant Solana mainnet chainId
        'solana-mainnet',
        'solana-devnet',
        'mainnet-beta',
        'devnet',
      ],
      aliases: ['solana', 'sol'],
    },

    tron: {
      ecosystem: 'tron',
      chainIds: [195, '195', 'tron-mainnet'],
      aliases: ['tron', 'trx'],
    },

    bitcoin: {
      ecosystem: 'bitcoin',
      chainIds: [5555, '5555', 'bitcoin-mainnet'], // Rubic's Bitcoin ID
      aliases: ['bitcoin', 'btc'],
    },
  },

  providerSpecificIds: {
    rubic: {
      solana: 1151111081099710,
      solanaVariant: 7565164,
      bitcoin: 5555,
    },
    // Add more providers as needed
  },
};

/**
 * Helper function to detect ecosystem from chain ID
 */
export function detectEcosystemFromChainId(
  chainId: number | string,
  config: ChainDetectionConfig = CHAIN_DETECTION_CONFIG,
): Ecosystem {
  const chainIdStr = String(chainId).toLowerCase();
  const chainIdNum =
    typeof chainId === 'number' ? chainId : parseInt(String(chainId), 10);

  // Check each ecosystem mapping
  for (const [_name, mapping] of Object.entries(config.ecosystemMappings)) {
    // Check if chainId matches any of the registered IDs
    const matches = mapping.chainIds.some((id) => {
      if (typeof id === 'number') {
        return id === chainIdNum;
      }
      return String(id).toLowerCase() === chainIdStr;
    });

    if (matches) {
      return mapping.ecosystem;
    }

    // Check aliases
    const aliasMatch = mapping.aliases.some((alias) =>
      chainIdStr.includes(alias.toLowerCase()),
    );

    if (aliasMatch) {
      return mapping.ecosystem;
    }
  }

  // Default to EVM if no match found
  return 'evm';
}

/**
 * Helper function to check if chain ID belongs to specific ecosystem
 */
export function isChainIdInEcosystem(
  chainId: number | string,
  ecosystem: Ecosystem,
  config: ChainDetectionConfig = CHAIN_DETECTION_CONFIG,
): boolean {
  return detectEcosystemFromChainId(chainId, config) === ecosystem;
}
