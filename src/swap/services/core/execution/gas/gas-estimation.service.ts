import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { ExecutionContext } from '../ports/swap-executor.interface';
import { RouteQuote } from '@swap/models/ports';
import {
  GAS_ESTIMATION_CONFIG,
  GasEstimationConfig,
} from '@config/swap-config';

/**
 * Gas Estimation Service
 * Handles all gas-related calculations
 *
 * Responsibilities:
 * - Gas limit estimation
 * - Gas price fetching
 * - Gas cost calculation
 * - Conservative gas estimates from routes
 */
@Injectable()
export class GasEstimationService {
  private readonly config: GasEstimationConfig;

  constructor(
    private readonly walletService: WalletService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(GasEstimationService.name);
    // Initialize with default configuration
    this.config = GAS_ESTIMATION_CONFIG;

    this.logger.log('Gas Estimation Service initialized with configuration', {
      maxAbsoluteGasLimit: this.config.maxAbsoluteGasLimit,
      maxReasonableGasPrice: this.config.maxReasonableGasPrice,
      defaultOnChainGasLimit: this.config.defaultGasLimits.onChain,
      defaultBridgeGasLimit: this.config.defaultGasLimits.bridge,
      gasLimitMargin: this.config.margins.gasLimitPercent,
      historicalUsageAdjustment: this.config.margins.historicalUsagePercent,
    });
  }

  /**
   * Estimate transaction cost (gas limit and gas cost)
   */
  async estimateTransactionCost(
    context: ExecutionContext,
    ecosystem: 'evm' | 'solana' | 'tron' = 'evm',
  ): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as any;
    const chainId = this.getChainIdFromRoute(route);
    const userWallet = context.request.userWallet;

    this.logger.log('Estimating transaction cost', {
      chainId,
      userWallet,
      ecosystem,
      aggregator: swapQuote?.aggregator,
    });

    try {
      // Build transaction data for gas estimation
      const tempTxData = {
        to: swapQuote?.to || swapQuote?.toAddress,
        data: swapQuote?.data || swapQuote?.txData,
        value: swapQuote?.value || swapQuote?.sellAmount || '0',
      };

      // Estimate gas limit
      const gasLimit = await this.walletService.estimateGas(
        chainId,
        userWallet,
        tempTxData.to,
        tempTxData.data,
        tempTxData.value,
        ecosystem,
      );

      // Get gas price/fees
      const feeData = await this.walletService.estimateFees(chainId, ecosystem);

      let gasPrice: string;
      if (feeData.type === 'eip1559') {
        // Use maxFeePerGas for EIP-1559
        gasPrice = feeData.maxFeePerGas || '0';
      } else {
        gasPrice = feeData.gasPrice || '0';
      }

      // Add margin to gas limit
      const gasLimitWithMargin = (
        (BigInt(gasLimit) * BigInt(this.config.margins.gasLimitPercent)) /
        BigInt(100)
      ).toString();

      // Calculate full gas cost for balance validation
      // The node validates: balance >= txValue + (gasLimit * maxFeePerGas)
      const fullGasCostForBalance = (
        BigInt(gasLimitWithMargin) * BigInt(gasPrice)
      ).toString();

      // Calculate adjusted cost for actual usage estimation (historical data shows ~76.5% actual usage)
      const baseGasCost = BigInt(gasLimit) * BigInt(gasPrice);
      const adjustedGasCostForUsage = (
        (baseGasCost * BigInt(this.config.margins.historicalUsagePercent)) /
        BigInt(100)
      ).toString();

      this.logger.log('Gas estimation completed', {
        gasLimit,
        gasLimitWithMargin,
        gasPrice,
        fullGasCostForBalance,
        adjustedGasCostForUsage,
      });

      return {
        gasLimit: gasLimitWithMargin,
        gasCost: fullGasCostForBalance,
      };
    } catch (error) {
      this.logger.warn(
        `Gas estimation failed, using conservative estimate: ${error.message}`,
      );
      return await this.getConservativeGasEstimateFromRoute(context);
    }
  }

  /**
   * Get conservative gas estimate from route/quote data
   * Prioritizes provider APIs over route/quote prices
   */
  async getConservativeGasEstimateFromRoute(
    context: ExecutionContext,
  ): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as any;
    const sourceChainId = this.getChainIdFromRoute(route);

    // Detect ecosystem from sourceChainId for correct wallet provider selection
    // This avoids hardcoding 'evm' which breaks Tron/Solana gas estimation
    const ecosystem = this.detectEcosystemFromChainId(sourceChainId);

    // Extract gas limit from route or quote
    const routeGasLimit =
      route.fees?.gas && route.fees.gas !== '0' ? route.fees.gas : undefined;
    const quoteGasLimit = swapQuote?.gas || swapQuote?.estimatedGas;

    // Detect cross-chain/bridge transaction: multiple distinct chainIds in steps
    const isCrossChain = (() => {
      try {
        const ids = new Set((route.steps || []).map((s) => s.chainId));
        return ids.size > 1;
      } catch {
        return false;
      }
    })();

    const defaultGasLimitForContext = isCrossChain
      ? this.config.defaultGasLimits.bridge
      : this.config.defaultGasLimits.onChain;
    let gasLimit: string;

    if (routeGasLimit) {
      const routeGasLimitNum = parseInt(routeGasLimit);
      // CRITICAL: Only reject if it's absurdly high (likely a bug/placeholder)
      // Cross-chain swaps legitimately need 500k-700k gas, so accept those values
      if (routeGasLimitNum > this.config.maxAbsoluteGasLimit) {
        this.logger.warn(
          'Route gas limit exceeds absolute maximum, using conservative default',
          {
            routeGasLimit,
            maxAbsoluteGasLimit: this.config.maxAbsoluteGasLimit,
            fallbackGasLimit: defaultGasLimitForContext,
            note: 'Route gas limit is absurdly high (likely bug/placeholder), using conservative default',
          },
        );
        gasLimit = defaultGasLimitForContext.toString();
      } else {
        // Use route gas limit (even if it's 500k-700k, as cross-chain swaps legitimately need that)
        gasLimit = routeGasLimit;
        this.logger.log('Using route gas limit (within acceptable range)', {
          routeGasLimit,
          note: 'Cross-chain swaps legitimately need 500k-700k gas, accepting route-provided value',
        });
      }
    } else if (quoteGasLimit) {
      const quoteGasLimitNum = parseInt(quoteGasLimit);
      // Only reject if it's absurdly high (likely a bug/placeholder)
      if (quoteGasLimitNum > this.config.maxAbsoluteGasLimit) {
        this.logger.warn(
          'Quote gas limit exceeds absolute maximum, using conservative default',
          {
            quoteGasLimit,
            maxAbsoluteGasLimit: this.config.maxAbsoluteGasLimit,
            fallbackGasLimit: defaultGasLimitForContext,
            note: 'Quote gas limit is absurdly high (likely bug/placeholder), using conservative default',
          },
        );
        gasLimit = defaultGasLimitForContext.toString();
      } else {
        // Use quote gas limit (even if it's 500k-700k, as cross-chain swaps legitimately need that)
        gasLimit = quoteGasLimit;
        this.logger.log('Using quote gas limit (within acceptable range)', {
          quoteGasLimit,
          note: 'Cross-chain swaps legitimately need 500k-700k gas, accepting quote-provided value',
        });
      }
    } else {
      gasLimit = defaultGasLimitForContext.toString();
    }

    // Get gas price - prioritize provider APIs
    let gasPrice: string;

    try {
      // Try to get gas price from provider APIs first
      // CRITICAL: Use the ecosystem parameter passed to this method, not hardcoded 'evm'
      // This ensures Tron/Solana chains use correct wallet providers
      const feeData = await this.walletService.estimateFees(
        sourceChainId,
        ecosystem,
      );

      if (feeData.type === 'eip1559') {
        gasPrice = feeData.maxFeePerGas || '0';
      } else {
        gasPrice = feeData.gasPrice || '0';
      }

      // Validate gas price is reasonable
      if (gasPrice === '0' || BigInt(gasPrice) === 0n) {
        throw new Error('Provider API returned zero gas price');
      }

      this.logger.debug('Using gas price from provider API', {
        gasPrice,
        source: 'provider-api',
      });
    } catch (error) {
      this.logger.debug(
        'Provider API gas price unavailable, checking route/quote',
        {
          error: error.message,
        },
      );

      // Fallback to route/quote gas price
      const routeGasPriceStr = route.fees?.gasPrice?.toString();
      const routeGasPrice =
        routeGasPriceStr &&
        routeGasPriceStr !== '0' &&
        BigInt(routeGasPriceStr) > 0n
          ? routeGasPriceStr
          : undefined;

      const quoteGasPriceStr = swapQuote?.gasPrice?.toString();
      const quoteGasPrice =
        quoteGasPriceStr &&
        quoteGasPriceStr !== '0' &&
        BigInt(quoteGasPriceStr) > 0n
          ? quoteGasPriceStr
          : undefined;

      if (routeGasPrice || quoteGasPrice) {
        const selectedRouteQuotePrice = routeGasPrice || quoteGasPrice!;
        const priceBigInt = BigInt(selectedRouteQuotePrice);

        // Validate against max reasonable gas price
        if (priceBigInt > BigInt(this.config.maxReasonableGasPrice)) {
          this.logger.warn(
            'Route/quote gas price exceeds reasonable limit, using chain default',
            {
              routeGasPrice,
              quoteGasPrice,
              maxReasonableGasPrice:
                this.config.maxReasonableGasPrice.toString(),
              note: 'Gas price likely a placeholder, using chain default',
            },
          );

          // Use chain-specific defaults
          gasPrice = this.getChainDefaultGasPrice(sourceChainId);
        } else {
          gasPrice = selectedRouteQuotePrice;
          this.logger.debug('Using gas price from route/quote', {
            routeGasPrice,
            quoteGasPrice,
            selectedGasPrice: gasPrice,
          });
        }
      } else {
        // No gas price available - use chain-specific defaults
        this.logger.warn(
          'Route/quote gas price is missing or 0, using chain-specific default',
          {
            sourceChainId,
            routeGasPrice,
            quoteGasPrice,
            note: 'Both provider APIs and route/quote gas prices unavailable, using chain default',
          },
        );

        gasPrice = this.getChainDefaultGasPrice(sourceChainId);
      }
    }

    // IMPORTANT: Route/quote gas limits (especially from Rubic) already include provider safety margins.
    // Applying another margin here double-counts and artificially inflates the required balance.
    const gasLimitWithMargin = gasLimit;

    // CRITICAL: Ecosystem-specific gas cost calculation
    // For Tron/Solana: route.fees.gas is already the FINAL cost in atomic units (SUN/lamports)
    // For EVM: route.fees.gas is a gas limit that needs to be multiplied by gasPrice
    let fullGasCostForBalance: string;
    let adjustedGasCostForUsage: string;

    if (ecosystem === 'tron' || ecosystem === 'solana') {
      // For Tron/Solana: gasLimit is already the bandwidth/compute cost in atomic units
      // Don't multiply by gasPrice - use the value directly
      fullGasCostForBalance = gasLimit;
      adjustedGasCostForUsage = (
        (BigInt(gasLimit) *
          BigInt(this.config.margins.historicalUsagePercent)) /
        BigInt(100)
      ).toString();

      this.logger.log(
        `${ecosystem.toUpperCase()} gas calculation: using direct cost (no gasPrice multiplication)`,
        {
          ecosystem,
          directCost: gasLimit,
          note: 'Route provides final bandwidth/compute cost in atomic units, not a gas limit',
        },
      );
    } else {
      // For EVM: Calculate gas cost = gasLimit * gasPrice
      const baseGasCost = BigInt(gasLimit) * BigInt(gasPrice);
      fullGasCostForBalance = baseGasCost.toString();
      adjustedGasCostForUsage = (
        (baseGasCost * BigInt(this.config.margins.historicalUsagePercent)) /
        BigInt(100)
      ).toString();

      this.logger.log('EVM gas calculation: gasLimit * gasPrice', {
        ecosystem,
        gasLimit,
        gasPrice,
        calculatedCost: fullGasCostForBalance,
      });
    }

    this.logger.log('Using conservative gas estimate from route data', {
      ecosystem,
      routeGasLimit,
      quoteGasLimit,
      selectedGasLimit: gasLimit,
      gasLimitWithMargin,
      gasPrice,
      fullGasCostForBalance,
      adjustedGasCostForUsage,
    });

    return {
      gasLimit: gasLimitWithMargin,
      gasCost: fullGasCostForBalance,
    };
  }

  /**
   * Get chain-specific default gas price
   */
  private getChainDefaultGasPrice(chainId: number | string): string {
    const numericChainId =
      typeof chainId === 'string' ? parseInt(chainId) : chainId;

    if (numericChainId === 1) {
      return '30000000000'; // 30 gwei for Ethereum mainnet
    } else if (numericChainId === 56) {
      return '5000000000'; // 5 gwei for BSC
    } else if (numericChainId === 137) {
      return '50000000000'; // 50 gwei for Polygon
    } else {
      return '20000000000'; // 20 gwei generic default
    }
  }

  /**
   * Get gas price from network (provider APIs)
   * Prioritizes: NodeReal -> Etherscan -> RPC -> Static
   */
  async getGasPriceFromNetwork(chainId: number | string): Promise<string> {
    try {
      const feeData = await this.walletService.estimateFees(chainId, 'evm');

      if (feeData.type === 'eip1559') {
        return feeData.maxFeePerGas || '0';
      } else {
        return feeData.gasPrice || '0';
      }
    } catch (error) {
      this.logger.warn(
        `Failed to get gas price from network: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Extract chainId from route
   */
  private getChainIdFromRoute(route: RouteQuote): number | string {
    if (route.steps && route.steps.length > 0) {
      return route.steps[0].chainId;
    }
    throw new Error('Cannot determine chainId from route');
  }

  /**
   * Detect ecosystem from chainId
   * Used to avoid hardcoding 'evm' when calling wallet service methods
   */
  private detectEcosystemFromChainId(
    chainId: number | string,
  ): 'evm' | 'solana' | 'tron' {
    // Direct Tron detection (chainId 195)
    const originalStr = String(chainId).toLowerCase();
    const originalNum =
      typeof chainId === 'number' ? chainId : parseInt(String(chainId), 10);

    if (
      chainId === 195 ||
      chainId === '195' ||
      originalNum === 195 ||
      originalStr === 'tron' ||
      originalStr === 'tron-mainnet' ||
      originalStr === 'trx'
    ) {
      return 'tron';
    }

    // Solana detection - numeric chainId (7565164 = Rubic's Solana ID) or string-based
    if (
      originalNum === 1151111081099710 || // Rubic's numeric Solana chainId
      originalNum === 7565164 || // Another variant of Solana chainId
      originalStr.includes('solana') ||
      originalStr === 'sol' ||
      originalStr === 'solana-mainnet'
    ) {
      return 'solana';
    }

    // Default to EVM
    return 'evm';
  }
}
