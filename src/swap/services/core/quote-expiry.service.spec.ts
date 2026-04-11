import { Test, TestingModule } from '@nestjs/testing';
import { QuoteExpiryService } from './quote-expiry.service';
import { AggregatorType } from '../../models/swap-request.model';

describe('QuoteExpiryService', () => {
  let service: QuoteExpiryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [QuoteExpiryService],
    }).compile();

    service = module.get<QuoteExpiryService>(QuoteExpiryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkQuoteExpiry', () => {
    it('should detect fresh quote', () => {
      const timestamp = Date.now();
      const status = service.checkQuoteExpiry(timestamp, AggregatorType.ZEROX);

      expect(status.isExpired).toBe(false);
      expect(status.isNearExpiry).toBe(false);
      expect(status.ageSeconds).toBeLessThan(2);
      expect(status.remainingSeconds).toBeGreaterThan(0);
    });

    it('should detect expired quote', () => {
      const timestamp = Date.now() - 120_000; // 2 minutes ago
      const status = service.checkQuoteExpiry(timestamp, AggregatorType.ZEROX);

      expect(status.isExpired).toBe(true);
      expect(status.warning).toContain('EXPIRED');
    });

    it('should detect near-expiry quote', () => {
      const config = service.getExpiryConfig(AggregatorType.ZEROX);
      const timestamp = Date.now() - (config!.expirySeconds - 10) * 1000; // 10s before expiry
      const status = service.checkQuoteExpiry(timestamp, AggregatorType.ZEROX);

      expect(status.isNearExpiry).toBe(true);
      expect(status.warning).toContain('near expiry');
    });

    it('should handle different aggregator configurations', () => {
      const timestamp = Date.now();

      const zeroxStatus = service.checkQuoteExpiry(
        timestamp,
        AggregatorType.ZEROX,
      );
      const odosStatus = service.checkQuoteExpiry(
        timestamp,
        AggregatorType.ODOS,
      );
      const jupiterStatus = service.checkQuoteExpiry(
        timestamp,
        AggregatorType.JUPITER,
      );

      // ODOS should have shorter expiry than 0x
      const zeroxConfig = service.getExpiryConfig(AggregatorType.ZEROX);
      const odosConfig = service.getExpiryConfig(AggregatorType.ODOS);

      expect(odosConfig!.expirySeconds).toBeLessThan(
        zeroxConfig!.expirySeconds,
      );
    });
  });

  describe('validateNotExpired', () => {
    it('should not throw for fresh quote', () => {
      const timestamp = Date.now();

      expect(() => {
        service.validateNotExpired(timestamp, AggregatorType.ZEROX);
      }).not.toThrow();
    });

    it('should throw for expired quote', () => {
      const timestamp = Date.now() - 120_000; // 2 minutes ago

      expect(() => {
        service.validateNotExpired(timestamp, AggregatorType.ZEROX);
      }).toThrow('Quote has expired');
    });
  });

  describe('getRemainingTimePercentage', () => {
    it('should return 100% for brand new quote', () => {
      const timestamp = Date.now();
      const percentage = service.getRemainingTimePercentage(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(percentage).toBeGreaterThanOrEqual(99);
      expect(percentage).toBeLessThanOrEqual(100);
    });

    it('should return 0% for expired quote', () => {
      const timestamp = Date.now() - 120_000;
      const percentage = service.getRemainingTimePercentage(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(percentage).toBe(0);
    });
  });

  describe('shouldRefreshQuote', () => {
    it('should return false for fresh quote', () => {
      const timestamp = Date.now();
      const shouldRefresh = service.shouldRefreshQuote(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(shouldRefresh).toBe(false);
    });

    it('should return true for expired quote', () => {
      const timestamp = Date.now() - 120_000;
      const shouldRefresh = service.shouldRefreshQuote(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(shouldRefresh).toBe(true);
    });

    it('should return true for near-expiry quote', () => {
      const config = service.getExpiryConfig(AggregatorType.ZEROX);
      const timestamp = Date.now() - (config!.expirySeconds - 10) * 1000;
      const shouldRefresh = service.shouldRefreshQuote(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(shouldRefresh).toBe(true);
    });
  });

  describe('getTimeRemainingFormatted', () => {
    it('should format seconds', () => {
      const timestamp = Date.now();
      const formatted = service.getTimeRemainingFormatted(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(formatted).toMatch(/\d+s remaining/);
    });

    it('should format expired time', () => {
      const timestamp = Date.now() - 120_000;
      const formatted = service.getTimeRemainingFormatted(
        timestamp,
        AggregatorType.ZEROX,
      );

      expect(formatted).toMatch(/Expired \d+s ago/);
    });
  });

  describe('checkMultipleQuotes', () => {
    it('should check multiple quotes', () => {
      const quotes = [
        { timestamp: Date.now(), aggregator: AggregatorType.ZEROX },
        { timestamp: Date.now() - 120_000, aggregator: AggregatorType.ODOS },
        { timestamp: Date.now(), aggregator: AggregatorType.JUPITER },
      ];

      const statuses = service.checkMultipleQuotes(quotes);

      expect(statuses).toHaveLength(3);
      expect(statuses[0].isExpired).toBe(false);
      expect(statuses[1].isExpired).toBe(true);
      expect(statuses[2].isExpired).toBe(false);
    });
  });

  describe('getExpiredAggregators', () => {
    it('should identify expired aggregators', () => {
      const quotes = [
        { timestamp: Date.now(), aggregator: AggregatorType.ZEROX },
        { timestamp: Date.now() - 120_000, aggregator: AggregatorType.ODOS },
        { timestamp: Date.now() - 150_000, aggregator: AggregatorType.JUPITER },
      ];

      const expired = service.getExpiredAggregators(quotes);

      expect(expired).toContain(AggregatorType.ODOS);
      expect(expired).toContain(AggregatorType.JUPITER);
      expect(expired).not.toContain(AggregatorType.ZEROX);
    });
  });

  describe('custom configuration', () => {
    it('should allow custom expiry config', () => {
      const customConfig = {
        aggregator: AggregatorType.ZEROX,
        expirySeconds: 120,
        warningThresholdSeconds: 30,
      };

      service.setExpiryConfig(customConfig);
      const retrieved = service.getExpiryConfig(AggregatorType.ZEROX);

      expect(retrieved!.expirySeconds).toBe(120);
      expect(retrieved!.warningThresholdSeconds).toBe(30);
    });
  });
});
