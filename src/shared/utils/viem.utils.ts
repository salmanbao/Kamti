import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Hex,
} from 'viem';
import {
  mainnet,
  polygon,
  bsc,
  arbitrum,
  optimism,
  base,
  avalanche,
  type Chain,
} from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Shared Viem utilities for blockchain interactions
 * Centralizes chain mapping, client creation, and common patterns
 */

/**
 * Get Viem chain object from chain ID
 * Centralized mapping to avoid duplication across services
 */
export function getViemChain(chainId: number): Chain {
  switch (chainId) {
    case 1:
      return mainnet;
    case 137:
      return polygon;
    case 56:
      return bsc;
    case 42161:
      return arbitrum;
    case 10:
      return optimism;
    case 8453:
      return base;
    case 43114:
      return avalanche;
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/**
 * Create a public client for blockchain reading operations
 */
export function createViemPublicClient(
  chainId: number,
  rpcUrl: string,
): PublicClient {
  const chain = getViemChain(chainId);

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Create a wallet client for transaction signing and sending
 */
export function createViemWalletClient(
  chainId: number,
  privateKey: string,
  rpcUrl: string,
): WalletClient {
  const chain = getViemChain(chainId);
  const account = privateKeyToAccount(privateKey as Hex);

  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
}

/**
 * Get account from private key (common pattern)
 */
export function getAccountFromPrivateKey(privateKey: string) {
  return privateKeyToAccount(privateKey as Hex);
}
