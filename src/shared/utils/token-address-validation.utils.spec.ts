/**
 * Unit Tests for Token Address Validation
 * Comprehensive tests for all supported blockchain ecosystems
 */

import {
  validateTokenAddress,
  validateTokenAddressForChain,
  getEcosystemFromChainId,
  normalizeTokenAddress,
} from './token-address-validation.utils';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';

describe('Token Address Validation', () => {
  describe('EVM Address Validation', () => {
    it('should validate correct Ethereum addresses', () => {
      // USDC on Ethereum
      expect(
        validateTokenAddress(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
      // USDT on Ethereum
      expect(
        validateTokenAddress(
          '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
      // DAI on Ethereum
      expect(
        validateTokenAddress(
          '0x6B175474E89094C44Da98b954EedeAC495271d0F',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
    });

    it('should validate native token addresses', () => {
      // 0x Protocol native token representation
      expect(
        validateTokenAddress(
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
      // Zero address
      expect(
        validateTokenAddress(
          '0x0000000000000000000000000000000000000000',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
    });

    it('should accept mixed case addresses', () => {
      expect(
        validateTokenAddress(
          '0xA0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
      expect(
        validateTokenAddress(
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(true);
    });

    it('should reject invalid Ethereum addresses', () => {
      // Missing 0x prefix
      expect(
        validateTokenAddress(
          'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(false);
      // Too short
      expect(
        validateTokenAddress(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE360',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(false);
      // Too long
      expect(
        validateTokenAddress(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48EXTRA',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(false);
      // Invalid hex characters
      expect(
        validateTokenAddress(
          '0xG0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          BlockchainEcosystem.EVM,
        ),
      ).toBe(false);
    });
  });

  describe('Solana Address Validation', () => {
    it('should validate correct Solana addresses', () => {
      // Native SOL (Wrapped SOL)
      expect(
        validateTokenAddress(
          'So11111111111111111111111111111111111111112',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(true);
      // USDC on Solana
      expect(
        validateTokenAddress(
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(true);
      // USDT on Solana
      expect(
        validateTokenAddress(
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(true);
      // Random valid Solana address
      expect(
        validateTokenAddress(
          '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(true);
    });

    it('should reject invalid Solana addresses', () => {
      // Too short
      expect(
        validateTokenAddress(
          'So1111111111111111111111111111111',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(false);
      // Invalid base58 characters (contains 0, O, I, l)
      expect(
        validateTokenAddress(
          'So11111111111111111111111111111111111111110',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(false);
      expect(
        validateTokenAddress(
          'SO11111111111111111111111111111111111111112',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(false);
      // Invalid base58 encoding
      expect(
        validateTokenAddress(
          'InvalidSolanaAddress1234567890123456789',
          BlockchainEcosystem.SOLANA,
        ),
      ).toBe(false);
    });
  });

  describe('Tron Address Validation', () => {
    it('should validate correct Tron addresses', () => {
      // USDT on Tron
      expect(
        validateTokenAddress(
          'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(true);
      // USDC on Tron
      expect(
        validateTokenAddress(
          'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(true);
      // Random valid Tron address
      expect(
        validateTokenAddress(
          'TYDzsYUEpvnYmQk4zGP9sWWcTEd2MiAtW6',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(true);
    });

    it('should reject invalid Tron addresses', () => {
      // Doesn't start with 'T'
      expect(
        validateTokenAddress(
          'AR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(false);
      // Wrong length (not 34 characters)
      expect(
        validateTokenAddress(
          'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgj',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(false);
      expect(
        validateTokenAddress(
          'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tEXTRA',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(false);
      // Invalid base58 characters
      expect(
        validateTokenAddress(
          'T07NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          BlockchainEcosystem.TRON,
        ),
      ).toBe(false);
    });
  });

  describe('Bitcoin Address Validation', () => {
    it('should validate Legacy P2PKH addresses (starts with 1)', () => {
      // Satoshi's address
      expect(
        validateTokenAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin'),
      ).toBe(true);
      // Random valid P2PKH
      expect(
        validateTokenAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'bitcoin'),
      ).toBe(true);
    });

    it('should validate Legacy P2SH addresses (starts with 3)', () => {
      expect(
        validateTokenAddress('3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy', 'bitcoin'),
      ).toBe(true);
      expect(
        validateTokenAddress('3QJmV3qfvL9SuYo34YihAf3sRCW3qSinyC', 'bitcoin'),
      ).toBe(true);
    });

    it('should validate SegWit Bech32 addresses (starts with bc1)', () => {
      // P2WPKH (SegWit v0)
      expect(
        validateTokenAddress(
          'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          'bitcoin',
        ),
      ).toBe(true);
      // P2WSH (SegWit v0)
      expect(
        validateTokenAddress(
          'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
          'bitcoin',
        ),
      ).toBe(true);
      // Taproot (SegWit v1)
      expect(
        validateTokenAddress(
          'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
          'bitcoin',
        ),
      ).toBe(true);
    });

    it('should reject invalid Bitcoin addresses', () => {
      // Invalid format
      expect(
        validateTokenAddress('0A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin'),
      ).toBe(false);
      // Too short
      expect(validateTokenAddress('1A1zP1eP5Q', 'bitcoin')).toBe(false);
      // Invalid base58 characters
      expect(
        validateTokenAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf0a', 'bitcoin'),
      ).toBe(false);
      // Invalid Bech32
      expect(validateTokenAddress('bc1qinvalid', 'bitcoin')).toBe(false);
    });
  });

  describe('Litecoin Address Validation', () => {
    it('should validate Legacy P2PKH addresses (starts with L)', () => {
      expect(
        validateTokenAddress('LaMKfRwXKzGafgAviG8pg6WgUXU3Eecgfh', 'litecoin'),
      ).toBe(true);
      expect(
        validateTokenAddress('LhK2kQwiaAvhjWY799cZvMyYwnQAcQ6kdk', 'litecoin'),
      ).toBe(true);
    });

    it('should validate Legacy P2SH addresses (starts with M)', () => {
      expect(
        validateTokenAddress('MFoQgJRzAHyGN2RGGfPLVoRxDVnYKvRGHu', 'litecoin'),
      ).toBe(true);
      expect(
        validateTokenAddress('MWeaAUJZkkFwsmqHTQ9LW9bHqUZ6cVdEwZ', 'litecoin'),
      ).toBe(true);
    });

    it('should validate SegWit Bech32 addresses (starts with ltc1)', () => {
      // P2WPKH (SegWit v0) - Valid Litecoin bech32 address
      expect(
        validateTokenAddress(
          'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
          'litecoin',
        ),
      ).toBe(true);
    });

    it('should reject invalid Litecoin addresses', () => {
      // Invalid format
      expect(
        validateTokenAddress('XaMKfRwXKzGafgAviG8pg6WgUXU3Eecgfh', 'litecoin'),
      ).toBe(false);
      // Too short
      expect(validateTokenAddress('LaMKfRwX', 'litecoin')).toBe(false);
      // Wrong prefix for SegWit
      expect(
        validateTokenAddress(
          'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
          'litecoin',
        ),
      ).toBe(false);
    });
  });

  describe('Ecosystem Detection', () => {
    it('should detect Solana ecosystem', () => {
      expect(getEcosystemFromChainId('solana-mainnet')).toBe(
        BlockchainEcosystem.SOLANA,
      );
      expect(getEcosystemFromChainId('solana')).toBe(
        BlockchainEcosystem.SOLANA,
      );
      expect(getEcosystemFromChainId('sol')).toBe(BlockchainEcosystem.SOLANA);
      expect(getEcosystemFromChainId(7565164)).toBe(BlockchainEcosystem.SOLANA);
      expect(getEcosystemFromChainId(1399811149)).toBe(
        BlockchainEcosystem.SOLANA,
      );
    });

    it('should detect Tron ecosystem', () => {
      expect(getEcosystemFromChainId('tron-mainnet')).toBe(
        BlockchainEcosystem.TRON,
      );
      expect(getEcosystemFromChainId('tron')).toBe(BlockchainEcosystem.TRON);
      expect(getEcosystemFromChainId('trx')).toBe(BlockchainEcosystem.TRON);
      expect(getEcosystemFromChainId(195)).toBe(BlockchainEcosystem.TRON);
    });

    it('should detect Bitcoin ecosystem', () => {
      expect(getEcosystemFromChainId('bitcoin-mainnet')).toBe('bitcoin');
      expect(getEcosystemFromChainId('bitcoin')).toBe('bitcoin');
      expect(getEcosystemFromChainId('btc')).toBe('bitcoin');
    });

    it('should detect Litecoin ecosystem', () => {
      expect(getEcosystemFromChainId('litecoin-mainnet')).toBe('litecoin');
      expect(getEcosystemFromChainId('litecoin')).toBe('litecoin');
      expect(getEcosystemFromChainId('ltc')).toBe('litecoin');
    });

    it('should default to EVM for numeric chain IDs', () => {
      expect(getEcosystemFromChainId(1)).toBe(BlockchainEcosystem.EVM);
      expect(getEcosystemFromChainId(56)).toBe(BlockchainEcosystem.EVM);
      expect(getEcosystemFromChainId(137)).toBe(BlockchainEcosystem.EVM);
    });
  });

  describe('validateTokenAddressForChain', () => {
    it('should validate EVM addresses for EVM chains', () => {
      expect(
        validateTokenAddressForChain(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          1,
        ),
      ).toBe(true);
      expect(
        validateTokenAddressForChain(
          '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          56,
        ),
      ).toBe(true);
    });

    it('should validate Solana addresses for Solana chain', () => {
      expect(
        validateTokenAddressForChain(
          'So11111111111111111111111111111111111111112',
          'solana-mainnet',
        ),
      ).toBe(true);
      expect(
        validateTokenAddressForChain(
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          7565164,
        ),
      ).toBe(true);
    });

    it('should validate Tron addresses for Tron chain', () => {
      expect(
        validateTokenAddressForChain(
          'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          'tron-mainnet',
        ),
      ).toBe(true);
      expect(
        validateTokenAddressForChain('TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 195),
      ).toBe(true);
    });

    it('should validate Bitcoin addresses for Bitcoin chain', () => {
      expect(
        validateTokenAddressForChain(
          '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
          'bitcoin-mainnet',
        ),
      ).toBe(true);
      expect(
        validateTokenAddressForChain(
          'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          'bitcoin',
        ),
      ).toBe(true);
    });

    it('should reject wrong address format for chain', () => {
      // EVM address on Solana chain
      expect(
        validateTokenAddressForChain(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          'solana-mainnet',
        ),
      ).toBe(false);
      // Solana address on EVM chain
      expect(
        validateTokenAddressForChain(
          'So11111111111111111111111111111111111111112',
          1,
        ),
      ).toBe(false);
      // Tron address on EVM chain
      expect(
        validateTokenAddressForChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 56),
      ).toBe(false);
    });
  });

  describe('Address Normalization', () => {
    it('should normalize EVM addresses to lowercase', () => {
      const address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
      expect(normalizeTokenAddress(address, BlockchainEcosystem.EVM)).toBe(
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      );
    });

    it('should NOT normalize Solana addresses (case-sensitive)', () => {
      const address = 'So11111111111111111111111111111111111111112';
      expect(normalizeTokenAddress(address, BlockchainEcosystem.SOLANA)).toBe(
        address,
      );
    });

    it('should NOT normalize Tron addresses (case-sensitive)', () => {
      const address = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      expect(normalizeTokenAddress(address, BlockchainEcosystem.TRON)).toBe(
        address,
      );
    });

    it('should NOT normalize Bitcoin addresses (case-sensitive)', () => {
      const address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
      expect(normalizeTokenAddress(address, 'bitcoin')).toBe(address);
    });

    it('should NOT normalize Litecoin addresses (case-sensitive)', () => {
      const address = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9';
      expect(normalizeTokenAddress(address, 'litecoin')).toBe(address);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null/undefined addresses', () => {
      expect(validateTokenAddress(null as any, BlockchainEcosystem.EVM)).toBe(
        false,
      );
      expect(
        validateTokenAddress(undefined as any, BlockchainEcosystem.EVM),
      ).toBe(false);
    });

    it('should handle empty strings', () => {
      expect(validateTokenAddress('', BlockchainEcosystem.EVM)).toBe(false);
      expect(validateTokenAddress('', BlockchainEcosystem.SOLANA)).toBe(false);
    });

    it('should handle non-string inputs', () => {
      expect(validateTokenAddress(123 as any, BlockchainEcosystem.EVM)).toBe(
        false,
      );
      expect(validateTokenAddress({} as any, BlockchainEcosystem.EVM)).toBe(
        false,
      );
    });

    it('should handle unknown ecosystems', () => {
      expect(
        validateTokenAddress(
          '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          'unknown' as any,
        ),
      ).toBe(false);
    });
  });
});
