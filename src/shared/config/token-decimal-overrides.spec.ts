/**
 * Token Decimal Overrides Consistency Tests
 *
 * Tests to verify that token decimals are correctly applied based on chain-specific deployments.
 * Critical for tokens like USDT and USDC that have different decimals across chains.
 */

import {
  getUnifiedTokenConfig,
  validateTokenDecimals,
} from './unified-token-configuration.config';

describe('Token Decimal Overrides Consistency', () => {
  describe('USDT Decimals by Chain', () => {
    it('should return 6 decimals for USDT on Ethereum', () => {
      const token = getUnifiedTokenConfig('USDT', 1);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 18 decimals for USDT on BSC', () => {
      const token = getUnifiedTokenConfig('USDT', 56);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(18);
    });

    it('should return 6 decimals for USDT on Tron', () => {
      const token = getUnifiedTokenConfig('USDT', 'tron-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 6 decimals for USDT on Solana', () => {
      const token = getUnifiedTokenConfig('USDT', 'solana-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 6 decimals for USDT on Avalanche', () => {
      const token = getUnifiedTokenConfig('USDT', 43114);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });
  });

  describe('USDC Decimals by Chain', () => {
    it('should return 6 decimals for USDC on Ethereum', () => {
      const token = getUnifiedTokenConfig('USDC', 1);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 18 decimals for USDC on BSC', () => {
      const token = getUnifiedTokenConfig('USDC', 56);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(18);
    });

    it('should return 6 decimals for USDC on Tron', () => {
      const token = getUnifiedTokenConfig('USDC', 'tron-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 6 decimals for USDC on Solana', () => {
      const token = getUnifiedTokenConfig('USDC', 'solana-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });
  });

  describe('Base Token Config (No Chain Override)', () => {
    it('should return base decimals for USDT without chainId', () => {
      const token = getUnifiedTokenConfig('USDT');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6); // Base decimals
    });

    it('should return base decimals for USDC without chainId', () => {
      const token = getUnifiedTokenConfig('USDC');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6); // Base decimals
    });
  });

  describe('Native Token Decimals', () => {
    it('should return 18 decimals for ETH on Ethereum', () => {
      const token = getUnifiedTokenConfig('ETH', 1);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(18);
    });

    it('should return 18 decimals for BNB on BSC', () => {
      const token = getUnifiedTokenConfig('BNB', 56);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(18);
    });

    it('should return 9 decimals for SOL on Solana', () => {
      const token = getUnifiedTokenConfig('SOL', 'solana-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(9);
    });

    it('should return 6 decimals for TRX on Tron', () => {
      const token = getUnifiedTokenConfig('TRX', 'tron-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should return 8 decimals for BTC on Bitcoin', () => {
      const token = getUnifiedTokenConfig('BTC', 'bitcoin-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(8);
    });
  });

  describe('validateTokenDecimals', () => {
    it('should validate USDT decimals on Ethereum', () => {
      const result = validateTokenDecimals('USDT', 1, 6);
      expect(result.isValid).toBe(true);
      expect(result.actualDecimals).toBe(6);
      expect(result.expectedDecimals).toBe(6);
    });

    it('should detect USDT decimal mismatch on BSC', () => {
      const result = validateTokenDecimals('USDT', 56, 6);
      expect(result.isValid).toBe(false);
      expect(result.actualDecimals).toBe(18);
      expect(result.expectedDecimals).toBe(6);
      expect(result.message).toContain('Decimals mismatch');
    });

    it('should validate USDT decimals on BSC with correct expectation', () => {
      const result = validateTokenDecimals('USDT', 56, 18);
      expect(result.isValid).toBe(true);
      expect(result.actualDecimals).toBe(18);
      expect(result.expectedDecimals).toBe(18);
    });

    it('should return actual decimals when no expected decimals provided', () => {
      const result = validateTokenDecimals('USDT', 1);
      expect(result.isValid).toBe(true);
      expect(result.actualDecimals).toBe(6);
      expect(result.warning).toBeDefined();
    });

    it('should handle invalid token symbol', () => {
      const result = validateTokenDecimals('INVALID_TOKEN', 1, 18);
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should validate by token address', () => {
      const usdtEthAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';
      const result = validateTokenDecimals(usdtEthAddress, 1, 6);
      expect(result.isValid).toBe(true);
      expect(result.actualDecimals).toBe(6);
    });
  });

  describe('Chain-Specific Address Resolution', () => {
    it('should include chain-specific address for USDT on Ethereum', () => {
      const token = getUnifiedTokenConfig('USDT', 1);
      expect(token).toBeDefined();
      expect((token as any)?.address).toBe(
        '0xdac17f958d2ee523a2206206994597c13d831ec7',
      );
    });

    it('should include chain-specific address for USDT on BSC', () => {
      const token = getUnifiedTokenConfig('USDT', 56);
      expect(token).toBeDefined();
      expect((token as any)?.address).toBe(
        '0x55d398326f99059fF775485246999027B3197955',
      );
    });

    it('should include chain context when chainId provided', () => {
      const token = getUnifiedTokenConfig('USDT', 1);
      expect(token).toBeDefined();
      expect((token as any)?.chainId).toBe(1);
    });

    it('should not include chain context when chainId not provided', () => {
      const token = getUnifiedTokenConfig('USDT');
      expect(token).toBeDefined();
      expect((token as any)?.chainId).toBeUndefined();
    });
  });

  describe('Solana Chain ID Aliases', () => {
    it('should handle Solana numeric alias 7565164', () => {
      const token = getUnifiedTokenConfig('SOL', 7565164);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(9);
      expect((token as any)?.chainId).toBe('solana-mainnet');
    });

    it('should handle Solana string alias', () => {
      const token = getUnifiedTokenConfig('SOL', 'solana-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(9);
    });

    it('should handle USDT on Solana with numeric alias', () => {
      const token = getUnifiedTokenConfig('USDT', 7565164);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
      expect((token as any)?.address).toBe(
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      );
    });
  });

  describe('Tron Chain ID Aliases', () => {
    it('should handle Tron numeric alias 195', () => {
      const token = getUnifiedTokenConfig('TRX', 195);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
      expect((token as any)?.chainId).toBe('tron-mainnet');
    });

    it('should handle Tron string alias', () => {
      const token = getUnifiedTokenConfig('TRX', 'tron-mainnet');
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
    });

    it('should handle USDT on Tron with numeric alias', () => {
      const token = getUnifiedTokenConfig('USDT', 195);
      expect(token).toBeDefined();
      expect(token?.decimals).toBe(6);
      expect((token as any)?.address).toBe(
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      );
    });
  });
});
