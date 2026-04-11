/**
 * Unit Tests for Chain ID Normalization and Configuration Lookup
 * Tests multi-strategy lookup to ensure all chain ID formats are properly resolved
 */

import {
  getUnifiedChainConfig,
  normalizeChainId,
} from './unified-token-configuration.config';

describe('Chain ID Normalization', () => {
  describe('normalizeChainId', () => {
    it('should handle Solana numeric ID (7565164)', () => {
      const result = normalizeChainId(7565164);
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Solana numeric ID (1399811149)', () => {
      const result = normalizeChainId(1399811149);
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Solana string ID', () => {
      const result = normalizeChainId('solana-mainnet');
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Solana alias "solana"', () => {
      const result = normalizeChainId('solana');
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Solana alias "sol"', () => {
      const result = normalizeChainId('sol');
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Solana alias "mainnet-beta"', () => {
      const result = normalizeChainId('mainnet-beta');
      expect(result).toBe('solana-mainnet');
    });

    it('should handle Tron numeric ID (195)', () => {
      const result = normalizeChainId(195);
      expect(result).toBe('tron-mainnet');
    });

    it('should handle Tron string ID', () => {
      const result = normalizeChainId('tron-mainnet');
      expect(result).toBe('tron-mainnet');
    });

    it('should handle Tron alias "tron"', () => {
      const result = normalizeChainId('tron');
      expect(result).toBe('tron-mainnet');
    });

    it('should handle Tron alias "trx"', () => {
      const result = normalizeChainId('trx');
      expect(result).toBe('tron-mainnet');
    });

    it('should leave Ethereum mainnet numeric ID unchanged', () => {
      const result = normalizeChainId(1);
      expect(result).toBe(1);
    });

    it('should leave BSC numeric ID unchanged', () => {
      const result = normalizeChainId(56);
      expect(result).toBe(56);
    });

    it('should leave Polygon numeric ID unchanged', () => {
      const result = normalizeChainId(137);
      expect(result).toBe(137);
    });

    it('should handle case-insensitive matching', () => {
      const result = normalizeChainId('SOLANA-MAINNET');
      expect(result).toBe('solana-mainnet');
    });

    it('should handle null/undefined gracefully', () => {
      expect(normalizeChainId(null as any)).toBe(null);
      expect(normalizeChainId(undefined as any)).toBe(undefined);
    });
  });

  describe('getUnifiedChainConfig', () => {
    describe('EVM Chains', () => {
      it('should resolve Ethereum mainnet by numeric ID (1)', () => {
        const config = getUnifiedChainConfig(1);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Ethereum Mainnet');
        expect(config?.chainId).toBe(1);
      });

      it('should resolve Ethereum mainnet by key (ethereum-1)', () => {
        const config = getUnifiedChainConfig('ethereum-1');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Ethereum Mainnet');
        expect(config?.chainId).toBe(1);
      });

      it('should resolve BSC by numeric ID (56)', () => {
        const config = getUnifiedChainConfig(56);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('BNB Smart Chain');
        expect(config?.chainId).toBe(56);
      });

      it('should resolve BSC by key (bsc-56)', () => {
        const config = getUnifiedChainConfig('bsc-56');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('BNB Smart Chain');
        expect(config?.chainId).toBe(56);
      });

      it('should resolve Polygon by numeric ID (137)', () => {
        const config = getUnifiedChainConfig(137);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Polygon');
        expect(config?.chainId).toBe(137);
      });

      it('should resolve Arbitrum by numeric ID (42161)', () => {
        const config = getUnifiedChainConfig(42161);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Arbitrum One');
        expect(config?.chainId).toBe(42161);
      });

      it('should resolve Optimism by numeric ID (10)', () => {
        const config = getUnifiedChainConfig(10);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Optimism');
        expect(config?.chainId).toBe(10);
      });

      it('should resolve Base by numeric ID (8453)', () => {
        const config = getUnifiedChainConfig(8453);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Base');
        expect(config?.chainId).toBe(8453);
      });

      it('should resolve Avalanche by numeric ID (43114)', () => {
        const config = getUnifiedChainConfig(43114);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Avalanche C-Chain');
        expect(config?.chainId).toBe(43114);
      });
    });

    describe('Solana Chain', () => {
      it('should resolve Solana by canonical string ID (solana-mainnet)', () => {
        const config = getUnifiedChainConfig('solana-mainnet');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should resolve Solana by numeric alias (7565164)', () => {
        const config = getUnifiedChainConfig(7565164);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should resolve Solana by numeric alias (1399811149)', () => {
        const config = getUnifiedChainConfig(1399811149);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should resolve Solana by string alias (solana)', () => {
        const config = getUnifiedChainConfig('solana');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should resolve Solana by string alias (sol)', () => {
        const config = getUnifiedChainConfig('sol');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should resolve Solana by string alias (mainnet-beta)', () => {
        const config = getUnifiedChainConfig('mainnet-beta');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should handle Solana case-insensitive matching', () => {
        const config = getUnifiedChainConfig('SOLANA-MAINNET');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
      });
    });

    describe('Tron Chain', () => {
      it('should resolve Tron by canonical string ID (tron-mainnet)', () => {
        const config = getUnifiedChainConfig('tron-mainnet');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
        expect(config?.chainId).toBe('tron-mainnet');
      });

      it('should resolve Tron by numeric alias (195)', () => {
        const config = getUnifiedChainConfig(195);
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
        expect(config?.chainId).toBe('tron-mainnet');
      });

      it('should resolve Tron by string alias (tron)', () => {
        const config = getUnifiedChainConfig('tron');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
        expect(config?.chainId).toBe('tron-mainnet');
      });

      it('should resolve Tron by string alias (trx)', () => {
        const config = getUnifiedChainConfig('trx');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
        expect(config?.chainId).toBe('tron-mainnet');
      });

      it('should handle Tron case-insensitive matching', () => {
        const config = getUnifiedChainConfig('TRON-MAINNET');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
      });
    });

    describe('Edge Cases', () => {
      it('should return null for unsupported chain ID', () => {
        const config = getUnifiedChainConfig(99999);
        expect(config).toBeNull();
      });

      it('should return null for invalid string chain ID', () => {
        const config = getUnifiedChainConfig('invalid-chain');
        expect(config).toBeNull();
      });

      it('should handle string numeric IDs (e.g., "1" for Ethereum)', () => {
        const config = getUnifiedChainConfig('1');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Ethereum Mainnet');
        expect(config?.chainId).toBe(1);
      });

      it('should handle string numeric IDs (e.g., "56" for BSC)', () => {
        const config = getUnifiedChainConfig('56');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('BNB Smart Chain');
        expect(config?.chainId).toBe(56);
      });

      it('should handle string Solana numeric alias (e.g., "7565164")', () => {
        const config = getUnifiedChainConfig('7565164');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Solana Mainnet');
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should handle string Tron numeric alias (e.g., "195")', () => {
        const config = getUnifiedChainConfig('195');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Tron Mainnet');
        expect(config?.chainId).toBe('tron-mainnet');
      });
    });

    describe('Multi-Strategy Fallback', () => {
      it('should try all strategies for Solana numeric ID', () => {
        // Numeric ID 7565164 should:
        // 1. Normalize to 'solana-mainnet'
        // 2. Try direct key lookup (fails - key is 'solana-mainnet', not numeric)
        // 3. Try numeric match (fails - chainId is 'solana-mainnet', not 7565164)
        // 4. Try string match (succeeds - chainId equals 'solana-mainnet')
        const config = getUnifiedChainConfig(7565164);
        expect(config).not.toBeNull();
        expect(config?.chainId).toBe('solana-mainnet');
      });

      it('should try all strategies for EVM chain', () => {
        // Numeric ID 1 should:
        // 1. Not normalize (remains 1)
        // 2. Try direct key lookup (fails - key is 'ethereum-1', not 1)
        // 3. Try numeric match (succeeds - chainId equals 1)
        const config = getUnifiedChainConfig(1);
        expect(config).not.toBeNull();
        expect(config?.chainId).toBe(1);
      });

      it('should prioritize direct key lookup', () => {
        // Direct key should match immediately without fallback
        const config = getUnifiedChainConfig('ethereum-1');
        expect(config).not.toBeNull();
        expect(config?.name).toBe('Ethereum Mainnet');
      });
    });
  });
});
