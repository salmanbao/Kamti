import { Test, TestingModule } from '@nestjs/testing';
import { RpcFallbackService } from './rpc-fallback.service';

describe('RpcFallbackService', () => {
  let service: RpcFallbackService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RpcFallbackService],
    }).compile();

    service = module.get<RpcFallbackService>(RpcFallbackService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBestUrl', () => {
    it('should return the first URL from a single URL', () => {
      const url = 'https://eth.llamarpc.com';
      const result = service.getBestUrl(url);
      expect(result).toBe(url);
    });

    it('should return the first URL from multiple URLs', () => {
      const urls = ['https://eth.llamarpc.com', 'https://eth.drpc.org'];
      const result = service.getBestUrl(urls);
      expect(result).toBe(urls[0]);
    });

    it('should throw error for empty URL array', () => {
      expect(() => service.getBestUrl([])).toThrow('No RPC URLs provided');
    });
  });

  describe('getUrlHealth', () => {
    it('should return null for unknown URL', () => {
      const health = service.getUrlHealth('https://unknown.com');
      expect(health).toBeNull();
    });

    it('should return health after URL initialization', () => {
      const url = 'https://eth.llamarpc.com';
      service.getBestUrl(url); // This initializes the URL

      const health = service.getUrlHealth(url);
      expect(health).toBeDefined();
      expect(health?.url).toBe(url);
      expect(health?.isHealthy).toBe(true);
      expect(health?.successCount).toBe(0);
      expect(health?.failureCount).toBe(0);
    });
  });

  describe('setUrlHealth', () => {
    it('should manually set URL health status', () => {
      const url = 'https://eth.llamarpc.com';
      service.getBestUrl(url); // Initialize

      service.setUrlHealth(url, false);
      const health = service.getUrlHealth(url);
      expect(health?.isHealthy).toBe(false);

      service.setUrlHealth(url, true);
      const healthAfter = service.getUrlHealth(url);
      expect(healthAfter?.isHealthy).toBe(true);
    });
  });

  describe('resetUrlHealth', () => {
    it('should reset health tracking for a URL', () => {
      const url = 'https://eth.llamarpc.com';
      service.getBestUrl(url);
      service.setUrlHealth(url, false);

      service.resetUrlHealth(url);
      const health = service.getUrlHealth(url);
      expect(health?.isHealthy).toBe(true);
      expect(health?.consecutiveFailures).toBe(0);
    });
  });

  describe('getStatistics', () => {
    it('should return correct statistics for no URLs', () => {
      const stats = service.getStatistics();
      expect(stats.totalUrls).toBe(0);
      expect(stats.healthyUrls).toBe(0);
      expect(stats.unhealthyUrls).toBe(0);
      expect(stats.totalRequests).toBe(0);
      expect(stats.averageSuccessRate).toBe(0);
    });

    it('should return correct statistics after initializing URLs', () => {
      const urls = ['https://eth1.com', 'https://eth2.com', 'https://eth3.com'];
      urls.forEach((url) => service.getBestUrl(url));

      const stats = service.getStatistics();
      expect(stats.totalUrls).toBe(3);
      expect(stats.healthyUrls).toBe(3);
      expect(stats.unhealthyUrls).toBe(0);
    });
  });

  describe('getAllUrlHealth', () => {
    it('should return empty map initially', () => {
      const allHealth = service.getAllUrlHealth();
      expect(allHealth.size).toBe(0);
    });

    it('should return all tracked URLs', () => {
      const urls = ['https://eth1.com', 'https://eth2.com'];
      urls.forEach((url) => service.getBestUrl(url));

      const allHealth = service.getAllUrlHealth();
      expect(allHealth.size).toBe(2);
      expect(Array.from(allHealth.keys())).toEqual(urls);
    });
  });

  describe('resetAllHealth', () => {
    it('should reset all URL health tracking', () => {
      const urls = ['https://eth1.com', 'https://eth2.com'];
      urls.forEach((url) => {
        service.getBestUrl(url);
        service.setUrlHealth(url, false);
      });

      service.resetAllHealth();

      urls.forEach((url) => {
        const health = service.getUrlHealth(url);
        expect(health?.isHealthy).toBe(true);
        expect(health?.consecutiveFailures).toBe(0);
      });
    });
  });

  describe('logHealthStatus', () => {
    it('should not throw when logging health status', () => {
      const urls = ['https://eth1.com', 'https://eth2.com'];
      urls.forEach((url) => service.getBestUrl(url));

      expect(() => service.logHealthStatus()).not.toThrow();
    });
  });
});
