import { Test, TestingModule } from '@nestjs/testing';
import { GasPriceCacheService } from './gas-price-cache.service';

describe('GasPriceCacheService', () => {
  let service: GasPriceCacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GasPriceCacheService],
    }).compile();

    service = module.get<GasPriceCacheService>(GasPriceCacheService);
  });

  afterEach(() => {
    service.clearCache();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getGasPrice', () => {
    it('should fetch gas price for Ethereum', async () => {
      const gasPrice = await service.getGasPrice(1);

      expect(gasPrice).toBeDefined();
      expect(gasPrice.chainId).toBe(1);
      expect(gasPrice.timestamp).toBeDefined();
      expect(gasPrice.eip1559).toBeDefined();
      expect(gasPrice.eip1559?.maxFeePerGas).toBeDefined();
      expect(gasPrice.eip1559?.baseFeePerGas).toBeDefined();
    }, 30000);

    it('should return cached gas price on second call', async () => {
      const first = await service.getGasPrice(1);
      const second = await service.getGasPrice(1);

      // Should be the same cached data
      expect(second.timestamp).toBe(first.timestamp);
      expect(second.chainId).toBe(first.chainId);
    }, 30000);

    it('should force refresh when requested', async () => {
      const first = await service.getGasPrice(1);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      const second = await service.getGasPrice(1, true);

      // Should have different timestamps
      expect(second.timestamp).toBeGreaterThan(first.timestamp);
    }, 30000);
  });

  describe('cache management', () => {
    it('should clear cache for specific chain', async () => {
      await service.getGasPrice(1);

      const stats1 = service.getCacheStats();
      expect(stats1.size).toBe(1);

      service.clearCache(1);

      const stats2 = service.getCacheStats();
      expect(stats2.size).toBe(0);
    }, 30000);

    it('should clear all caches', async () => {
      await service.getGasPrice(1);

      service.clearCache();

      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
    }, 30000);

    it('should provide cache statistics', async () => {
      await service.getGasPrice(1);

      const stats = service.getCacheStats();

      expect(stats.size).toBe(1);
      expect(stats.chains).toContain(1);
      expect(stats.entries).toHaveLength(1);
      expect(stats.entries[0].chainId).toBe(1);
      expect(stats.entries[0].age).toBeGreaterThanOrEqual(0);
      expect(stats.entries[0].ttl).toBeGreaterThan(0);
    }, 30000);
  });

  describe('warmUpCache', () => {
    it('should warm up cache for multiple chains', async () => {
      await service.warmUpCache([1, 56, 137]);

      const stats = service.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    }, 60000);
  });
});
