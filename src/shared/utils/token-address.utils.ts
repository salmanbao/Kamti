/**
 * Token Address Utilities - SINGLE SOURCE OF TRUTH
 *
 * This module is the centralized location for native token detection logic.
 * All other modules (chain.utils, token-validation.guard, etc.) should import from here.
 *
 * Handles provider-specific native token address conventions:
 * - EVM chains: 0xeeee... and 0x0000... for native tokens (ETH, BNB, MATIC, etc.)
 * - Solana: So11111... in multiple formats (43-char Rubic format, 46-char standard)
 * - Generic symbols: "native", "eth", "bnb", "sol", etc.
 *
 * Provider-specific formats:
 * - Some providers (0x, Odos, Rango, etc.) use 0xeeee... for native tokens
 * - Some providers (Rubic, THORChain, etc.) use 0x0000... for native tokens
 */

export enum NativeTokenFormat {
  EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ZERO = '0x0000000000000000000000000000000000000000',
}

export enum ProviderType {
  ZERO_X = '0x',
  ODOS = 'odos',
  RUBIC = 'rubic',
  RANGO = 'rango',
  SOCKET = 'socket',
  ROUTER = 'router',
  THORCHAIN = 'thorchain',
  MAYA = 'maya',
  JUPITER = 'jupiter',
}

/**
 * Provider-specific native token format requirements
 */
const PROVIDER_NATIVE_TOKEN_FORMAT: Record<ProviderType, NativeTokenFormat> = {
  [ProviderType.ZERO_X]: NativeTokenFormat.EEEE,
  [ProviderType.ODOS]: NativeTokenFormat.EEEE,
  [ProviderType.RUBIC]: NativeTokenFormat.ZERO,
  [ProviderType.RANGO]: NativeTokenFormat.EEEE,
  [ProviderType.SOCKET]: NativeTokenFormat.EEEE,
  [ProviderType.ROUTER]: NativeTokenFormat.EEEE,
  [ProviderType.THORCHAIN]: NativeTokenFormat.ZERO, // THORChain uses special formats but zero as fallback
  [ProviderType.MAYA]: NativeTokenFormat.ZERO,
  [ProviderType.JUPITER]: NativeTokenFormat.ZERO, // Solana uses different addressing
};

/**
 * Common representations of native tokens that should be normalized
 *
 * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for native token detection.
 * All isNativeToken() implementations across the codebase reference this list.
 */
const NATIVE_TOKEN_IDENTIFIERS = [
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
  'So11111111111111111111111111111111111111111111', // Solana wrapped SOL (46 chars - standard format)
  'So11111111111111111111111111111111111111111112', // Solana wrapped SOL alternative
  'So11111111111111111111111111111111111111111', // Solana wrapped SOL (43 chars - Rubic API format)
  'native',
  'eth',
  'bnb',
  'matic',
  'avax',
  'ftm',
  'sol',
  'btc',
  'trx', // Tron native token
  'ltc', // Litecoin
];

/**
 * Check if a token address represents a native token
 *
 * SINGLE SOURCE OF TRUTH for native token detection across the entire codebase.
 *
 * Supports:
 * - EVM native tokens: 0xeeee..., 0x0000...
 * - Solana native token: So11111... (multiple format variations)
 * - Generic symbols: native, eth, bnb, sol, matic, avax, ftm, btc, trx, ltc
 *
 * @param tokenAddress - Token address or symbol to check
 * @returns true if the address represents a native token, false otherwise
 */
export function isNativeToken(tokenAddress: string): boolean {
  if (!tokenAddress) return false;

  const normalized = tokenAddress.toLowerCase().trim();

  return NATIVE_TOKEN_IDENTIFIERS.some(
    (identifier) => normalized === identifier.toLowerCase(),
  );
}

/**
 * Check if address is in 0xeeee... format
 */
export function isEeeeFormat(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === NativeTokenFormat.EEEE.toLowerCase();
}

/**
 * Check if address is in 0x0000... format
 */
export function isZeroFormat(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === NativeTokenFormat.ZERO.toLowerCase();
}

/**
 * Convert token address to provider-specific format
 *
 * @param tokenAddress - The input token address
 * @param provider - The target provider
 * @returns Token address in provider-specific format
 *
 * @example
 * // For 0x provider
 * convertToProviderFormat('0x0000...', '0x') // Returns '0xeeee...'
 *
 * // For Rubic provider
 * convertToProviderFormat('0xeeee...', 'rubic') // Returns '0x0000...'
 *
 * // For ERC20 tokens (no conversion)
 * convertToProviderFormat('0x6B175...', '0x') // Returns '0x6B175...'
 */
export function convertToProviderFormat(
  tokenAddress: string,
  provider: ProviderType | string,
): string {
  // If not a native token, return as-is
  if (!isNativeToken(tokenAddress)) {
    return tokenAddress;
  }

  // Get provider's required format
  const providerType = provider.toLowerCase();
  const requiredFormat =
    PROVIDER_NATIVE_TOKEN_FORMAT[providerType as ProviderType];

  // If provider not recognized, default to 0xeeee... format (most common)
  return requiredFormat || NativeTokenFormat.EEEE;
}

/**
 * Normalize a token address to a standard format (0xeeee...)
 * This is useful for internal processing before converting to provider-specific format
 *
 * @param tokenAddress - The input token address
 * @returns Normalized token address (0xeeee... for native, original for ERC20)
 */
export function normalizeTokenAddress(tokenAddress: string): string {
  if (isNativeToken(tokenAddress)) {
    return NativeTokenFormat.EEEE;
  }
  return tokenAddress;
}

/**
 * Convert token address from one provider's format to another
 *
 * @param tokenAddress - The input token address
 * @param fromProvider - The source provider
 * @param toProvider - The target provider
 * @returns Token address in target provider's format
 *
 * @example
 * convertBetweenProviders('0xeeee...', '0x', 'rubic') // Returns '0x0000...'
 * convertBetweenProviders('0x0000...', 'rubic', '0x') // Returns '0xeeee...'
 */
export function convertBetweenProviders(
  tokenAddress: string,
  fromProvider: ProviderType | string,
  toProvider: ProviderType | string,
): string {
  // If not a native token, no conversion needed
  if (!isNativeToken(tokenAddress)) {
    return tokenAddress;
  }

  return convertToProviderFormat(tokenAddress, toProvider);
}

/**
 * Get the native token format for a specific provider
 *
 * @param provider - The provider name
 * @returns The native token format used by the provider
 */
export function getProviderNativeFormat(
  provider: ProviderType | string,
): NativeTokenFormat {
  const providerType = provider.toLowerCase();
  return (
    PROVIDER_NATIVE_TOKEN_FORMAT[providerType as ProviderType] ||
    NativeTokenFormat.EEEE
  );
}

/**
 * Batch convert multiple token addresses to provider format
 * Useful for converting both fromToken and toToken in a single operation
 *
 * @param tokens - Object with token addresses
 * @param provider - Target provider
 * @returns Object with converted token addresses
 *
 * @example
 * batchConvertToProviderFormat({
 *   fromToken: '0xeeee...',
 *   toToken: '0x6B175...'
 * }, 'rubic')
 * // Returns { fromToken: '0x0000...', toToken: '0x6B175...' }
 */
export function batchConvertToProviderFormat<T extends Record<string, string>>(
  tokens: T,
  provider: ProviderType | string,
): T {
  const converted = {} as T;

  for (const [key, address] of Object.entries(tokens)) {
    converted[key as keyof T] = convertToProviderFormat(
      address,
      provider,
    ) as T[keyof T];
  }

  return converted;
}

/**
 * Validate if a token address is valid for a specific provider
 *
 * @param tokenAddress - The token address to validate
 * @param provider - The provider to validate against
 * @returns True if valid, false otherwise
 */
export function isValidForProvider(
  tokenAddress: string,
  provider: ProviderType | string,
): boolean {
  // Valid ERC20 addresses are valid for all providers
  if (!isNativeToken(tokenAddress)) {
    // Check if it's a valid Ethereum address format
    return /^0x[a-fA-F0-9]{40}$/.test(tokenAddress);
  }

  // For native tokens, check if it matches provider's expected format
  const requiredFormat = getProviderNativeFormat(provider);
  return tokenAddress.toLowerCase() === requiredFormat.toLowerCase();
}
