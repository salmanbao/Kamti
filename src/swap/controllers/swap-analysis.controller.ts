import { Controller, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { SwapRoutingService } from '@swap/services/core/swap-routing.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  UniversalSwapRequestDto,
  SwapType,
  BlockchainEcosystem,
  TokenStandard,
} from '@swap/dto/universal-swap-request.dto';

/**
 * Swap Analysis Controller
 * Provides analysis and preview capabilities for the universal swap system
 */
@Controller('swap-analysis')
@ApiTags('Swap Analysis')
export class SwapAnalysisController {
  constructor(
    private readonly swapRoutingService: SwapRoutingService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.winstonLogger.setContext('SwapAnalysisController');
  }

  /**
   * Analyze a potential swap without executing
   */
  @Get('analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Analyze swap characteristics',
    description:
      'Analyze a potential swap to understand routing, complexity, and requirements without executing',
  })
  @ApiQuery({
    name: 'sellChain',
    description: 'Source chain ID or identifier',
    example: '1',
  })
  @ApiQuery({
    name: 'sellEcosystem',
    description: 'Source ecosystem',
    enum: BlockchainEcosystem,
    example: 'evm',
  })
  @ApiQuery({
    name: 'buyChain',
    description: 'Target chain ID or identifier',
    example: '137',
  })
  @ApiQuery({
    name: 'buyEcosystem',
    description: 'Target ecosystem',
    enum: BlockchainEcosystem,
    example: 'evm',
  })
  @ApiQuery({
    name: 'sellTokenSymbol',
    description: 'Sell token symbol',
    example: 'ETH',
  })
  @ApiQuery({
    name: 'buyTokenSymbol',
    description: 'Buy token symbol',
    example: 'USDT',
  })
  @ApiQuery({
    name: 'sellToken',
    description: 'Sell token address (optional)',
    required: false,
    example: '0xA0b86a33E6E2A3E6B3A7E5E5D5C5F5E5E5E5E5E5',
  })
  @ApiQuery({
    name: 'buyToken',
    description: 'Buy token address (optional)',
    required: false,
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  })
  @ApiResponse({
    status: 200,
    description: 'Swap analysis completed',
    schema: {
      type: 'object',
      properties: {
        swapType: { type: 'string', enum: Object.values(SwapType) },
        providerCategory: {
          type: 'string',
          enum: ['evm-aggregators', 'meta', 'solana'],
        },
        complexity: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
            estimatedSteps: { type: 'number' },
            estimatedTime: { type: 'number' },
            recommendedProviders: { type: 'array', items: { type: 'string' } },
          },
        },
        requirements: {
          type: 'object',
          properties: {
            crossChain: { type: 'boolean' },
            bridgeRequired: { type: 'boolean' },
            multipleTransactions: { type: 'boolean' },
            approvalRequired: { type: 'boolean' },
          },
        },
        supportedProviders: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  async analyzeSwap(
    @Query('sellChain') sellChain: string,
    @Query('sellEcosystem') sellEcosystem: BlockchainEcosystem,
    @Query('buyChain') buyChain: string,
    @Query('buyEcosystem') buyEcosystem: BlockchainEcosystem,
    @Query('sellTokenSymbol') sellTokenSymbol: string,
    @Query('buyTokenSymbol') buyTokenSymbol: string,
    @Query('sellToken') sellToken?: string,
    @Query('buyToken') buyToken?: string,
  ) {
    const analysisId = `analysis_${Date.now()}`;

    this.winstonLogger.audit('SWAP_ANALYSIS_REQUEST', {
      analysisId,
      sellChain,
      sellEcosystem,
      buyChain,
      buyEcosystem,
      sellToken: sellTokenSymbol,
      buyToken: buyTokenSymbol,
      timestamp: new Date().toISOString(),
    });

    try {
      // Create a mock request for analysis
      const mockRequest: UniversalSwapRequestDto = {
        sellToken: {
          symbol: sellTokenSymbol,
          address: sellToken,
          standard: sellToken
            ? this.determineTokenStandard(sellEcosystem, sellToken)
            : undefined,
          chain: {
            chainId: this.parseChainId(sellChain),
            ecosystem: sellEcosystem,
          },
        },
        buyToken: {
          symbol: buyTokenSymbol,
          address: buyToken,
          standard: buyToken
            ? this.determineTokenStandard(buyEcosystem, buyToken)
            : undefined,
          chain: {
            chainId: this.parseChainId(buyChain),
            ecosystem: buyEcosystem,
          },
        },
        sellAmount: '1000000000000000000', // 1 token in wei
        taker: '0x0000000000000000000000000000000000000001', // Mock address
      };

      // Analyze the swap
      const swapType = this.swapRoutingService.determineSwapType(mockRequest);
      const providerCategory =
        this.swapRoutingService.determineProviderCategory(
          swapType,
          mockRequest,
        );
      const complexity =
        this.swapRoutingService.estimateSwapComplexity(mockRequest);
      const supportedProviders =
        this.swapRoutingService.getProvidersForCategory(
          providerCategory,
          mockRequest,
        );

      // Determine requirements
      const requirements = {
        crossChain: swapType !== SwapType.ON_CHAIN,
        bridgeRequired: [
          SwapType.CROSS_CHAIN,
          SwapType.L1_TO_L2,
          SwapType.L2_TO_L1,
          SwapType.L2_TO_L2,
        ].includes(swapType),
        multipleTransactions: complexity.estimatedSteps > 1,
        approvalRequired:
          mockRequest.sellToken.standard !== TokenStandard.NATIVE,
      };

      // Generate warnings
      const warnings = this.generateAnalysisWarnings(
        swapType,
        sellEcosystem,
        buyEcosystem,
        complexity,
      );

      const result = {
        swapType,
        providerCategory,
        complexity: {
          level: complexity.complexity,
          estimatedSteps: complexity.estimatedSteps,
          estimatedTime: complexity.estimatedTime,
          recommendedProviders: complexity.recommendedProviders,
        },
        requirements,
        supportedProviders,
        warnings,
      };

      this.winstonLogger.audit('SWAP_ANALYSIS_COMPLETE', {
        analysisId,
        swapType,
        providerCategory,
        complexity: complexity.complexity,
        recommendedProviders: complexity.recommendedProviders,
        supportedProviders,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      this.winstonLogger.error(
        `Swap analysis failed: ${error.message}`,
        error.stack,
        'SwapAnalysisController',
      );
      throw error;
    }
  }

  /**
   * Get supported ecosystems and their characteristics
   */
  @Get('ecosystems')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get supported blockchain ecosystems',
    description:
      'List all supported blockchain ecosystems and their characteristics',
  })
  @ApiResponse({
    status: 200,
    description: 'Supported ecosystems retrieved',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['evm', 'non-evm'] },
          nativeToken: { type: 'string' },
          tokenStandards: { type: 'array', items: { type: 'string' } },
          supportedSwapTypes: { type: 'array', items: { type: 'string' } },
          primaryProviders: { type: 'array', items: { type: 'string' } },
          examples: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  })
  async getSupportedEcosystems() {
    this.winstonLogger.debug('Fetching supported ecosystems');

    return {
      [BlockchainEcosystem.EVM]: {
        name: 'Ethereum Virtual Machine',
        type: 'evm',
        nativeToken: 'ETH (varies by chain)',
        tokenStandards: ['ERC20', 'ERC721', 'ERC1155'],
        supportedSwapTypes: ['on-chain', 'cross-chain', 'l1-to-l2', 'l2-to-l1'],
        primaryProviders: ['0x', 'odos'],
        examples: ['Ethereum', 'Polygon', 'BSC', 'Arbitrum', 'Optimism'],
      },
      [BlockchainEcosystem.SOLANA]: {
        name: 'Solana',
        type: 'non-evm',
        nativeToken: 'SOL',
        tokenStandards: ['SPL'],
        supportedSwapTypes: ['on-chain', 'cross-chain'],
        primaryProviders: ['jupiter', 'orca'],
        examples: ['Solana Mainnet'],
      },
      [BlockchainEcosystem.COSMOS]: {
        name: 'Cosmos Ecosystem',
        type: 'non-evm',
        nativeToken: 'ATOM (varies by chain)',
        tokenStandards: ['IBC', 'native'],
        supportedSwapTypes: ['on-chain', 'cross-chain'],
        primaryProviders: ['osmosis', 'thorchain'],
        examples: ['Cosmos Hub', 'Osmosis', 'Juno'],
      },
      [BlockchainEcosystem.BITCOIN]: {
        name: 'Bitcoin',
        type: 'non-evm',
        nativeToken: 'BTC',
        tokenStandards: ['native', 'ordinals'],
        supportedSwapTypes: ['native-swap'],
        primaryProviders: ['thorchain', 'maya'],
        examples: ['Bitcoin Mainnet'],
      },
      [BlockchainEcosystem.THORCHAIN]: {
        name: 'THORChain',
        type: 'non-evm',
        nativeToken: 'RUNE',
        tokenStandards: ['native'],
        supportedSwapTypes: ['native-swap', 'cross-chain'],
        primaryProviders: ['thorchain'],
        examples: ['THORChain'],
      },
    };
  }

  private parseChainId(chain: string): number | string {
    const numericChain = parseInt(chain, 10);
    return isNaN(numericChain) ? chain : numericChain;
  }

  private determineTokenStandard(
    ecosystem: BlockchainEcosystem,
    tokenAddress: string,
  ): TokenStandard {
    // Check for native token addresses
    if (
      tokenAddress === '0x0000000000000000000000000000000000000000' ||
      tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      tokenAddress === 'native'
    ) {
      return TokenStandard.NATIVE;
    }

    switch (ecosystem) {
      case BlockchainEcosystem.EVM:
        // For BSC, distinguish BEP20 from ERC20
        // This would require chain context, but for now we'll use ERC20 as default
        return TokenStandard.ERC20;

      case BlockchainEcosystem.SOLANA:
        return TokenStandard.SPL;

      case BlockchainEcosystem.COSMOS:
        return TokenStandard.COSMOS_NATIVE;

      case BlockchainEcosystem.BITCOIN:
        return TokenStandard.NATIVE;

      case BlockchainEcosystem.THORCHAIN:
        return TokenStandard.RUNE;

      case BlockchainEcosystem.MAYA:
        return TokenStandard.CACAO;

      // New ecosystems with specific standards
      case BlockchainEcosystem.CARDANO:
        return TokenStandard.CARDANO_NATIVE;

      case BlockchainEcosystem.SUI:
        return TokenStandard.SUI_COIN;

      case BlockchainEcosystem.HEDERA:
        return TokenStandard.HTS;

      case BlockchainEcosystem.TON:
        return TokenStandard.JETTON;

      case BlockchainEcosystem.XRPL:
        return TokenStandard.XRPL_NATIVE;

      case BlockchainEcosystem.SUBSTRATE:
      case BlockchainEcosystem.NEAR:
      case BlockchainEcosystem.TERRA:
        return TokenStandard.NATIVE;

      case BlockchainEcosystem.AVALANCHE:
        // Avalanche C-Chain uses EVM standards
        return TokenStandard.ERC20;

      default:
        return TokenStandard.ERC20; // Default fallback
    }
  }

  /**
   * Enhanced token standard detection with chain context
   */
  private determineTokenStandardWithChain(
    ecosystem: BlockchainEcosystem,
    tokenAddress: string,
    chainId?: number | string,
  ): TokenStandard {
    // Check for native token addresses first
    if (
      tokenAddress === '0x0000000000000000000000000000000000000000' ||
      tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      tokenAddress === 'native'
    ) {
      return TokenStandard.NATIVE;
    }

    // For EVM ecosystem, distinguish between different chains
    if (ecosystem === BlockchainEcosystem.EVM && chainId) {
      if (chainId === 56 || chainId === '56') {
        return TokenStandard.BEP20; // BSC uses BEP20
      }
      return TokenStandard.ERC20; // Other EVM chains use ERC20
    }

    // Fall back to original method
    return this.determineTokenStandard(ecosystem, tokenAddress);
  }

  private generateAnalysisWarnings(
    swapType: SwapType,
    sellEcosystem: BlockchainEcosystem,
    buyEcosystem: BlockchainEcosystem,
    complexity: any,
  ): string[] {
    const warnings: string[] = [];

    if (swapType === SwapType.CROSS_CHAIN) {
      warnings.push(
        'Cross-chain swaps involve bridge risks and longer settlement times',
      );
    }

    if (sellEcosystem !== buyEcosystem) {
      warnings.push(
        'Different ecosystems require specialized routing through meta-aggregators',
      );
    }

    if (complexity.complexity === 'complex') {
      warnings.push(
        'Complex swap route with multiple steps and higher gas costs',
      );
    }

    if (
      sellEcosystem === BlockchainEcosystem.BITCOIN ||
      buyEcosystem === BlockchainEcosystem.BITCOIN
    ) {
      warnings.push(
        'Bitcoin swaps require THORChain/Maya and have longer confirmation times',
      );
    }

    return warnings;
  }
}
