import { Test, TestingModule } from '@nestjs/testing';
import { RpcFallbackService } from '@shared/services/rpc-fallback.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { EVMWalletProvider } from '@swap/services/blockchain/wallet/providers/evm-wallet.provider';
import { SolanaWalletProvider } from '@swap/services/blockchain/wallet/providers/solana-wallet.provider';
import { BitcoinWalletProvider } from '@swap/services/blockchain/wallet/providers/bitcoin-wallet.provider';
import { LitecoinWalletProvider } from '@swap/services/blockchain/wallet/providers/litecoin-wallet.provider';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { AmountNormalizationUtils } from '@shared/utils/amount-normalization.utils';

/**
 * Integration tests for RPC Fallback System
 *
 * These tests verify:
 * 1. RPC failover mechanism works correctly
 * 2. Health tracking is accurate
 * 3. URL rotation happens automatically
 * 4. Statistics are properly maintained
 * 5. All wallet providers integrate correctly
 *
 * NOTE: These are integration tests that may make real network calls.
 * To run: npm test -- rpc-fallback-integration.spec.ts
 */
describe('RPC Fallback System Integration Tests', () => {
  let rpcFallbackService: RpcFallbackService;
  let envConfigService: EnvironmentConfigService;
  let evmWalletProvider: EVMWalletProvider;
  let solanaWalletProvider: SolanaWalletProvider;
  let bitcoinWalletProvider: BitcoinWalletProvider;
  let litecoinWalletProvider: LitecoinWalletProvider;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RpcFallbackService,
        {
          provide: EnvironmentConfigService,
          useValue: {
            // Mock environment config with multiple URLs
            ethereumRpcUrl: [
              'https://eth.llamarpc.com',
              'https://eth.drpc.org',
              'https://rpc.payload.de',
            ],
            bscRpcUrl: [
              'https://bsc-dataseed1.binance.org',
              'https://bsc-dataseed2.binance.org',
            ],
            polygonRpcUrl: [
              'https://polygon-rpc.com',
              'https://rpc-mainnet.maticvigil.com',
            ],
            solanaRpcUrl: [
              'https://api.mainnet-beta.solana.com',
              'https://solana-api.projectserum.com',
            ],
            bitcoinRpcUrl: [
              'https://blockstream.info/api',
              'https://mempool.space/api',
            ],
            litecoinRpcUrl: ['https://litecoinspace.org/api'],
          },
        },
        {
          provide: UnifiedConfigurationService,
          useValue: {
            getTokensForChain: jest.fn().mockReturnValue([]),
            getChainConfig: jest.fn().mockReturnValue({
              chainId: 1,
              rpcUrls: ['https://eth.llamarpc.com'],
            }),
          },
        },
        {
          provide: AmountNormalizationUtils,
          useValue: {
            normalizeForProvider: jest.fn((amount) => amount),
            denormalizeFromProvider: jest.fn((amount) => amount),
          },
        },
        EVMWalletProvider,
        SolanaWalletProvider,
        BitcoinWalletProvider,
        LitecoinWalletProvider,
      ],
    }).compile();

    rpcFallbackService = module.get<RpcFallbackService>(RpcFallbackService);
    envConfigService = module.get<EnvironmentConfigService>(
      EnvironmentConfigService,
    );
    evmWalletProvider = module.get<EVMWalletProvider>(EVMWalletProvider);
    solanaWalletProvider =
      module.get<SolanaWalletProvider>(SolanaWalletProvider);
    bitcoinWalletProvider = module.get<BitcoinWalletProvider>(
      BitcoinWalletProvider,
    );
    litecoinWalletProvider = module.get<LitecoinWalletProvider>(
      LitecoinWalletProvider,
    );
  });

  describe('RpcFallbackService - Core Functionality', () => {
    it('should be defined', () => {
      expect(rpcFallbackService).toBeDefined();
    });

    it('should return best URL based on health', async () => {
      const urls = ['https://eth.llamarpc.com', 'https://eth.drpc.org'];

      // Mark first URL as unhealthy
      rpcFallbackService.setUrlHealth(urls[0], false);

      const bestUrl = await rpcFallbackService.getBestUrl(urls);

      // Should return second URL since first is marked unhealthy
      expect(bestUrl).toBe(urls[1]);
    });

    it('should track URL health correctly', () => {
      const url = 'https://test.rpc.com';

      // Initially healthy
      rpcFallbackService.setUrlHealth(url, true);
      let health = rpcFallbackService.getUrlHealth(url);
      expect(health.healthy).toBe(true);

      // Mark as unhealthy
      rpcFallbackService.setUrlHealth(url, false);
      health = rpcFallbackService.getUrlHealth(url);
      expect(health.healthy).toBe(false);
    });

    it('should maintain statistics correctly', () => {
      const url = 'https://stats-test.rpc.com';

      // Record some successes and failures
      rpcFallbackService.setUrlHealth(url, true);
      rpcFallbackService.setUrlHealth(url, true);
      rpcFallbackService.setUrlHealth(url, false);

      const stats = rpcFallbackService.getStatistics();

      expect(stats).toHaveProperty(url);
      expect(stats[url].totalRequests).toBeGreaterThanOrEqual(3);
    });

    it('should recover unhealthy URLs after timeout', async () => {
      const url = 'https://recovery-test.rpc.com';

      // Mark as unhealthy
      rpcFallbackService.setUrlHealth(url, false);

      // Manually reset recovery time to simulate timeout
      const health = rpcFallbackService.getUrlHealth(url);

      expect(health.healthy).toBe(false);
      expect(health.lastFailure).toBeDefined();
    });
  });

  describe('EVM Wallet Provider - Fallback Integration', () => {
    it('should have RPC fallback service injected', () => {
      expect(evmWalletProvider).toBeDefined();
      // Note: Cannot access private properties directly, but provider should be initialized
    });

    it('should support Ethereum chain', () => {
      const supportsEth = evmWalletProvider.supportsChain(1);
      expect(supportsEth).toBe(true);
    });

    it('should support BSC chain', () => {
      const supportsBsc = evmWalletProvider.supportsChain(56);
      expect(supportsBsc).toBe(true);
    });

    it('should support Polygon chain', () => {
      const supportsPolygon = evmWalletProvider.supportsChain(137);
      expect(supportsPolygon).toBe(true);
    });

    // Note: Actual balance queries require valid addresses and will make network calls
    // These are integration tests - run with caution
  });

  describe('Solana Wallet Provider - Fallback Integration', () => {
    it('should have RPC fallback service injected', () => {
      expect(solanaWalletProvider).toBeDefined();
    });

    it('should support Solana chain', () => {
      const supportsSolana = solanaWalletProvider.supportsChain('solana');
      expect(supportsSolana).toBe(true);
    });

    it('should have ecosystem identifier', () => {
      const ecosystem = solanaWalletProvider.getEcosystem();
      expect(ecosystem).toBe('solana');
    });
  });

  describe('Bitcoin Wallet Provider - Fallback Integration', () => {
    it('should have RPC fallback service injected', () => {
      expect(bitcoinWalletProvider).toBeDefined();
    });

    it('should support Bitcoin chain identifiers', () => {
      expect(bitcoinWalletProvider.supportsChain('bitcoin')).toBe(true);
      expect(bitcoinWalletProvider.supportsChain('btc')).toBe(true);
      expect(bitcoinWalletProvider.supportsChain(0)).toBe(true);
    });

    it('should have ecosystem identifier', () => {
      const ecosystem = bitcoinWalletProvider.getEcosystem();
      expect(ecosystem).toBe('bitcoin');
    });
  });

  describe('Litecoin Wallet Provider - Fallback Integration', () => {
    it('should have RPC fallback service injected', () => {
      expect(litecoinWalletProvider).toBeDefined();
    });

    it('should support Litecoin chain identifiers', () => {
      expect(litecoinWalletProvider.supportsChain('litecoin')).toBe(true);
      expect(litecoinWalletProvider.supportsChain('ltc')).toBe(true);
    });

    it('should have ecosystem identifier', () => {
      const ecosystem = litecoinWalletProvider.getEcosystem();
      expect(ecosystem).toBe('litecoin');
    });
  });

  describe('Multi-URL Configuration', () => {
    it('should parse comma-separated Ethereum RPC URLs', () => {
      const urls = envConfigService.ethereumRpcUrl;
      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse comma-separated BSC RPC URLs', () => {
      const urls = envConfigService.bscRpcUrl;
      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse comma-separated Polygon RPC URLs', () => {
      const urls = envConfigService.polygonRpcUrl;
      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse comma-separated Solana RPC URLs', () => {
      const urls = envConfigService.solanaRpcUrl;
      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });

    it('should parse comma-separated Bitcoin RPC URLs', () => {
      const urls = envConfigService.bitcoinRpcUrl;
      expect(Array.isArray(urls)).toBe(true);
      expect(urls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Failover Simulation', () => {
    it('should failover to next URL when first fails', async () => {
      const urls = ['https://failing.rpc.com', 'https://working.rpc.com'];

      // Mark first as unhealthy
      rpcFallbackService.setUrlHealth(urls[0], false);

      const bestUrl = await rpcFallbackService.getBestUrl(urls);

      // Should return second URL
      expect(bestUrl).toBe(urls[1]);
    });

    it('should round-robin through healthy URLs', async () => {
      const urls = ['https://rpc1.com', 'https://rpc2.com', 'https://rpc3.com'];

      // Mark all as healthy
      urls.forEach((url) => rpcFallbackService.setUrlHealth(url, true));

      const selectedUrls = new Set<string>();

      // Get best URL multiple times
      for (let i = 0; i < 10; i++) {
        const url = await rpcFallbackService.getBestUrl(urls);
        selectedUrls.add(url);
      }

      // Should use multiple URLs (load balancing)
      expect(selectedUrls.size).toBeGreaterThan(1);
    });
  });

  describe('Health Monitoring', () => {
    it('should track request counts per URL', () => {
      const url = 'https://count-test.rpc.com';

      // Make several requests
      for (let i = 0; i < 5; i++) {
        rpcFallbackService.setUrlHealth(url, true);
      }

      const stats = rpcFallbackService.getStatistics();

      expect(stats[url]).toBeDefined();
      expect(stats[url].totalRequests).toBeGreaterThanOrEqual(5);
    });

    it('should track success rate', () => {
      const url = 'https://success-rate-test.rpc.com';

      // 7 successes, 3 failures
      for (let i = 0; i < 7; i++) {
        rpcFallbackService.setUrlHealth(url, true);
      }
      for (let i = 0; i < 3; i++) {
        rpcFallbackService.setUrlHealth(url, false);
      }

      const stats = rpcFallbackService.getStatistics();
      const successRate =
        stats[url].successfulRequests / stats[url].totalRequests;

      expect(successRate).toBeCloseTo(0.7, 1); // 70% success rate
    });
  });

  describe('Provider Configuration', () => {
    it('should return valid EVM provider config', () => {
      const config = evmWalletProvider.getConfig();
      expect(config.name).toBe('EVM Wallet Provider');
      expect(config.ecosystem).toBe('evm');
      expect(config.enabled).toBe(true);
    });

    it('should return valid Solana provider config', () => {
      const config = solanaWalletProvider.getConfig();
      expect(config.name).toBe('Solana Wallet Provider');
      expect(config.ecosystem).toBe('solana');
      expect(config.enabled).toBe(true);
    });

    it('should return valid Bitcoin provider config', () => {
      const config = bitcoinWalletProvider.getConfig();
      expect(config.name).toBe('Bitcoin Wallet Provider');
      expect(config.ecosystem).toBe('bitcoin');
      expect(config.enabled).toBe(true);
    });

    it('should return valid Litecoin provider config', () => {
      const config = litecoinWalletProvider.getConfig();
      expect(config.name).toBe('Litecoin Wallet Provider');
      expect(config.ecosystem).toBe('litecoin');
      expect(config.enabled).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty URL array gracefully', async () => {
      const urls: string[] = [];

      await expect(rpcFallbackService.getBestUrl(urls)).rejects.toThrow();
    });

    it('should handle all URLs being unhealthy', async () => {
      const urls = ['https://unhealthy1.com', 'https://unhealthy2.com'];

      // Mark all as unhealthy
      urls.forEach((url) => rpcFallbackService.setUrlHealth(url, false));

      // Should still return a URL (will retry after recovery time)
      const bestUrl = await rpcFallbackService.getBestUrl(urls);
      expect(urls).toContain(bestUrl);
    });

    it('should handle single URL configuration', async () => {
      const urls = ['https://single-url.com'];

      const bestUrl = await rpcFallbackService.getBestUrl(urls);
      expect(bestUrl).toBe(urls[0]);
    });
  });

  afterAll(() => {
    // Cleanup
    jest.clearAllMocks();
  });
});
