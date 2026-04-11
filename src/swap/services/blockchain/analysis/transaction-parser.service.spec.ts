import { Test, TestingModule } from '@nestjs/testing';
import { TransactionParserService } from './transaction-parser.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// Mock @0x/0x-parser
jest.mock('@0x/0x-parser', () => ({
  parseSwap: jest.fn(),
}));

// Mock Viem
jest.mock('viem', () => ({
  createPublicClient: jest.fn().mockReturnValue({
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
    readContract: jest.fn(),
  }),
  http: jest.fn(),
  formatUnits: jest.fn((value, decimals) => `${value} (${decimals} decimals)`),
  isAddress: jest.fn(
    (address) => address && address.startsWith('0x') && address.length === 42,
  ),
  mainnet: {},
  polygon: {},
  bsc: {},
  arbitrum: {},
  optimism: {},
  base: {},
  avalanche: {},
}));

// Mock chain utils
jest.mock('../../shared/utils/chain.utils', () => ({
  CHAIN_CONFIGS: {
    1: { rpcUrl: 'https://eth-mainnet.rpc.com' },
    137: { rpcUrl: 'https://polygon-mainnet.rpc.com' },
  },
}));

describe('TransactionParserService', () => {
  let service: TransactionParserService;
  let mockPublicClient: any;
  let mockParseSwap: jest.Mock;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TransactionParserService],
    }).compile();

    service = module.get<TransactionParserService>(TransactionParserService);

    // Reset mocks
    jest.clearAllMocks();

    const { createPublicClient } = require('viem');
    const { parseSwap } = require('@0x/0x-parser');
    mockPublicClient = createPublicClient();
    mockParseSwap = parseSwap as jest.Mock;
  });

  describe('parseTransaction', () => {
    it('should throw BadRequestException for invalid transaction hash', async () => {
      const request = {
        transactionHash: 'invalid-hash',
        chainId: 1,
      };

      await expect(service.parseTransaction(request)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when transaction is not found', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        chainId: 1,
      };

      mockPublicClient.getTransaction.mockResolvedValue(null);

      await expect(service.parseTransaction(request)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should successfully parse a basic transaction', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        chainId: 1,
      };

      const mockTransaction = {
        hash: request.transactionHash,
        blockNumber: 18500000n,
        from: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
        to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
        value: 1000000000000000000n,
        gasPrice: 20000000000n,
        input: '0x',
      };

      const mockReceipt = {
        status: 'success' as const,
        gasUsed: 150000n,
      };

      mockPublicClient.getTransaction.mockResolvedValue(mockTransaction);
      mockPublicClient.getTransactionReceipt.mockResolvedValue(mockReceipt);

      const result = await service.parseTransaction(request);

      expect(result).toEqual({
        transactionHash: request.transactionHash,
        chainId: 1,
        blockNumber: 18500000,
        status: 'success',
        gasUsed: '150000',
        gasPrice: '20000000000',
        from: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
        to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
        value: '1000000000000000000',
      });
    });

    it('should parse a swap transaction with 0x parser', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        chainId: 1,
      };

      const mockTransaction = {
        hash: request.transactionHash,
        blockNumber: 18500000n,
        from: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
        to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
        value: 0n,
        gasPrice: 20000000000n,
        input: '0x415565b0000000000000000000000000', // transformERC20 selector
      };

      const mockReceipt = {
        status: 'success' as const,
        gasUsed: 150000n,
      };

      const mockSwapData = {
        tokenIn: {
          symbol: 'USDC',
          amount: '100.000000',
          address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        },
        tokenOut: {
          symbol: 'WETH',
          amount: '0.025',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        },
      };

      mockPublicClient.getTransaction.mockResolvedValue(mockTransaction);
      mockPublicClient.getTransactionReceipt.mockResolvedValue(mockReceipt);
      mockParseSwap.mockResolvedValue(mockSwapData);

      const result = await service.parseTransaction(request);

      expect(mockParseSwap).toHaveBeenCalledWith({
        publicClient: expect.any(Object),
        transactionHash: request.transactionHash,
      });

      expect(result.swapData).toBeDefined();
      expect(result.swapData?.inputToken.symbol).toBe('USDC');
      expect(result.swapData?.outputToken.symbol).toBe('WETH');
      expect(result.swapData?.protocol).toBe('0x Protocol');
      expect(result.swapData?.source).toBe('0x-parser');
      expect(result.rawParsedData).toEqual(mockSwapData);
    });

    it('should fallback to basic parsing when 0x parser fails', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        chainId: 1,
      };

      const mockTransaction = {
        hash: request.transactionHash,
        blockNumber: 18500000n,
        from: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
        to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
        value: 0n,
        gasPrice: 20000000000n,
        input: '0x415565b0000000000000000000000000', // transformERC20 selector
      };

      const mockReceipt = {
        status: 'success' as const,
        gasUsed: 150000n,
      };

      mockPublicClient.getTransaction.mockResolvedValue(mockTransaction);
      mockPublicClient.getTransactionReceipt.mockResolvedValue(mockReceipt);
      mockParseSwap.mockRejectedValue(new Error('0x parser failed'));

      const result = await service.parseTransaction(request);

      expect(result.rawParsedData).toBeDefined();
      expect(result.rawParsedData.functionName).toBe('transformERC20');
      expect(result.swapData).toBeDefined();
      expect(result.swapData?.protocol).toBe('0x Protocol');
    });

    it('should default to Ethereum mainnet when no chainId provided', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const mockTransaction = {
        hash: request.transactionHash,
        blockNumber: 18500000n,
        from: '0x742d35Cc6635C0532925a3b8D5c34ac8D8C8b65E',
        to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
        value: 0n,
        gasPrice: 20000000000n,
        input: '0x',
      };

      const mockReceipt = {
        status: 'success' as const,
        gasUsed: 150000n,
      };

      mockPublicClient.getTransaction.mockResolvedValue(mockTransaction);
      mockPublicClient.getTransactionReceipt.mockResolvedValue(mockReceipt);

      const result = await service.parseTransaction(request);

      expect(result.chainId).toBe(1); // Should default to Ethereum mainnet
    });

    it('should handle unsupported chain ID', async () => {
      const request = {
        transactionHash:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        chainId: 999999, // Unsupported chain
      };

      await expect(service.parseTransaction(request)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
