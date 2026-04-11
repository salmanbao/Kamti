/**
 * Registry interface for self-registering aggregators and providers
 * Enables loose coupling and automatic discovery of swap providers
 */

import type {
  IOnchainAggregator,
  IMetaAggregator,
  ISolanaRouter,
} from '@swap/models/ports';

/**
 * Provider categories for registration
 */
export enum ProviderCategory {
  EVM_AGGREGATOR = 'evm',
  META_AGGREGATOR = 'meta',
  SOLANA_ROUTER = 'solana',
}

/**
 * Provider types union
 */
export type AnyProvider = IOnchainAggregator | IMetaAggregator | ISolanaRouter;

/**
 * Registry interface that providers use to register themselves
 */
export interface IAggregatorRegistry {
  /**
   * Register an EVM aggregator
   */
  registerEvmAggregator(provider: IOnchainAggregator): void;

  /**
   * Register a meta aggregator (cross-chain)
   */
  registerMetaAggregator(provider: IMetaAggregator): void;

  /**
   * Register a Solana router
   */
  registerSolanaRouter(provider: ISolanaRouter): void;

  /**
   * Generic registration method (auto-detects category)
   */
  registerProvider(provider: AnyProvider, category: ProviderCategory): void;
}

/**
 * Injection token for the aggregator registry
 */
export const AGGREGATOR_REGISTRY = Symbol('AGGREGATOR_REGISTRY');
