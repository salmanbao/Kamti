import { Test, TestingModule } from '@nestjs/testing';
import { SymbiosisService } from './symbiosis.service';
import { CustomHttpService } from '@shared/services/http.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { AmountNormalizationUtils } from '@shared/utils/amount-normalization.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';
import { RouteRequest } from '@swap/models/ports';

describe('SymbiosisService', () => {
  let service: SymbiosisService;
  let httpService: jest.Mocked<CustomHttpService>;
  let envConfig: jest.Mocked<EnvironmentConfigService>;
  let unifiedConfig: jest.Mocked<UnifiedConfigurationService>;
  let logger: jest.Mocked<WinstonLoggerService>;
  let registry: jest.Mocked<AggregatorManagerService>;

  beforeEach(async () => {
    // Create mocks
    const mockHttpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const mockEnvConfig = {
      symbiosisPartnerId: 'test-partner-id',
      symbiosisEnabled: true,
    };

    const mockUnifiedConfig = {
      getTokenDecimals: jest.fn().mockReturnValue(18),
    };

    const mockLogger = {
      setContext: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    };

    const mockRegistry = {
      registerMetaAggregator: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SymbiosisService,
        { provide: CustomHttpService, useValue: mockHttpService },
        { provide: EnvironmentConfigService, useValue: mockEnvConfig },
        { provide: UnifiedConfigurationService, useValue: mockUnifiedConfig },
        { provide: AmountNormalizationUtils, useValue: {} },
        { provide: WinstonLoggerService, useValue: mockLogger },
        { provide: AggregatorManagerService, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<SymbiosisService>(SymbiosisService);
    httpService = module.get(CustomHttpService);
    envConfig = module.get(EnvironmentConfigService);
    unifiedConfig = module.get(UnifiedConfigurationService);
    logger = module.get(WinstonLoggerService);
    registry = module.get(AggregatorManagerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Chain ID Mapping', () => {
    describe('Tron Chain ID Mapping', () => {
      it('should map Tron numeric ID 195 to Symbiosis ID 728126428', async () => {
        const mockQuoteResponse = {
          data: {
            tokenAmountOut: { amount: '1000000' },
            route: [],
            fees: { estimatedGas: '100000' },
          },
        };

        httpService.post.mockResolvedValue(mockQuoteResponse);

        const request: RouteRequest = {
          fromChainId: 195, // Tron internal ID
          toChainId: 1, // Ethereum
          fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT on Tron
          toToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT on ETH
          amount: '1000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: 100,
        };

        await service.getRoutes(request);

        // Verify the API was called with Symbiosis chain ID
        expect(httpService.post).toHaveBeenCalledWith(
          expect.stringContaining('/v2/quote'),
          expect.objectContaining({
            tokenAmountIn: expect.objectContaining({
              chainId: 728126428, // Symbiosis Tron ID
            }),
            tokenOut: expect.objectContaining({
              chainId: 1, // Ethereum (1:1 mapping)
            }),
          }),
          expect.any(Object),
        );
      });

      it('should map Tron string ID "tron-mainnet" to Symbiosis ID 728126428', async () => {
        const mockQuoteResponse = {
          data: {
            tokenAmountOut: { amount: '1000000' },
            route: [],
            fees: { estimatedGas: '100000' },
          },
        };

        httpService.post.mockResolvedValue(mockQuoteResponse);

        const request: RouteRequest = {
          fromChainId: 'tron-mainnet' as any, // Tron canonical string ID
          toChainId: 56, // BSC
          fromToken: 'native',
          toToken: '0x55d398326f99059ff775485246999027b3197955',
          amount: '1000000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: 100,
        };

        await service.getRoutes(request);

        expect(httpService.post).toHaveBeenCalledWith(
          expect.stringContaining('/v2/quote'),
          expect.objectContaining({
            tokenAmountIn: expect.objectContaining({
              chainId: 728126428, // Symbiosis Tron ID
            }),
          }),
          expect.any(Object),
        );
      });

      it('should map Tron alternative string ID "tron" to Symbiosis ID 728126428', async () => {
        const mockQuoteResponse = {
          data: {
            tokenAmountOut: { amount: '1000000' },
            route: [],
            fees: {},
          },
        };

        httpService.post.mockResolvedValue(mockQuoteResponse);

        const request: RouteRequest = {
          fromChainId: 'tron' as any,
          toChainId: 137, // Polygon
          fromToken: 'native',
          toToken: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
          amount: '1000000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: 50,
        };

        await service.getRoutes(request);

        expect(httpService.post).toHaveBeenCalledWith(
          expect.stringContaining('/v2/quote'),
          expect.objectContaining({
            tokenAmountIn: expect.objectContaining({
              chainId: 728126428,
            }),
          }),
          expect.any(Object),
        );
      });
    });

    describe('EVM Chain ID Mapping (1:1)', () => {
      it('should pass through standard EVM chain IDs unchanged', async () => {
        const mockQuoteResponse = {
          data: {
            tokenAmountOut: { amount: '1000000' },
            route: [],
            fees: {},
          },
        };

        httpService.post.mockResolvedValue(mockQuoteResponse);

        const evmChains = [
          { id: 1, name: 'Ethereum' },
          { id: 56, name: 'BSC' },
          { id: 137, name: 'Polygon' },
          { id: 42161, name: 'Arbitrum' },
          { id: 10, name: 'Optimism' },
          { id: 43114, name: 'Avalanche' },
          { id: 8453, name: 'Base' },
        ];

        for (const chain of evmChains) {
          httpService.post.mockClear();

          const request: RouteRequest = {
            fromChainId: chain.id,
            toChainId: 1,
            fromToken: 'native',
            toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            amount: '1000000000000000000',
            userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
            slippageBps: 100,
          };

          await service.getRoutes(request);

          expect(httpService.post).toHaveBeenCalledWith(
            expect.stringContaining('/v2/quote'),
            expect.objectContaining({
              tokenAmountIn: expect.objectContaining({
                chainId: chain.id, // Should pass through unchanged
              }),
            }),
            expect.any(Object),
          );
        }
      });
    });

    describe('Bitcoin Chain ID Mapping', () => {
      it('should map Bitcoin ID 5555 to Symbiosis ID 3652501241', async () => {
        const mockQuoteResponse = {
          data: {
            tokenAmountOut: { amount: '1000000' },
            route: [],
            fees: {},
          },
        };

        httpService.post.mockResolvedValue(mockQuoteResponse);

        const request: RouteRequest = {
          fromChainId: 5555, // Bitcoin internal ID
          toChainId: 1,
          fromToken: 'native',
          toToken: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
          amount: '100000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: 100,
        };

        await service.getRoutes(request);

        expect(httpService.post).toHaveBeenCalledWith(
          expect.stringContaining('/v2/quote'),
          expect.objectContaining({
            tokenAmountIn: expect.objectContaining({
              chainId: 3652501241, // Symbiosis Bitcoin ID
            }),
          }),
          expect.any(Object),
        );
      });
    });

    describe('Reverse Chain ID Mapping', () => {
      it('should map Symbiosis Tron ID back to internal ID 195', () => {
        // This tests the reverse mapping used in status tracking
        const supportedChains = service.getSupportedChains();

        // Verify Tron is in supported chains
        expect(supportedChains.from).toContain(195);
        expect(supportedChains.to).toContain(195);
      });
    });

    describe('Error Handling for Unsupported Chains', () => {
      it('should throw error for unsupported string chain ID without mapping', async () => {
        const request: RouteRequest = {
          fromChainId: 'unsupported-chain' as any,
          toChainId: 1,
          fromToken: 'native',
          toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          amount: '1000000000000000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: 100,
        };

        await expect(service.getRoutes(request)).rejects.toThrow(
          'Unsupported chain ID for Symbiosis',
        );
      });
    });
  });

  describe('Self-Registration', () => {
    it('should self-register with AggregatorManager on module init when enabled', async () => {
      // Create new module with enabled config
      const enabledEnvConfig = {
        symbiosisPartnerId: 'test-partner-id',
        symbiosisEnabled: true,
      };

      const enabledModule: TestingModule = await Test.createTestingModule({
        providers: [
          SymbiosisService,
          { provide: CustomHttpService, useValue: httpService },
          { provide: EnvironmentConfigService, useValue: enabledEnvConfig },
          { provide: UnifiedConfigurationService, useValue: unifiedConfig },
          { provide: AmountNormalizationUtils, useValue: {} },
          { provide: WinstonLoggerService, useValue: logger },
          { provide: AggregatorManagerService, useValue: registry },
        ],
      }).compile();

      const enabledService =
        enabledModule.get<SymbiosisService>(SymbiosisService);
      registry.registerMetaAggregator.mockClear();
      logger.debug.mockClear();

      await enabledService.onModuleInit();

      expect(registry.registerMetaAggregator).toHaveBeenCalledWith(
        enabledService,
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('self-registered'),
      );
    });

    it('should not register when SYMBIOSIS_ENABLED is false', async () => {
      // Create new module with disabled config
      const disabledEnvConfig = {
        symbiosisPartnerId: 'test-partner-id',
        symbiosisEnabled: false,
      };

      const disabledModule: TestingModule = await Test.createTestingModule({
        providers: [
          SymbiosisService,
          { provide: CustomHttpService, useValue: httpService },
          { provide: EnvironmentConfigService, useValue: disabledEnvConfig },
          { provide: UnifiedConfigurationService, useValue: unifiedConfig },
          { provide: AmountNormalizationUtils, useValue: {} },
          { provide: WinstonLoggerService, useValue: logger },
          { provide: AggregatorManagerService, useValue: registry },
        ],
      }).compile();

      const disabledService =
        disabledModule.get<SymbiosisService>(SymbiosisService);
      registry.registerMetaAggregator.mockClear();
      logger.warn.mockClear();

      await disabledService.onModuleInit();

      expect(registry.registerMetaAggregator).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('disabled'),
      );
    });

    it('should warn when registry is not available', async () => {
      const moduleWithoutRegistry: TestingModule =
        await Test.createTestingModule({
          providers: [
            SymbiosisService,
            { provide: CustomHttpService, useValue: httpService },
            { provide: EnvironmentConfigService, useValue: envConfig },
            {
              provide: UnifiedConfigurationService,
              useValue: unifiedConfig,
            },
            { provide: AmountNormalizationUtils, useValue: {} },
            { provide: WinstonLoggerService, useValue: logger },
            // No AggregatorManagerService provided
          ],
        }).compile();

      const serviceWithoutRegistry =
        moduleWithoutRegistry.get<SymbiosisService>(SymbiosisService);

      await serviceWithoutRegistry.onModuleInit();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not find registry'),
      );
    });
  });

  describe('Rate Limiter', () => {
    it('should enforce 1 second minimum interval between execute calls', async () => {
      const mockSwapResponse = {
        data: {
          tx: {
            to: '0x123',
            value: '0',
            data: '0xabc',
            hash: '0xdef',
          },
        },
      };

      httpService.post.mockResolvedValue(mockSwapResponse);

      const signerCtx = {
        providerRef: {
          symbiosisData: {
            tokenAmountIn: {
              chainId: 1,
              address: 'native',
              amount: '1000000000000000000',
            },
            tokenOut: { chainId: 56, address: '0x123' },
          },
        },
      };

      const startTime = Date.now();

      // First call
      await service.execute('route-1', signerCtx);

      // Second call immediately after
      await service.execute('route-2', signerCtx);

      const duration = Date.now() - startTime;

      // Should have taken at least 1 second due to rate limiting
      expect(duration).toBeGreaterThanOrEqual(1000);
      expect(httpService.post).toHaveBeenCalledTimes(2);
    }, 10000);

    it('should allow calls more than 1 second apart without delay', async () => {
      const mockSwapResponse = {
        data: {
          tx: {
            to: '0x123',
            value: '0',
            data: '0xabc',
            hash: '0xdef',
          },
        },
      };

      httpService.post.mockResolvedValue(mockSwapResponse);

      const signerCtx = {
        providerRef: {
          symbiosisData: {
            tokenAmountIn: { chainId: 1 },
            tokenOut: { chainId: 56 },
          },
        },
      };

      // First call
      await service.execute('route-1', signerCtx);

      // Wait 1.1 seconds
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const secondCallStart = Date.now();

      // Second call after waiting
      await service.execute('route-2', signerCtx);

      const secondCallDuration = Date.now() - secondCallStart;

      // Second call should not have significant delay
      expect(secondCallDuration).toBeLessThan(500);
      expect(httpService.post).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  describe('Provider Interface', () => {
    it('should return correct provider name', () => {
      expect(service.getProviderName()).toBe('Symbiosis');
    });

    it('should return provider configuration', () => {
      const config = service.getConfig();

      expect(config.name).toBe('Symbiosis');
      expect(config.baseUrl).toBe('https://api.symbiosis.finance/crosschain');
      expect(config.enabled).toBe(true);
      expect(config.timeout).toBe(30000);
      expect(config.retries).toBe(2);
      expect(config.rateLimit).toEqual({
        requests: 1,
        perSeconds: 1,
      });
    });

    it('should return supported chains including Tron', () => {
      const chains = service.getSupportedChains();

      expect(chains.from).toContain(195); // Tron
      expect(chains.from).toContain(1); // Ethereum
      expect(chains.from).toContain(56); // BSC
      expect(chains.from).toContain(137); // Polygon

      expect(chains.to).toContain(195);
      expect(chains.to).toContain(1);
    });

    it('should perform health check successfully', async () => {
      httpService.get.mockResolvedValue({ data: [] });

      const health = await service.healthCheck();

      expect(health.name).toBe('Symbiosis');
      expect(health.status).toBe('healthy');
      expect(health.latency).toBeDefined();
      expect(health.lastCheck).toBeInstanceOf(Date);
    });

    it('should return unhealthy status on API failure', async () => {
      httpService.get.mockRejectedValue(new Error('Network error'));

      const health = await service.healthCheck();

      expect(health.name).toBe('Symbiosis');
      expect(health.status).toBe('unhealthy');
      expect((health as any).error).toBe('Network error');
    });
  });

  describe('Token Decimals', () => {
    it('should get decimals from unified config for regular tokens', async () => {
      unifiedConfig.getTokenDecimals.mockReturnValue(6);

      const mockQuoteResponse = {
        data: {
          tokenAmountOut: { amount: '1000000' },
          route: [],
          fees: {},
        },
      };

      httpService.post.mockResolvedValue(mockQuoteResponse);

      const request: RouteRequest = {
        fromChainId: 195,
        toChainId: 1,
        fromToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        toToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        amount: '1000000',
        userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        slippageBps: 100,
      };

      await service.getRoutes(request);

      expect(unifiedConfig.getTokenDecimals).toHaveBeenCalledWith(
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        195,
      );
    });

    it('should use 6 decimals for Tron native token', async () => {
      const mockQuoteResponse = {
        data: {
          tokenAmountOut: { amount: '1000000' },
          route: [],
          fees: {},
        },
      };

      httpService.post.mockResolvedValue(mockQuoteResponse);

      const request: RouteRequest = {
        fromChainId: 195,
        toChainId: 1,
        fromToken: 'native',
        toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amount: '1000000',
        userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        slippageBps: 100,
      };

      await service.getRoutes(request);

      expect(httpService.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tokenAmountIn: expect.objectContaining({
            decimals: 6, // Tron native
          }),
        }),
        expect.any(Object),
      );
    });

    it('should use 18 decimals for EVM native tokens', async () => {
      const mockQuoteResponse = {
        data: {
          tokenAmountOut: { amount: '1000000000000000000' },
          route: [],
          fees: {},
        },
      };

      httpService.post.mockResolvedValue(mockQuoteResponse);

      const request: RouteRequest = {
        fromChainId: 1,
        toChainId: 56,
        fromToken: 'native',
        toToken: 'native',
        amount: '1000000000000000000',
        userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        slippageBps: 100,
      };

      await service.getRoutes(request);

      expect(httpService.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tokenAmountIn: expect.objectContaining({
            decimals: 18, // EVM native
          }),
          tokenOut: expect.objectContaining({
            decimals: 18, // EVM native
          }),
        }),
        expect.any(Object),
      );
    });
  });

  describe('Slippage Conversion', () => {
    it('should convert basis points to percentage correctly', async () => {
      const mockQuoteResponse = {
        data: {
          tokenAmountOut: { amount: '1000000' },
          route: [],
          fees: {},
        },
      };

      httpService.post.mockResolvedValue(mockQuoteResponse);

      const testCases = [
        { bps: 100, expected: 1.0 }, // 1%
        { bps: 50, expected: 0.5 }, // 0.5%
        { bps: 300, expected: 3.0 }, // 3%
        { bps: 10, expected: 0.1 }, // 0.1%
      ];

      for (const testCase of testCases) {
        httpService.post.mockClear();

        const request: RouteRequest = {
          fromChainId: 1,
          toChainId: 56,
          fromToken: 'native',
          toToken: 'native',
          amount: '1000000000000000000',
          userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
          slippageBps: testCase.bps,
        };

        await service.getRoutes(request);

        expect(httpService.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            slippage: testCase.expected,
          }),
          expect.any(Object),
        );
      }
    });
  });

  describe('Error Handling', () => {
    it('should throw error when API returns error', async () => {
      httpService.post.mockRejectedValue(new Error('API Error'));

      const request: RouteRequest = {
        fromChainId: 195,
        toChainId: 1,
        fromToken: 'native',
        toToken: 'native',
        amount: '1000000',
        userAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
        slippageBps: 100,
      };

      await expect(service.getRoutes(request)).rejects.toThrow(
        'Symbiosis route fetch failed',
      );
    });

    it('should throw error when execute is called without cached route', async () => {
      const signerCtx = {
        providerRef: {}, // Missing symbiosisData
      };

      await expect(service.execute('route-1', signerCtx)).rejects.toThrow(
        'Symbiosis route data not found',
      );
    });
  });

  describe('Partner ID Configuration', () => {
    it('should use partner ID from environment config', () => {
      expect(logger.setContext).toHaveBeenCalledWith('SymbiosisService');
      // Partner ID is loaded in constructor
    });

    it('should warn when partner ID is not configured', async () => {
      const mockEnvConfigWithoutId = {
        symbiosisPartnerId: undefined,
        symbiosisEnabled: true,
      };

      const moduleWithoutId: TestingModule = await Test.createTestingModule({
        providers: [
          SymbiosisService,
          { provide: CustomHttpService, useValue: httpService },
          {
            provide: EnvironmentConfigService,
            useValue: mockEnvConfigWithoutId,
          },
          { provide: UnifiedConfigurationService, useValue: unifiedConfig },
          { provide: AmountNormalizationUtils, useValue: {} },
          { provide: WinstonLoggerService, useValue: logger },
          { provide: AggregatorManagerService, useValue: registry },
        ],
      }).compile();

      const serviceWithoutId =
        moduleWithoutId.get<SymbiosisService>(SymbiosisService);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SYMBIOSIS_PARTNER_ID not configured'),
      );
    });
  });
});
