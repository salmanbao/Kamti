/**
 * Gas Estimation Configuration
 *
 * Centralizes all gas-related constants for estimation, limits, and margins.
 * These values can be adjusted based on network conditions without code changes.
 */

export interface GasEstimationConfig {
  // Absolute maximum gas limit to prevent obviously wrong values
  maxAbsoluteGasLimit: number;

  // Maximum reasonable gas price (in wei)
  maxReasonableGasPrice: string;

  // Default gas limits for different transaction types
  defaultGasLimits: {
    onChain: number;
    bridge: number;
  };

  // Margin and adjustment percentages
  margins: {
    // Add 20% margin to gas limit estimates
    gasLimitPercent: number;

    // Historical data shows ~77% actual usage
    historicalUsagePercent: number;
  };

  // Per-network overrides for specific chains
  networkOverrides?: Record<
    number,
    {
      maxGasLimit?: number;
      maxGasPrice?: string;
      defaultGasLimit?: number;
    }
  >;
}

/**
 * Default Gas Estimation Configuration
 *
 * IMPORTANT: These values are based on historical data and empirical testing:
 * - 250k for on-chain swaps covers most DEX interactions
 * - 600k for bridge transactions (increased from 300k which was causing failures)
 * - 77% historical usage adjustment based on actual vs estimated gas usage
 * - 5M absolute limit prevents bugs/placeholders from causing issues
 */
export const GAS_ESTIMATION_CONFIG: GasEstimationConfig = {
  maxAbsoluteGasLimit: 5_000_000,
  maxReasonableGasPrice: '25000000000', // 25 gwei

  defaultGasLimits: {
    onChain: 250_000,
    bridge: 600_000,
  },

  margins: {
    gasLimitPercent: 120, // 20% margin
    historicalUsagePercent: 77, // Based on analytics
  },

  networkOverrides: {
    // Ethereum mainnet
    1: {
      maxGasPrice: '50000000000', // 50 gwei
    },

    // BSC
    56: {
      maxGasPrice: '5000000000', // 5 gwei
    },

    // Polygon
    137: {
      maxGasPrice: '500000000000', // 500 gwei (Polygon can spike high)
    },

    // Arbitrum
    42161: {
      maxGasPrice: '10000000000', // 10 gwei
    },

    // Optimism
    10: {
      maxGasPrice: '10000000000', // 10 gwei
    },
  },
};
