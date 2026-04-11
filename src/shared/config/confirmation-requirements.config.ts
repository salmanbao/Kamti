/**
 * Confirmation requirements for different blockchain ecosystems
 *
 * This configuration defines minimum confirmation counts needed for:
 * 1. Round-trip swaps (requirement #5 - minimum 1 confirmation for EVM/Solana)
 * 2. Transaction finality monitoring
 * 3. Cross-chain bridge confirmations
 */

export interface ConfirmationRequirements {
  ecosystem: string;
  minConfirmationsRoundTrip: number; // Minimum for round-trip swap second leg
  minConfirmationsStandard: number; // Standard transaction finality
  minConfirmationsFinal: number; // Full finality (probabilistic chains)
  blockTime: number; // Average block time in seconds
  notes?: string;
}

/**
 * Confirmation requirements by ecosystem
 */
export const CONFIRMATION_REQUIREMENTS: Record<
  string,
  ConfirmationRequirements
> = {
  evm: {
    ecosystem: 'evm',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 3,
    minConfirmationsFinal: 12,
    blockTime: 12,
    notes:
      'EVM chains (Ethereum, Polygon, BSC, etc.). 1 confirmation for round-trip (requirement #5).',
  },
  solana: {
    ecosystem: 'solana',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 1,
    minConfirmationsFinal: 32,
    blockTime: 0.4,
    notes:
      'Solana uses commitment levels: processed, confirmed, finalized. 1 confirmation = "confirmed" (requirement #5).',
  },
  bitcoin: {
    ecosystem: 'bitcoin',
    minConfirmationsRoundTrip: 3,
    minConfirmationsStandard: 3,
    minConfirmationsFinal: 6,
    blockTime: 600,
    notes:
      'Bitcoin requires 3 confirmations for round-trip (requirement #5). 6 for full finality.',
  },
  tron: {
    ecosystem: 'tron',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 19,
    minConfirmationsFinal: 19,
    blockTime: 3,
    notes: 'Tron solidification requires 19 blocks (57 seconds) for finality.',
  },
  avalanche: {
    ecosystem: 'avalanche',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 1,
    minConfirmationsFinal: 1,
    blockTime: 2,
    notes: 'Avalanche has instant finality via Snowman consensus.',
  },
  polygon: {
    ecosystem: 'polygon',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 128,
    minConfirmationsFinal: 256,
    blockTime: 2,
    notes:
      'Polygon uses Bor consensus. 128 blocks for checkpoint, 256 for finality.',
  },
  arbitrum: {
    ecosystem: 'arbitrum',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 1,
    minConfirmationsFinal: 1,
    blockTime: 0.25,
    notes:
      'Arbitrum Nitro has instant soft finality. L1 finality requires Ethereum confirmation.',
  },
  optimism: {
    ecosystem: 'optimism',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 1,
    minConfirmationsFinal: 1,
    blockTime: 2,
    notes:
      'Optimism has instant soft finality. L1 finality requires Ethereum confirmation.',
  },
  bsc: {
    ecosystem: 'bsc',
    minConfirmationsRoundTrip: 1,
    minConfirmationsStandard: 15,
    minConfirmationsFinal: 15,
    blockTime: 3,
    notes: 'BSC uses Parlia consensus. 15 blocks (~45s) for finality.',
  },
};

/**
 * Get confirmation requirements for an ecosystem
 */
export function getConfirmationRequirements(
  ecosystem: string,
): ConfirmationRequirements {
  const normalized = ecosystem.toLowerCase();
  return (
    CONFIRMATION_REQUIREMENTS[normalized] || CONFIRMATION_REQUIREMENTS.evm // Default to EVM requirements
  );
}

/**
 * Get minimum confirmations for round-trip swaps (requirement #5)
 */
export function getRoundTripMinConfirmations(ecosystem: string): number {
  return getConfirmationRequirements(ecosystem).minConfirmationsRoundTrip;
}

/**
 * Get standard confirmation count for transaction finality
 */
export function getStandardConfirmations(ecosystem: string): number {
  return getConfirmationRequirements(ecosystem).minConfirmationsStandard;
}

/**
 * Get full finality confirmation count (for high-value transactions)
 */
export function getFinalConfirmations(ecosystem: string): number {
  return getConfirmationRequirements(ecosystem).minConfirmationsFinal;
}

/**
 * Estimate wait time for confirmations
 */
export function estimateConfirmationTime(
  ecosystem: string,
  confirmations: number,
): number {
  const config = getConfirmationRequirements(ecosystem);
  return config.blockTime * confirmations;
}

/**
 * Validate if ecosystem is supported for round-trip swaps
 */
export function isEcosystemSupportedForRoundTrip(ecosystem: string): {
  supported: boolean;
  reason?: string;
} {
  const normalized = ecosystem.toLowerCase();
  const config = CONFIRMATION_REQUIREMENTS[normalized];

  if (!config) {
    return {
      supported: false,
      reason: `Ecosystem ${ecosystem} not configured for round-trip swaps.`,
    };
  }

  // Bitcoin is too slow for practical round-trip swaps (10+ minutes per confirmation)
  if (normalized === 'bitcoin' && config.minConfirmationsRoundTrip >= 3) {
    return {
      supported: false,
      reason: `Bitcoin requires ${config.minConfirmationsRoundTrip} confirmations (${estimateConfirmationTime(ecosystem, config.minConfirmationsRoundTrip)}s wait). Too slow for round-trip swaps.`,
    };
  }

  return { supported: true };
}

/**
 * Get all ecosystems supported for round-trip swaps
 */
export function getSupportedRoundTripEcosystems(): string[] {
  return Object.keys(CONFIRMATION_REQUIREMENTS).filter(
    (ecosystem) => isEcosystemSupportedForRoundTrip(ecosystem).supported,
  );
}
