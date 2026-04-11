/**
 * Registry interface for self-registering wallet providers
 * Enables loose coupling and automatic discovery of blockchain wallet providers
 */

import type { IWalletProvider } from './wallet-provider.interface';

/**
 * Wallet provider registry interface that wallet providers use to register themselves
 */
export interface IWalletProviderRegistry {
  /**
   * Register a wallet provider
   */
  registerWalletProvider(provider: IWalletProvider): void;

  /**
   * Get all registered wallet providers
   */
  getWalletProviders(): Map<string, IWalletProvider>;

  /**
   * Get wallet provider by ecosystem
   */
  getWalletProvider(ecosystem: string): IWalletProvider | undefined;
}

/**
 * Injection token for the wallet provider registry
 */
export const WALLET_PROVIDER_REGISTRY = Symbol('WALLET_PROVIDER_REGISTRY');
