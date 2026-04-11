import { Test, TestingModule } from '@nestjs/testing';
import { QuoteService } from './quote.service';
import { AggregatorManagerService } from '../aggregation/aggregator-manager.service';
import { AggregatorType } from '@swap/models/swap-request.model';

describe('QuoteService', () => {
  let service: QuoteService;
  let aggregatorManager: AggregatorManagerService;

  const mockAggregatorManager = {
    getQuote: jest.fn(),
    getPrice: jest.fn(),
    getSupportedAggregators: jest.fn(),
    isAggregatorSupported: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuoteService,
        {
          provide: AggregatorManagerService,
          useValue: mockAggregatorManager,
        },
      ],
    }).compile();

    service = module.get<QuoteService>(QuoteService);
    aggregatorManager = module.get<AggregatorManagerService>(
      AggregatorManagerService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getQuote', () => {
    it('should get quote from aggregator manager', async () => {
      const mockQuote = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      mockAggregatorManager.getQuote.mockResolvedValue(mockQuote);

      const result = await service.getQuote(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result).toEqual(mockQuote);
      expect(mockAggregatorManager.getQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
          sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          sellAmount: '1000000000000000000',
          taker: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
          recipient: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        }),
        undefined,
      );
    });

    it('should throw error for invalid inputs', async () => {
      await expect(
        service.getQuote(
          1,
          'invalid-address',
          '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          '1000000000000000000',
          '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        ),
      ).rejects.toThrow('Invalid token address format');
    });

    it('should throw error for same sell and buy token', async () => {
      await expect(
        service.getQuote(
          1,
          '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          '1000000000000000000',
          '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        ),
      ).rejects.toThrow('Sell token and buy token cannot be the same');
    });
  });

  describe('getSupportedAggregators', () => {
    it('should return supported aggregators', () => {
      const supportedAggregators = [AggregatorType.ZEROX];
      mockAggregatorManager.getSupportedAggregators.mockReturnValue(
        supportedAggregators,
      );

      const result = service.getSupportedAggregators(1);

      expect(result).toEqual(supportedAggregators);
      expect(
        mockAggregatorManager.getSupportedAggregators,
      ).toHaveBeenCalledWith(1);
    });
  });

  describe('isAggregatorSupported', () => {
    it('should check if aggregator is supported', () => {
      mockAggregatorManager.isAggregatorSupported.mockReturnValue(true);

      const result = service.isAggregatorSupported(1, AggregatorType.ZEROX);

      expect(result).toBe(true);
      expect(mockAggregatorManager.isAggregatorSupported).toHaveBeenCalledWith(
        1,
        AggregatorType.ZEROX,
      );
    });
  });

  describe('getMultipleQuotes', () => {
    it('should get quotes from all supported aggregators', async () => {
      const mockQuote0x = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      const mockQuoteOdos = {
        ...mockQuote0x,
        buyAmount: '2100000000000000000', // Better quote from Odos
        aggregator: AggregatorType.ODOS,
      };

      // Mock supported aggregators
      mockAggregatorManager.getSupportedAggregators.mockReturnValue([
        AggregatorType.ZEROX,
        AggregatorType.ODOS,
      ]);

      // Mock getQuote to return different quotes for different aggregators
      mockAggregatorManager.getQuote
        .mockResolvedValueOnce(mockQuote0x)
        .mockResolvedValueOnce(mockQuoteOdos);

      // Mock the individual getQuote calls
      jest
        .spyOn(service, 'getQuote')
        .mockResolvedValueOnce(mockQuote0x)
        .mockResolvedValueOnce(mockQuoteOdos);

      const result = await service.getMultipleQuotes(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        aggregator: AggregatorType.ZEROX,
        quote: mockQuote0x,
      });
      expect(result[1]).toEqual({
        aggregator: AggregatorType.ODOS,
        quote: mockQuoteOdos,
      });
    });

    it('should handle partial failures and return successful quotes', async () => {
      const mockQuote0x = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      // Mock supported aggregators
      mockAggregatorManager.getSupportedAggregators.mockReturnValue([
        AggregatorType.ZEROX,
        AggregatorType.ODOS,
      ]);

      // Mock getQuote - one succeeds, one fails
      jest
        .spyOn(service, 'getQuote')
        .mockResolvedValueOnce(mockQuote0x)
        .mockRejectedValueOnce(new Error('Odos API error'));

      const result = await service.getMultipleQuotes(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        aggregator: AggregatorType.ZEROX,
        quote: mockQuote0x,
      });
    });

    it('should throw error when no quotes are available', async () => {
      mockAggregatorManager.getSupportedAggregators.mockReturnValue([
        AggregatorType.ZEROX,
        AggregatorType.ODOS,
      ]);

      // Mock both aggregators failing
      jest
        .spyOn(service, 'getQuote')
        .mockRejectedValueOnce(new Error('0x API error'))
        .mockRejectedValueOnce(new Error('Odos API error'));

      await expect(
        service.getMultipleQuotes(
          1,
          '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
          '1000000000000000000',
          '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        ),
      ).rejects.toThrow('Failed to get quotes from any aggregator');
    });
  });

  describe('getBestQuote', () => {
    it('should return quote with highest buyAmount', async () => {
      const mockQuote0x = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      const mockQuoteOdos = {
        ...mockQuote0x,
        buyAmount: '2100000000000000000', // Better quote
        aggregator: AggregatorType.ODOS,
      };

      const mockQuotes = [
        { aggregator: AggregatorType.ZEROX, quote: mockQuote0x },
        { aggregator: AggregatorType.ODOS, quote: mockQuoteOdos },
      ];

      jest.spyOn(service, 'getMultipleQuotes').mockResolvedValue(mockQuotes);

      const result = await service.getBestQuote(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result).toEqual({
        aggregator: AggregatorType.ODOS,
        quote: mockQuoteOdos,
      });
    });
  });

  describe('compareQuotes', () => {
    it('should compare quotes and return price difference', async () => {
      const mockQuote0x = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      const mockQuoteOdos = {
        ...mockQuote0x,
        buyAmount: '2100000000000000000', // 5% better
        aggregator: AggregatorType.ODOS,
      };

      const mockQuotes = [
        { aggregator: AggregatorType.ZEROX, quote: mockQuote0x },
        { aggregator: AggregatorType.ODOS, quote: mockQuoteOdos },
      ];

      jest.spyOn(service, 'getMultipleQuotes').mockResolvedValue(mockQuotes);

      const result = await service.compareQuotes(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result.quotes).toEqual(mockQuotes);
      expect(result.bestAggregator).toBe(AggregatorType.ODOS);
      expect(result.priceDifference).toBe('5.00'); // 5% difference
    });

    it('should handle single quote comparison', async () => {
      const mockQuote0x = {
        sellToken: '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        buyToken: '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000',
        minBuyAmount: '1900000000000000000',
        gas: '200000',
        gasPrice: '20000000000',
        to: '0xC0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        data: '0x1234567890abcdef',
        value: '0',
        allowanceTarget: '0xD0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        aggregator: AggregatorType.ZEROX,
        priceImpact: '0.1',
        estimatedGas: '200000',
      };

      const mockQuotes = [
        { aggregator: AggregatorType.ZEROX, quote: mockQuote0x },
      ];

      jest.spyOn(service, 'getMultipleQuotes').mockResolvedValue(mockQuotes);

      const result = await service.compareQuotes(
        1,
        '0xA0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '0xB0b86a33E6441b8c4C8C0e1c7B4b4b4b4b4b4b4b',
        '1000000000000000000',
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
      );

      expect(result.quotes).toEqual(mockQuotes);
      expect(result.bestAggregator).toBe(AggregatorType.ZEROX);
      expect(result.priceDifference).toBe('0');
    });
  });
});
