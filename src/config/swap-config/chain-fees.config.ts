/**
 * Chain-Specific Fee Configuration
 *
 * Defines fee structures for non-EVM chains (Solana, Tron, Bitcoin)
 * Each chain has its own fee mechanism that differs from EVM gas model
 */

export interface SolanaFeeConfig {
  defaultComputeUnits: number;
  defaultPriorityFee: string; // Lamports
  totalGasCost: string; // Lamports (total estimated cost)
  adjustmentFactors: {
    lowPriority: number;
    normal: number;
    high: number;
  };
}

export interface TronFeeConfig {
  bandwidthCostPerByte: string; // SUN
  energyCostPerUnit: string; // SUN
  typicalBridgeCost: string; // SUN (conservative estimate)
  freeBandwidthDaily: number; // Units per account
}

export interface BitcoinFeeConfig {
  satoshiPerByte: number;
  estimatedTxSize: number;
  defaultCost: string; // Satoshis
}

export interface ChainFeeConfig {
  solana: SolanaFeeConfig;
  tron: TronFeeConfig;
  bitcoin: BitcoinFeeConfig;
}

/**
 * Default Chain Fee Configuration
 *
 * IMPORTANT: These values are based on current network conditions:
 *
 * SOLANA:
 * - Typical swap: 200k-400k compute units
 * - Priority fee: ~0.0001 SOL for fast execution
 * - Total estimate: 0.001 SOL (conservative)
 *
 * TRON:
 * - Bandwidth: 1000 SUN per byte when free bandwidth depleted
 * - Energy: 420 SUN per unit (for smart contract execution)
 * - Bridge estimate: 5 TRX covers most bridge contracts
 *
 * BITCOIN:
 * - Fee varies by network congestion
 * - ~10 sat/byte for normal priority
 * - ~250 bytes for typical transaction
 */
export const CHAIN_FEE_CONFIG: ChainFeeConfig = {
  solana: {
    defaultComputeUnits: 400_000,
    defaultPriorityFee: '100000', // 0.0001 SOL in lamports
    totalGasCost: '1000000', // 0.001 SOL in lamports (conservative estimate)
    adjustmentFactors: {
      lowPriority: 0.5, // 50% of normal
      normal: 1.0, // 100%
      high: 2.0, // 200% for fast execution
    },
  },

  tron: {
    bandwidthCostPerByte: '1000', // 1000 SUN per byte
    energyCostPerUnit: '420', // 420 SUN per energy unit
    typicalBridgeCost: '5000000', // 5 TRX (5,000,000 SUN) for bridge contracts
    freeBandwidthDaily: 600, // 600 free bandwidth units per day
  },

  bitcoin: {
    satoshiPerByte: 10, // 10 sat/byte for normal priority
    estimatedTxSize: 250, // 250 bytes typical transaction size
    defaultCost: '100000', // 100k satoshis conservative default
  },
};
