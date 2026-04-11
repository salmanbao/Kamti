import {
  isNativeToken,
  isEeeeFormat,
  isZeroFormat,
  convertToProviderFormat,
  normalizeTokenAddress,
  convertBetweenProviders,
  getProviderNativeFormat,
  batchConvertToProviderFormat,
  isValidForProvider,
  NativeTokenFormat,
  ProviderType,
} from './token-address.utils';

describe('TokenAddressUtils', () => {
  const EEEE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const USDT_ADDRESS = '0xdac17f958d2ee523a2206206994597c13d831ec7';

  describe('isNativeToken', () => {
    it('should identify 0xeeee... as native token', () => {
      expect(isNativeToken(EEEE_ADDRESS)).toBe(true);
      expect(isNativeToken(EEEE_ADDRESS.toUpperCase())).toBe(true);
    });

    it('should identify 0x0000... as native token', () => {
      expect(isNativeToken(ZERO_ADDRESS)).toBe(true);
      expect(isNativeToken(ZERO_ADDRESS.toUpperCase())).toBe(true);
    });

    it('should identify "native" keyword as native token', () => {
      expect(isNativeToken('native')).toBe(true);
      expect(isNativeToken('NATIVE')).toBe(true);
    });

    it('should identify chain symbols as native tokens', () => {
      expect(isNativeToken('eth')).toBe(true);
      expect(isNativeToken('bnb')).toBe(true);
      expect(isNativeToken('matic')).toBe(true);
    });

    it('should not identify ERC20 addresses as native tokens', () => {
      expect(isNativeToken(USDT_ADDRESS)).toBe(false);
    });
  });

  describe('isEeeeFormat', () => {
    it('should identify 0xeeee... format', () => {
      expect(isEeeeFormat(EEEE_ADDRESS)).toBe(true);
    });

    it('should not identify 0x0000... as eeee format', () => {
      expect(isEeeeFormat(ZERO_ADDRESS)).toBe(false);
    });
  });

  describe('isZeroFormat', () => {
    it('should identify 0x0000... format', () => {
      expect(isZeroFormat(ZERO_ADDRESS)).toBe(true);
    });

    it('should not identify 0xeeee... as zero format', () => {
      expect(isZeroFormat(EEEE_ADDRESS)).toBe(false);
    });
  });

  describe('convertToProviderFormat', () => {
    it('should convert native token to 0xeeee... for 0x provider', () => {
      expect(convertToProviderFormat('native', ProviderType.ZERO_X)).toBe(
        EEEE_ADDRESS,
      );
      expect(convertToProviderFormat(ZERO_ADDRESS, ProviderType.ZERO_X)).toBe(
        EEEE_ADDRESS,
      );
    });

    it('should convert native token to 0x0000... for Rubic provider', () => {
      expect(convertToProviderFormat('native', ProviderType.RUBIC)).toBe(
        ZERO_ADDRESS,
      );
      expect(convertToProviderFormat(EEEE_ADDRESS, ProviderType.RUBIC)).toBe(
        ZERO_ADDRESS,
      );
    });

    it('should not convert ERC20 token addresses', () => {
      expect(convertToProviderFormat(USDT_ADDRESS, ProviderType.ZERO_X)).toBe(
        USDT_ADDRESS,
      );
      expect(convertToProviderFormat(USDT_ADDRESS, ProviderType.RUBIC)).toBe(
        USDT_ADDRESS,
      );
    });

    it('should default to 0xeeee... for unknown providers', () => {
      expect(convertToProviderFormat('native', 'unknown-provider')).toBe(
        EEEE_ADDRESS,
      );
    });
  });

  describe('normalizeTokenAddress', () => {
    it('should normalize native tokens to 0xeeee... format', () => {
      expect(normalizeTokenAddress('native')).toBe(EEEE_ADDRESS);
      expect(normalizeTokenAddress(ZERO_ADDRESS)).toBe(EEEE_ADDRESS);
      expect(normalizeTokenAddress('eth')).toBe(EEEE_ADDRESS);
    });

    it('should not change ERC20 addresses', () => {
      expect(normalizeTokenAddress(USDT_ADDRESS)).toBe(USDT_ADDRESS);
    });
  });

  describe('convertBetweenProviders', () => {
    it('should convert from 0x to Rubic format', () => {
      const result = convertBetweenProviders(
        EEEE_ADDRESS,
        ProviderType.ZERO_X,
        ProviderType.RUBIC,
      );
      expect(result).toBe(ZERO_ADDRESS);
    });

    it('should convert from Rubic to 0x format', () => {
      const result = convertBetweenProviders(
        ZERO_ADDRESS,
        ProviderType.RUBIC,
        ProviderType.ZERO_X,
      );
      expect(result).toBe(EEEE_ADDRESS);
    });

    it('should not convert ERC20 addresses', () => {
      const result = convertBetweenProviders(
        USDT_ADDRESS,
        ProviderType.ZERO_X,
        ProviderType.RUBIC,
      );
      expect(result).toBe(USDT_ADDRESS);
    });
  });

  describe('getProviderNativeFormat', () => {
    it('should return 0xeeee... for 0x provider', () => {
      expect(getProviderNativeFormat(ProviderType.ZERO_X)).toBe(
        NativeTokenFormat.EEEE,
      );
    });

    it('should return 0x0000... for Rubic provider', () => {
      expect(getProviderNativeFormat(ProviderType.RUBIC)).toBe(
        NativeTokenFormat.ZERO,
      );
    });

    it('should return 0xeeee... for Odos provider', () => {
      expect(getProviderNativeFormat(ProviderType.ODOS)).toBe(
        NativeTokenFormat.EEEE,
      );
    });

    it('should default to 0xeeee... for unknown providers', () => {
      expect(getProviderNativeFormat('unknown')).toBe(NativeTokenFormat.EEEE);
    });
  });

  describe('batchConvertToProviderFormat', () => {
    it('should convert multiple token addresses for 0x provider', () => {
      const result = batchConvertToProviderFormat(
        {
          fromToken: 'native',
          toToken: USDT_ADDRESS,
        },
        ProviderType.ZERO_X,
      );

      expect(result.fromToken).toBe(EEEE_ADDRESS);
      expect(result.toToken).toBe(USDT_ADDRESS);
    });

    it('should convert multiple token addresses for Rubic provider', () => {
      const result = batchConvertToProviderFormat(
        {
          fromToken: EEEE_ADDRESS,
          toToken: USDT_ADDRESS,
        },
        ProviderType.RUBIC,
      );

      expect(result.fromToken).toBe(ZERO_ADDRESS);
      expect(result.toToken).toBe(USDT_ADDRESS);
    });

    it('should handle both native tokens', () => {
      const result = batchConvertToProviderFormat(
        {
          sellToken: 'native',
          buyToken: 'eth',
        },
        ProviderType.ZERO_X,
      );

      expect(result.sellToken).toBe(EEEE_ADDRESS);
      expect(result.buyToken).toBe(EEEE_ADDRESS);
    });
  });

  describe('isValidForProvider', () => {
    it('should validate correct native format for 0x provider', () => {
      expect(isValidForProvider(EEEE_ADDRESS, ProviderType.ZERO_X)).toBe(true);
      expect(isValidForProvider(ZERO_ADDRESS, ProviderType.ZERO_X)).toBe(false);
    });

    it('should validate correct native format for Rubic provider', () => {
      expect(isValidForProvider(ZERO_ADDRESS, ProviderType.RUBIC)).toBe(true);
      expect(isValidForProvider(EEEE_ADDRESS, ProviderType.RUBIC)).toBe(false);
    });

    it('should validate ERC20 addresses for all providers', () => {
      expect(isValidForProvider(USDT_ADDRESS, ProviderType.ZERO_X)).toBe(true);
      expect(isValidForProvider(USDT_ADDRESS, ProviderType.RUBIC)).toBe(true);
      expect(isValidForProvider(USDT_ADDRESS, ProviderType.ODOS)).toBe(true);
    });

    it('should reject invalid address formats', () => {
      expect(isValidForProvider('invalid', ProviderType.ZERO_X)).toBe(false);
      expect(isValidForProvider('0x123', ProviderType.ZERO_X)).toBe(false);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle BNB swap on BSC with 0x', () => {
      const fromToken = convertToProviderFormat('native', ProviderType.ZERO_X);
      const toToken = '0x55d398326f99059ff775485246999027b3197955'; // USDT on BSC

      expect(fromToken).toBe(EEEE_ADDRESS);
      expect(toToken).toBe('0x55d398326f99059ff775485246999027b3197955');
    });

    it('should handle ETH to BTC cross-chain with Rubic', () => {
      const fromToken = convertToProviderFormat(
        EEEE_ADDRESS,
        ProviderType.RUBIC,
      );
      const toToken = convertToProviderFormat('native', ProviderType.RUBIC);

      expect(fromToken).toBe(ZERO_ADDRESS);
      expect(toToken).toBe(ZERO_ADDRESS);
    });

    it('should handle conversion from aggregator response to provider request', () => {
      // Received from one provider in 0xeeee... format
      const receivedToken = EEEE_ADDRESS;

      // Converting for use with different providers
      const for0x = convertToProviderFormat(receivedToken, ProviderType.ZERO_X);
      const forRubic = convertToProviderFormat(
        receivedToken,
        ProviderType.RUBIC,
      );
      const forOdos = convertToProviderFormat(receivedToken, ProviderType.ODOS);

      expect(for0x).toBe(EEEE_ADDRESS);
      expect(forRubic).toBe(ZERO_ADDRESS);
      expect(forOdos).toBe(EEEE_ADDRESS);
    });
  });
});
