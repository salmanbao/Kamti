/**
 * Chain utility service for backward compatibility
 *
 * This service provides a legacy interface (ChainConfig) for existing code
 * while using UNIFIED_CHAINS as the single source of truth.
 *
 * Architecture:
 * - Data Source: UNIFIED_CHAINS (unified-token-configuration.config.ts)
 * - RPC URLs: Fetched from UNIFIED_CHAINS configuration (no longer from environment)
 * - Purpose: Backward compatibility bridge
 *
 * @deprecated Consider migrating to UnifiedConfigurationService for new code
 */

import { Injectable } from '@nestjs/common';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import {
  UNIFIED_TOKENS,
  UNIFIED_CHAINS,
  getTokensOnChain,
  getUnifiedChainConfig,
  isTokenSupportedOnChain,
  getTokenAddress,
  getSupportedChains,
} from '@shared/config/unified-token-configuration.config';
import { normalizeChainId } from '@shared/config/unified-token-configuration.config';
import { isNativeToken as isNativeTokenUtil } from '@shared/utils/token-address.utils';

export enum SupportedChain {
  ETHEREUM = 1,
  POLYGON = 137,
  BSC = 56,
  ARBITRUM = 42161,
  OPTIMISM = 10,
  BASE = 8453,
  AVALANCHE = 43114,
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  blockExplorer: string;
  supportedTokens?: string[]; // Array of supported token symbols
}

export const NATIVE_TOKEN_ADDRESS =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/**
 * Chain utility service that uses UNIFIED_CHAINS as source of truth
 * @injectable
 */
@Injectable()
export class ChainUtilsService {
  constructor(private readonly envConfig: EnvironmentConfigService) {}

  /**
   * Get all supported chains from UNIFIED_CHAINS
   * Converts to ChainConfig format for backward compatibility
   */
  getChainConfigs(): Record<SupportedChain, ChainConfig> {
    const configs: Record<SupportedChain, ChainConfig> = {} as Record<
      SupportedChain,
      ChainConfig
    >;

    // Get all enabled chains from UNIFIED_CHAINS
    const supportedChains = getSupportedChains();

    supportedChains.forEach((unifiedChain) => {
      const chainId = unifiedChain.chainId as number;

      // Only process EVM chains that are in our SupportedChain enum
      if (Object.values(SupportedChain).includes(chainId)) {
        configs[chainId as SupportedChain] = {
          chainId,
          name: unifiedChain.name,
          rpcUrl: this.getRpcUrlsForChain(chainId)[0] || '',
          nativeCurrency: {
            name: unifiedChain.nativeCurrency.name,
            symbol: unifiedChain.nativeCurrency.symbol,
            decimals: unifiedChain.nativeCurrency.decimals,
          },
          blockExplorer: unifiedChain.explorerUrls[0] || '',
          supportedTokens: getTokensOnChain(chainId).map((t) => t.symbol),
        };
      }
    });

    return configs;
  }

  /**
   * Get chain configuration by chain ID using UNIFIED_CHAINS
   */
  getChainConfig(chainId: number): ChainConfig {
    const unifiedChain = getUnifiedChainConfig(chainId);
    if (!unifiedChain) {
      throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    return {
      chainId: unifiedChain.chainId as number,
      name: unifiedChain.name,
      rpcUrl: this.getRpcUrlsForChain(chainId)[0] || '',
      nativeCurrency: {
        name: unifiedChain.nativeCurrency.name,
        symbol: unifiedChain.nativeCurrency.symbol,
        decimals: unifiedChain.nativeCurrency.decimals,
      },
      blockExplorer: unifiedChain.explorerUrls[0] || '',
      supportedTokens: getTokensOnChain(chainId).map((t) => t.symbol),
    };
  }

  /**
   * Get all RPC URLs for a specific chain (supports fallback)
   * NOW USES UNIFIED_CHAINS as source of truth instead of environment variables
   */
  getRpcUrlsForChain(chainId: number | string): string[] {
    const unifiedChain = getUnifiedChainConfig(normalizeChainId(chainId));
    if (!unifiedChain) {
      throw new Error(`No RPC URLs configured for chain ID: ${chainId}`);
    }

    return unifiedChain.rpcUrls;
  }
}

/**
 * Check if chain ID is supported
 * Uses UNIFIED_CHAINS as source of truth
 */
export function isChainSupported(chainId: number): boolean {
  const unifiedChain = getUnifiedChainConfig(normalizeChainId(chainId));
  return unifiedChain?.isEnabled || false;
}

/**
 * Check if a token is supported on a specific chain
 */
export function isTokenSupportedOnChainConfig(
  tokenSymbol: string,
  chainId: number,
): boolean {
  return isTokenSupportedOnChain(tokenSymbol, chainId);
}

/**
 * Get supported tokens for a chain
 */
export function getSupportedTokensForChain(chainId: number): string[] {
  return getTokensOnChain(normalizeChainId(chainId)).map((t) => t.symbol);
}

/**
 * Get token address for a specific chain (from supported tokens config)
 */
export function getSupportedTokenAddress(
  tokenSymbol: string,
  chainId: number,
): string | null {
  return getTokenAddress(tokenSymbol, normalizeChainId(chainId));
}

/**
 * Get native token address for a chain (0x0000000000000000000000000000000000000000)
 */
export function getNativeTokenAddress(): string {
  return '0x0000000000000000000000000000000000000000';
}

/**
 * Check if token address is native token
 * @deprecated Use isNativeToken from @shared/utils/token-address.utils for consistency
 * This is a re-export for backward compatibility
 */
export function isNativeToken(tokenAddress: string): boolean {
  return isNativeTokenUtil(tokenAddress);
}

/**
 * Check if a token symbol represents a native token
 */
export function isNativeTokenSymbol(
  tokenSymbol: string,
  chainId: number,
): boolean {
  const token = UNIFIED_TOKENS[tokenSymbol.toUpperCase()];
  if (!token) return false;

  // Check if it's a native currency for the chain
  const chainConfig = UNIFIED_CHAINS[chainId];
  if (
    chainConfig &&
    chainConfig.nativeCurrency.symbol.toUpperCase() ===
      tokenSymbol.toUpperCase()
  ) {
    return true;
  }

  return false;
}

/**
 * Get all supported chain IDs
 */
export function getAllSupportedChainIds(): number[] {
  return Object.values(SupportedChain).filter(
    (id) => typeof id === 'number',
  ) as number[];
}

/**
 * Validate chain and token combination
 */
export function validateChainTokenCombination(
  chainId: number,
  tokenSymbol: string,
): {
  isValid: boolean;
  error?: string;
} {
  if (!isChainSupported(chainId)) {
    return {
      isValid: false,
      error: `Chain ID ${chainId} is not supported`,
    };
  }

  if (!isTokenSupportedOnChain(tokenSymbol, chainId)) {
    return {
      isValid: false,
      error: `Token ${tokenSymbol} is not supported on chain ${chainId}`,
    };
  }

  return { isValid: true };
}

/**
 * Get human-readable chain name from chain ID
 * Uses UNIFIED_CHAINS as the source of truth for ALL supported chains
 *
 * @param chainId - Chain identifier (number for EVM chains, string for native L1 chains)
 * @returns Human-readable chain name or "Chain {chainId}" as fallback
 */
export function getChainName(chainId: number | string): string {
  const normalized = normalizeChainId(chainId);
  const chainConfig = getUnifiedChainConfig(normalized);

  if (chainConfig) {
    return chainConfig.name;
  }

  // Fallback for unknown chains
  return `Chain ${chainId}`;
}

/**
 * Get blockchain ecosystem type from chain ID
 * Uses UNIFIED_CHAINS as the source of truth
 *
 * @param chainId - Chain identifier (number for EVM chains, string for native L1 chains)
 * @returns Blockchain ecosystem type ('evm', 'solana', 'bitcoin', 'cosmos', etc.)
 */
export function getChainEcosystem(chainId: number | string): string {
  const normalized = normalizeChainId(chainId);
  const chainConfig = getUnifiedChainConfig(normalized);

  if (chainConfig) {
    return chainConfig.ecosystem.toLowerCase();
  }

  // Fallback detection for unknown chains
  if (typeof normalized === 'string') {
    const chainStr = normalized.toLowerCase();
    if (chainStr.includes('solana')) return 'solana';
    if (chainStr.includes('bitcoin') || chainStr.includes('litecoin'))
      return 'bitcoin';
    if (chainStr.includes('cosmos')) return 'cosmos';
    if (chainStr.includes('polkadot') || chainStr.includes('kusama'))
      return 'substrate';
    if (chainStr.includes('tron')) return 'tron';
    if (chainStr.includes('sui')) return 'sui';
  }

  // Default to EVM for numeric chain IDs
  return 'evm';
}
