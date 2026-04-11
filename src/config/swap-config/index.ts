/**
 * Swap Configuration Index
 *
 * Aggregates all swap-related configurations into a single export.
 * This is the main entry point for accessing swap configuration.
 */

import {
  GAS_ESTIMATION_CONFIG,
  GasEstimationConfig,
} from './gas-estimation.config';
import { CHAIN_FEE_CONFIG, ChainFeeConfig } from './chain-fees.config';
import {
  CHAIN_DETECTION_CONFIG,
  ChainDetectionConfig,
  detectEcosystemFromChainId,
  isChainIdInEcosystem,
} from './chain-detection.config';
import {
  AGGREGATOR_TOLERANCES,
  AggregatorTolerances,
} from './aggregator-tolerances.config';

/**
 * Complete Swap Configuration
 */
export interface SwapConfig {
  gasEstimation: GasEstimationConfig;
  chainFees: ChainFeeConfig;
  chainDetection: ChainDetectionConfig;
  aggregatorTolerances: AggregatorTolerances;
}

/**
 * Default Swap Configuration
 *
 * This is the production configuration with values optimized for:
 * - Reliability (conservative gas estimates)
 * - Cost-efficiency (historical usage adjustments)
 * - Multi-chain support (EVM, Solana, Tron, Bitcoin)
 * - Multiple aggregators (Rubic, 0x, 1inch, etc.)
 */
export const DEFAULT_SWAP_CONFIG: SwapConfig = {
  gasEstimation: GAS_ESTIMATION_CONFIG,
  chainFees: CHAIN_FEE_CONFIG,
  chainDetection: CHAIN_DETECTION_CONFIG,
  aggregatorTolerances: AGGREGATOR_TOLERANCES,
};

// Re-export all configurations and types
export {
  GAS_ESTIMATION_CONFIG,
  CHAIN_FEE_CONFIG,
  CHAIN_DETECTION_CONFIG,
  AGGREGATOR_TOLERANCES,
  detectEcosystemFromChainId,
  isChainIdInEcosystem,
};

export type {
  GasEstimationConfig,
  ChainFeeConfig,
  ChainDetectionConfig,
  AggregatorTolerances,
};

// Re-export types
export type { Ecosystem } from './chain-detection.config';
export type {
  SolanaFeeConfig,
  TronFeeConfig,
  BitcoinFeeConfig,
} from './chain-fees.config';
export type { AggregatorToleranceConfig } from './aggregator-tolerances.config';
