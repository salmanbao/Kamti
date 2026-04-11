import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { GasReserveTrackerService } from '@swap/services/core/gas-reserve-tracker.service';
import { SkipTokenValidation } from '../../core/guards/token-validation.guard';
import type {
  UnifiedTokenConfig,
  UnifiedChainConfig,
} from '@shared/config/unified-token-configuration.config';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';
import { SwapValidationRequestDto } from '@swap/dto/swap-validation-request.dto';

/**
 * Unified Admin Configuration Controller
 * Provides administrative APIs for managing unified token and chain configurations
 *
 * Features:
 * - Chain management (enable/disable, view details)
 * - Token management (enable/disable per chain, view deployments)
 * - Hierarchical validation management
 * - Configuration statistics and health
 */
@Controller('admin/config')
@SkipTokenValidation() // Skip token validation for admin endpoints
export class AdminConfigurationController {
  constructor(
    private readonly unifiedConfigService: UnifiedConfigurationService,
    private readonly winstonLogger: WinstonLoggerService,
    private readonly gasReserveTracker: GasReserveTrackerService,
  ) {
    this.winstonLogger.setContext('AdminConfigurationController');
  }

  // ==================== CHAIN MANAGEMENT ====================

  /**
   * Get all chain configurations
   */
  @Get('chains')
  @HttpCode(HttpStatus.OK)
  getAllChains(
    @Query('enabled') enabled?: string,
    @Query('ecosystem') ecosystem?: BlockchainEcosystem,
  ) {
    try {
      let chains: UnifiedChainConfig[];

      if (enabled === 'true') {
        chains = this.unifiedConfigService.getEnabledChains();
      } else if (enabled === 'false') {
        chains = this.unifiedConfigService
          .getAllChains()
          .filter((chain) => !chain.isEnabled);
      } else {
        chains = this.unifiedConfigService.getAllChains();
      }

      if (ecosystem) {
        chains = chains.filter((chain) => chain.ecosystem === ecosystem);
      }

      this.winstonLogger.debug(
        `Fetching chain configurations: enabled=${enabled}, ecosystem=${ecosystem}, total=${chains.length}`,
      );

      return {
        success: true,
        data: {
          chains,
          total: chains.length,
          enabledCount: chains.filter((c) => c.isEnabled).length,
          ecosystems: [...new Set(chains.map((c) => c.ecosystem))],
        },
        message: 'Chain configurations retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get chains: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get specific chain configuration
   */
  @Get('chains/:chainId')
  @HttpCode(HttpStatus.OK)
  getChain(@Param('chainId') chainId: string) {
    try {
      const chainConfig =
        this.unifiedConfigService.getChainConfiguration(chainId);

      if (!chainConfig) {
        return {
          success: false,
          error: 'ChainNotFound',
          message: `Chain ${chainId} not found`,
          availableChains: this.unifiedConfigService
            .getEnabledChains()
            .map((c) => c.chainId),
        };
      }

      const validation =
        this.unifiedConfigService.validateChainSupport(chainId);

      return {
        success: true,
        data: {
          chainConfig,
          validation,
          supportedTokens: this.unifiedConfigService.getTokensForChain(chainId),
        },
        message: 'Chain configuration retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Enable or disable a chain
   */
  @Put('chains/:chainId/status')
  @HttpCode(HttpStatus.OK)
  toggleChainStatus(
    @Param('chainId') chainId: string,
    @Body('enabled') enabled: boolean,
    @Query('adminId') adminId?: string,
  ) {
    this.winstonLogger.audit('ADMIN_CHAIN_STATUS_CHANGE', {
      action: enabled ? 'enable' : 'disable',
      chainId,
      adminId,
      timestamp: new Date().toISOString(),
    });

    try {
      const success = this.unifiedConfigService.setChainStatus(
        chainId,
        enabled,
        adminId,
      );

      if (!success) {
        this.winstonLogger.warn(
          `Chain status change failed: Chain ${chainId} not found`,
        );
        return {
          success: false,
          error: 'ChainNotFound',
          message: `Chain ${chainId} not found or operation failed`,
        };
      }

      this.winstonLogger.audit('ADMIN_CHAIN_STATUS_CHANGE_SUCCESS', {
        chainId,
        enabled,
        adminId,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        data: {
          chainId,
          enabled,
          adminId,
          timestamp: new Date().toISOString(),
        },
        message: `Chain ${chainId} ${enabled ? 'enabled' : 'disabled'} successfully`,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to toggle chain ${chainId} status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ==================== TOKEN MANAGEMENT ====================

  /**
   * Get all tokens
   */
  @Get('tokens')
  @HttpCode(HttpStatus.OK)
  getAllTokens(
    @Query('enabled') enabled?: string,
    @Query('chainId') chainId?: string,
  ) {
    try {
      let tokens: UnifiedTokenConfig[];

      // If chainId is provided, get tokens for that specific chain
      if (chainId) {
        tokens = this.unifiedConfigService.getTokensForChain(chainId);

        // Filter by enabled status if specified
        if (enabled === 'true') {
          tokens = tokens.filter((token) => {
            const deployment = token.chainDeployments[chainId];
            return deployment && deployment.isEnabled;
          });
        } else if (enabled === 'false') {
          tokens = tokens.filter((token) => {
            const deployment = token.chainDeployments[chainId];
            return deployment && !deployment.isEnabled;
          });
        }

        // Filter chainDeployments to only include the requested chain
        tokens = tokens.map((token) => ({
          ...token,
          chainDeployments: {
            [chainId]: token.chainDeployments[chainId],
          },
        }));

        return {
          success: true,
          data: {
            chainId: parseInt(chainId, 10),
            tokens,
            total: tokens.length,
            enabledCount: tokens.filter((token) => {
              const deployment = token.chainDeployments[chainId];
              return deployment && deployment.isEnabled;
            }).length,
          },
          message: `Tokens for chain ${chainId} retrieved successfully`,
        };
      }

      // No chainId - return all tokens
      if (enabled === 'true') {
        tokens = this.unifiedConfigService.getEnabledTokens();
      } else {
        tokens = this.unifiedConfigService.getAllTokens();
      }

      return {
        success: true,
        data: {
          tokens,
          total: tokens.length,
          enabledCount: tokens.filter((t) => t.isEnabled).length,
          totalDeployments: tokens.reduce(
            (sum, token) => sum + Object.keys(token.chainDeployments).length,
            0,
          ),
        },
        message: 'Token configurations retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get tokens: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get all tokens for a specific chain
   */
  @Get('chains/:chainId/tokens')
  @HttpCode(HttpStatus.OK)
  getChainTokens(
    @Param('chainId') chainId: string,
    @Query('enabled') enabled?: string,
  ) {
    try {
      const chainConfig =
        this.unifiedConfigService.getChainConfiguration(chainId);

      if (!chainConfig) {
        return {
          success: false,
          error: 'ChainNotFound',
          message: `Chain ${chainId} not found`,
        };
      }

      let tokens = this.unifiedConfigService.getTokensForChain(chainId);

      if (enabled === 'true') {
        tokens = tokens.filter((token) => {
          const deployment = token.chainDeployments[chainId];
          return deployment && deployment.isEnabled;
        });
      } else if (enabled === 'false') {
        tokens = tokens.filter((token) => {
          const deployment = token.chainDeployments[chainId];
          return deployment && !deployment.isEnabled;
        });
      }

      return {
        success: true,
        data: {
          chainId: chainConfig.chainId,
          chainName: chainConfig.name,
          nativeCurrency: chainConfig.nativeCurrency,
          tokens,
          total: tokens.length,
          enabledCount: tokens.filter((token) => {
            const deployment = token.chainDeployments[chainId];
            return deployment && deployment.isEnabled;
          }).length,
        },
        message: `Tokens for chain ${chainId} retrieved successfully`,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get tokens for chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get specific token configuration
   */
  @Get('tokens/:symbol')
  @HttpCode(HttpStatus.OK)
  getToken(@Param('symbol') symbol: string) {
    try {
      const tokenConfig =
        this.unifiedConfigService.getTokenConfiguration(symbol);

      if (!tokenConfig) {
        return {
          success: false,
          error: 'TokenNotFound',
          message: `Token ${symbol} not found`,
          availableTokens: this.unifiedConfigService
            .getEnabledTokens()
            .map((t) => t.symbol),
        };
      }

      return {
        success: true,
        data: {
          tokenConfig,
          deploymentCount: Object.keys(tokenConfig.chainDeployments).length,
          enabledDeployments: Object.entries(
            tokenConfig.chainDeployments,
          ).filter(([_, deployment]) => deployment.isEnabled).length,
        },
        message: 'Token configuration retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get token ${symbol}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Enable or disable a token globally
   */
  @Put('tokens/:symbol/status')
  @HttpCode(HttpStatus.OK)
  toggleTokenStatus(
    @Param('symbol') symbol: string,
    @Body('enabled') enabled: boolean,
    @Query('adminId') adminId?: string,
  ) {
    this.winstonLogger.audit('ADMIN_TOKEN_STATUS_CHANGE', {
      action: enabled ? 'enable' : 'disable',
      symbol,
      scope: 'global',
      adminId,
      timestamp: new Date().toISOString(),
    });

    try {
      const success = this.unifiedConfigService.setTokenStatus(
        symbol,
        enabled,
        adminId,
      );

      if (!success) {
        this.winstonLogger.warn(
          `Token status change failed: Token ${symbol} not found`,
        );
        return {
          success: false,
          error: 'TokenNotFound',
          message: `Token ${symbol} not found or operation failed`,
        };
      }

      this.winstonLogger.audit('ADMIN_TOKEN_STATUS_CHANGE_SUCCESS', {
        symbol,
        enabled,
        scope: 'global',
        adminId,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        data: {
          symbol,
          enabled,
          adminId,
          timestamp: new Date().toISOString(),
        },
        message: `Token ${symbol} ${enabled ? 'enabled' : 'disabled'} globally`,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to toggle token ${symbol} status: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Enable or disable a token on a specific chain
   */
  @Put('chains/:chainId/tokens/:symbol/status')
  @HttpCode(HttpStatus.OK)
  toggleTokenOnChain(
    @Param('chainId') chainId: string,
    @Param('symbol') symbol: string,
    @Body('enabled') enabled: boolean,
    @Query('adminId') adminId?: string,
  ) {
    this.winstonLogger.audit('ADMIN_TOKEN_STATUS_CHANGE', {
      action: enabled ? 'enable' : 'disable',
      symbol,
      chainId,
      scope: 'chain-specific',
      adminId,
      timestamp: new Date().toISOString(),
    });

    try {
      const success = this.unifiedConfigService.setTokenStatusOnChain(
        symbol,
        chainId,
        enabled,
        adminId,
      );

      if (!success) {
        this.winstonLogger.warn(
          `Token status change failed: Token ${symbol} not found on chain ${chainId}`,
        );
        return {
          success: false,
          error: 'TokenOrChainNotFound',
          message: `Token ${symbol} not found on chain ${chainId} or operation failed`,
        };
      }

      this.winstonLogger.audit('ADMIN_TOKEN_STATUS_CHANGE_SUCCESS', {
        chainId,
        symbol,
        enabled,
        scope: 'chain-specific',
        adminId,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        data: {
          chainId,
          symbol,
          enabled,
          adminId,
          timestamp: new Date().toISOString(),
        },
        message: `Token ${symbol} ${enabled ? 'enabled' : 'disabled'} on chain ${chainId}`,
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to toggle token ${symbol} on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ==================== VALIDATION & HEALTH ====================

  /**
   * Validate hierarchical swap request
   */
  @Post('validate/swap')
  @HttpCode(HttpStatus.OK)
  validateSwapRequest(@Body() swapRequest: SwapValidationRequestDto) {
    try {
      const { fromChain, fromToken, toChain, toToken } = swapRequest;

      const validation = this.unifiedConfigService.validateHierarchicalSwap(
        fromChain,
        fromToken,
        toChain,
        toToken,
      );

      return {
        success: validation.isValid,
        data: {
          validation,
          fromChainConfig:
            this.unifiedConfigService.getChainConfiguration(fromChain),
          toChainConfig:
            this.unifiedConfigService.getChainConfiguration(toChain),
          fromTokenConfig:
            this.unifiedConfigService.getTokenConfiguration(fromToken),
          toTokenConfig:
            this.unifiedConfigService.getTokenConfiguration(toToken),
        },
        message: validation.isValid
          ? 'Swap request validation successful'
          : 'Swap request validation failed',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to validate swap request: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get configuration statistics and health
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  getConfigurationHealth() {
    try {
      const allChains = this.unifiedConfigService.getAllChains();
      const allTokens = this.unifiedConfigService.getAllTokens();
      const enabledChains = this.unifiedConfigService.getEnabledChains();
      const enabledTokens = this.unifiedConfigService.getEnabledTokens();

      const statistics = {
        chains: {
          total: allChains.length,
          enabled: enabledChains.length,
          disabled: allChains.length - enabledChains.length,
          ecosystems: [...new Set(allChains.map((c) => c.ecosystem))],
        },
        tokens: {
          total: allTokens.length,
          enabled: enabledTokens.length,
          disabled: allTokens.length - enabledTokens.length,
          totalDeployments: allTokens.reduce(
            (sum, token) => sum + Object.keys(token.chainDeployments).length,
            0,
          ),
          enabledDeployments: allTokens.reduce(
            (sum, token) =>
              sum +
              Object.values(token.chainDeployments).filter(
                (deployment) => deployment.isEnabled,
              ).length,
            0,
          ),
        },
        coverage: {
          averageTokensPerChain:
            enabledChains.length > 0
              ? (
                  enabledTokens.reduce(
                    (sum, token) =>
                      sum +
                      Object.values(token.chainDeployments).filter(
                        (deployment) => deployment.isEnabled,
                      ).length,
                    0,
                  ) / enabledChains.length
                ).toFixed(2)
              : '0',
          chainsCovered: enabledChains.length,
          maxPossiblePairs: enabledChains.length * enabledTokens.length,
        },
      };

      return {
        success: true,
        data: {
          health: 'healthy',
          statistics,
          timestamp: new Date().toISOString(),
        },
        message: 'Configuration health retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get configuration health: ${error.message}`,
        error.stack,
      );

      return {
        success: false,
        data: {
          health: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString(),
        },
        message: 'Configuration health check failed',
      };
    }
  }

  /**
   * Get detailed configuration overview
   */
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  getConfigurationOverview() {
    try {
      const enabledChains = this.unifiedConfigService.getEnabledChains();
      const enabledTokens = this.unifiedConfigService.getEnabledTokens();

      const overview = {
        summary: {
          enabledChains: enabledChains.length,
          enabledTokens: enabledTokens.length,
          possibleSwapPairs: enabledChains.length * enabledTokens.length,
        },
        chains: enabledChains.map((chain) => ({
          chainId: chain.chainId,
          name: chain.name,
          ecosystem: chain.ecosystem,
          nativeCurrency: chain.nativeCurrency,
          supportedTokens: this.unifiedConfigService
            .getTokensForChain(chain.chainId.toString())
            .filter((token) => {
              const deployment =
                token.chainDeployments[chain.chainId.toString()];
              return deployment && deployment.isEnabled;
            }).length,
        })),
        tokens: enabledTokens.map((token) => ({
          symbol: token.symbol,
          name: token.name,
          deployments: Object.entries(token.chainDeployments)
            .filter(([_, deployment]) => deployment.isEnabled)
            .map(([chainId, deployment]) => ({
              chainId,
              address: deployment.address,
              decimals: deployment.decimals,
            })),
        })),
      };

      return {
        success: true,
        data: overview,
        message: 'Configuration overview retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get configuration overview: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Refresh configuration cache
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refreshConfiguration(@Query('adminId') adminId?: string) {
    try {
      if (!adminId) {
        return {
          success: false,
          error: 'AdminAuthRequired',
          message: 'Admin ID is required for configuration refresh',
        };
      }

      this.winstonLogger.audit('ADMIN_CONFIG_REFRESH', {
        adminId,
        timestamp: new Date().toISOString(),
      });

      // Clear internal caches if any exist
      this.winstonLogger.log(
        `Configuration refresh requested by admin: ${adminId}`,
      );

      return {
        success: true,
        data: {
          refreshedBy: adminId,
          refreshedAt: new Date().toISOString(),
        },
        message: 'Configuration refreshed successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to refresh configuration: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ==================== GAS RESERVE TRACKING ====================

  /**
   * Get adaptive gas reserve statistics for all tracked categories
   */
  @Get('gas-reserve/stats')
  @HttpCode(HttpStatus.OK)
  getGasReserveStats() {
    try {
      const categories = this.gasReserveTracker.getTrackedCategories();

      const statsWithDetails = categories.map((category) => {
        const stats = this.gasReserveTracker.getStatistics(
          category.ecosystem as 'solana' | 'evm' | 'bitcoin',
          category.transactionType as
            | 'simple'
            | 'cross-chain'
            | 'bridge'
            | 'swap',
        );

        return {
          ...category,
          statistics: stats
            ? {
                averageCost: stats.averageCost.toString(),
                maxCost: stats.maxCost.toString(),
                minCost: stats.minCost.toString(),
                p50Cost: stats.p50Cost.toString(),
                p75Cost: stats.p75Cost.toString(),
                p90Cost: stats.p90Cost.toString(),
                p95Cost: stats.p95Cost.toString(),
                successRate: stats.successRate.toFixed(2),
                recentSamples: stats.recentSamples,
                lastUpdated: new Date(stats.lastUpdated).toISOString(),
              }
            : null,
        };
      });

      return {
        success: true,
        data: {
          totalCategories: categories.length,
          categories: statsWithDetails,
          timestamp: new Date().toISOString(),
        },
        message: 'Gas reserve statistics retrieved successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get gas reserve stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get adaptive gas reserve calculation for a specific scenario
   */
  @Post('gas-reserve/calculate')
  @HttpCode(HttpStatus.OK)
  calculateGasReserve(
    @Body()
    body: {
      ecosystem: 'solana' | 'evm' | 'tron' | 'bitcoin';
      transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap';
      balance: string;
      chainId?: number; // Optional chainId for EVM chain-specific reserves
    },
  ) {
    try {
      const balance = BigInt(body.balance);
      const result = this.gasReserveTracker.calculateAdaptiveReserve(
        body.ecosystem,
        body.transactionType,
        balance,
        body.chainId, // Pass chainId if provided
      );

      return {
        success: true,
        data: {
          ecosystem: body.ecosystem,
          transactionType: body.transactionType,
          balance: body.balance,
          calculatedReserve: result.reserve.toString(),
          strategy: result.strategy,
          confidence: result.confidence?.toFixed(4),
          statistics: result.stats
            ? {
                averageCost: result.stats.averageCost.toString(),
                p50Cost: result.stats.p50Cost.toString(),
                p75Cost: result.stats.p75Cost.toString(),
                p90Cost: result.stats.p90Cost.toString(),
                p95Cost: result.stats.p95Cost.toString(),
                maxCost: result.stats.maxCost.toString(),
                samples: result.stats.recentSamples,
                successRate: result.stats.successRate.toFixed(2),
              }
            : null,
          explanation:
            result.strategy === 'adaptive'
              ? `Using P95 cost (${result.stats?.p95Cost.toString()}) + 10% safety buffer based on ${result.stats?.recentSamples} transactions`
              : `Using fallback minimum (insufficient data: need 10 samples, have ${result.stats?.recentSamples || 0})`,
        },
        message: 'Gas reserve calculated successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to calculate gas reserve: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Reset gas reserve tracking data
   */
  @Post('gas-reserve/reset')
  @HttpCode(HttpStatus.OK)
  resetGasReserveTracking(
    @Body() body?: { ecosystem?: string; transactionType?: string },
  ) {
    try {
      this.gasReserveTracker.resetTracking(
        body?.ecosystem,
        body?.transactionType,
      );

      return {
        success: true,
        data: {
          resetScope:
            body?.ecosystem && body?.transactionType
              ? `${body.ecosystem}:${body.transactionType}`
              : 'all categories',
          resetAt: new Date().toISOString(),
        },
        message: 'Gas reserve tracking data reset successfully',
      };
    } catch (error) {
      this.winstonLogger.error(
        `Failed to reset gas reserve tracking: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
