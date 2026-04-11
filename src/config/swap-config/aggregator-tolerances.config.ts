/**
 * Aggregator Tolerance Configuration
 *
 * Defines rounding buffers and tolerances for different aggregators.
 * Different aggregators may have different rounding behaviors.
 */

export interface AggregatorToleranceConfig {
  roundingBuffer: string; // Wei for EVM, smallest unit for others
  roundingTolerance: string; // Max acceptable difference
  shouldScale: boolean; // Scale by gas price or decimals
}

export interface AggregatorTolerances {
  // Provider-specific tolerances
  providers: Record<string, AggregatorToleranceConfig>;

  // Default tolerances by ecosystem
  defaults: {
    evmRoundingBuffer: string;
    solanaRoundingBuffer: string; // Lamports
    tronRoundingBuffer: string; // SUN
  };
}

/**
 * Default Aggregator Tolerance Configuration
 *
 * IMPORTANT: These values are based on empirical testing with each aggregator:
 *
 * RUBIC:
 * - 100 wei buffer accounts for API rounding differences
 * - Rubic may return transaction.value that differs by 1-100 wei from requested amount
 * - This is due to their internal fee calculations and rounding
 *
 * 0x:
 * - More precise, 10 wei buffer sufficient
 * - Less rounding due to simpler fee structure
 *
 * 1INCH:
 * - 1000 wei buffer due to complex routing
 * - Should scale by gas price for high-gas scenarios
 */
export const AGGREGATOR_TOLERANCES: AggregatorTolerances = {
  providers: {
    rubic: {
      roundingBuffer: '100', // 100 wei
      roundingTolerance: '100',
      shouldScale: false,
    },

    '0x': {
      roundingBuffer: '10', // 10 wei (more precise)
      roundingTolerance: '50',
      shouldScale: false,
    },

    '1inch': {
      roundingBuffer: '1000', // 1000 wei
      roundingTolerance: '1000',
      shouldScale: true, // Scale by gas price
    },

    // Default for unknown aggregators
    default: {
      roundingBuffer: '100',
      roundingTolerance: '100',
      shouldScale: false,
    },
  },

  defaults: {
    evmRoundingBuffer: '100', // 100 wei
    solanaRoundingBuffer: '1000', // 1000 lamports
    tronRoundingBuffer: '100', // 100 SUN
  },
};
