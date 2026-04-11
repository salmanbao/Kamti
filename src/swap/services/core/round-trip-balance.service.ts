import { Injectable, BadRequestException } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { GasReserveTrackerService } from './gas-reserve-tracker.service';
import { isNativeToken } from '@shared/utils/token-address.utils';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';

/**
 * Balance calculation result for round-trip swaps
 */
export interface BalanceCalculationResult {
  availableBalance: bigint;
  gasReserve: bigint;
  actualBalance: bigint;
  canExecute: boolean;
  reason?: string;
}

/**
 * Round-Trip Balance Service
 *
 * Handles native currency balance calculations for round-trip swaps with gas reservation.
 * Implements requirements:
 * - #1: Native currency output amount handling with gas cost consideration
 * - #2: Cross-chain swap buy token must be native token validation
 * - #6: Record received amount after confirmation for second swap input
 */
@Injectable()
export class RoundTripBalanceService {
  constructor(
    private readonly walletService: WalletService,
    private readonly gasReserveTracker: GasReserveTrackerService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(RoundTripBalanceService.name);
  }

  /**
   * Calculate available balance for swap after gas reservation (requirement #1)
   *
   * For native tokens, we must reserve gas cost from balance to ensure transaction succeeds.
   * For non-native tokens, full balance can be used.
   *
   * @param ecosystem - Blockchain ecosystem (evm, solana, bitcoin, etc.)
   * @param chainId - Chain identifier
   * @param tokenAddress - Token address (undefined for native tokens)
   * @param tokenSymbol - Token symbol
   * @param walletAddress - Wallet address to check balance
   * @param transactionType - Type of transaction for gas estimation
   * @returns Balance calculation result with gas reserve
   */
  async calculateAvailableBalanceAfterGas(
    ecosystem: string,
    chainId: number | string,
    tokenAddress: string | undefined,
    tokenSymbol: string,
    walletAddress: string,
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap' = 'swap',
  ): Promise<BalanceCalculationResult> {
    this.logger.log('Calculating available balance after gas reservation', {
      ecosystem,
      chainId,
      tokenSymbol,
      walletAddress,
      transactionType,
      isNative: isNativeToken(tokenAddress || tokenSymbol),
    });

    try {
      // Fetch actual balance
      const balanceInfo = await this.walletService.getBalance(
        chainId,
        walletAddress,
        tokenAddress,
        ecosystem,
      );

      const actualBalance = BigInt(balanceInfo.balance);

      // Check if token is native (requires gas reservation)
      const isNative = isNativeToken(tokenAddress || tokenSymbol);

      if (!isNative) {
        // Non-native tokens don't need gas reservation
        return {
          availableBalance: actualBalance,
          gasReserve: BigInt(0),
          actualBalance,
          canExecute: actualBalance > 0n,
          reason:
            actualBalance > 0n
              ? 'Sufficient balance'
              : 'Insufficient token balance',
        };
      }

      // Native token - calculate adaptive gas reserve
      const trackerEcosystem = this.mapEcosystemToTrackerType(ecosystem);
      const chainIdNum =
        typeof chainId === 'string' ? parseInt(chainId, 10) : chainId;

      const reserveCalculation =
        this.gasReserveTracker.calculateAdaptiveReserve(
          trackerEcosystem,
          transactionType,
          actualBalance,
          chainIdNum,
        );

      const gasReserve = reserveCalculation.reserve;
      const availableBalance = actualBalance - gasReserve;

      this.logger.log('Gas reserve calculated for native token', {
        ecosystem,
        chainId,
        actualBalance: actualBalance.toString(),
        gasReserve: gasReserve.toString(),
        availableBalance: availableBalance.toString(),
        strategy: reserveCalculation.strategy,
        confidence: reserveCalculation.confidence?.toFixed(2),
      });

      // Validate sufficient balance after gas reservation
      if (availableBalance <= 0n) {
        return {
          availableBalance: BigInt(0),
          gasReserve,
          actualBalance,
          canExecute: false,
          reason: `Insufficient balance after gas reservation. Balance: ${actualBalance.toString()}, Gas reserve: ${gasReserve.toString()}`,
        };
      }

      return {
        availableBalance,
        gasReserve,
        actualBalance,
        canExecute: true,
      };
    } catch (error) {
      this.logger.error('Failed to calculate available balance', {
        error: error.message,
        ecosystem,
        chainId,
        tokenSymbol,
      });

      throw new BadRequestException(
        `Failed to calculate available balance: ${error.message}`,
      );
    }
  }

  /**
   * Validate that buy token is native token for cross-chain round-trip swaps (requirement #2, #10)
   *
   * For cross-chain round-trips (e.g., ETH→SOL→ETH), the intermediate token (SOL)
   * must be the native token to avoid complex multi-hop scenarios.
   *
   * @param buyTokenAddress - Buy token address
   * @param buyTokenSymbol - Buy token symbol
   * @param isCrossChain - Whether swap is cross-chain
   * @throws BadRequestException if validation fails
   */
  validateBuyTokenForCrossChainRoundTrip(
    buyTokenAddress: string | undefined,
    buyTokenSymbol: string,
    isCrossChain: boolean,
  ): void {
    if (!isCrossChain) {
      // Same-chain swaps don't have this restriction
      return;
    }

    const isNative = isNativeToken(buyTokenAddress || buyTokenSymbol);

    if (!isNative) {
      throw new BadRequestException(
        `Cross-chain round-trip swaps require native token as intermediate. ` +
          `Buy token ${buyTokenSymbol} is not a native token. ` +
          `Example: ETH→SOL→ETH requires SOL (native) as intermediate, not ETH→USDC→ETH. ` +
          `(Requirement #2, #10: Cross-chain destination must be native token)`,
      );
    }

    this.logger.log(
      '✅ Buy token validation passed for cross-chain round-trip',
      {
        buyTokenSymbol,
        isNative: true,
      },
    );
  }

  /**
   * Calculate amount for second leg of round-trip using actual received amount (requirement #6)
   *
   * After first swap completes and confirmations are received, we must use the ACTUAL
   * received amount (not estimated) as input for second swap.
   *
   * @param actualReceivedAmount - Actual amount received after first swap confirmation
   * @param ecosystem - Blockchain ecosystem for second swap
   * @param chainId - Chain ID for second swap
   * @param isNativeToken - Whether the intermediate token is native
   * @param transactionType - Transaction type for gas estimation
   * @returns Available amount for second swap after gas reservation
   */
  async calculateSecondLegAmount(
    actualReceivedAmount: string,
    ecosystem: string,
    chainId: number | string,
    isNativeToken: boolean,
    transactionType: 'simple' | 'cross-chain' | 'bridge' | 'swap' = 'swap',
  ): Promise<{
    inputAmount: bigint;
    gasReserve: bigint;
    reason: string;
  }> {
    const receivedAmount = BigInt(actualReceivedAmount);

    this.logger.log(
      'Calculating second leg amount from actual received amount',
      {
        actualReceivedAmount,
        ecosystem,
        chainId,
        isNativeToken,
        transactionType,
      },
    );

    if (!isNativeToken) {
      // Non-native token: use full received amount
      return {
        inputAmount: receivedAmount,
        gasReserve: BigInt(0),
        reason: 'Non-native token: full amount available',
      };
    }

    // Native token: reserve gas for second swap
    const trackerEcosystem = this.mapEcosystemToTrackerType(ecosystem);
    const chainIdNum =
      typeof chainId === 'string' ? parseInt(chainId, 10) : chainId;

    const reserveCalculation = this.gasReserveTracker.calculateAdaptiveReserve(
      trackerEcosystem,
      transactionType,
      receivedAmount,
      chainIdNum,
    );

    const gasReserve = reserveCalculation.reserve;
    const inputAmount = receivedAmount - gasReserve;

    if (inputAmount <= 0n) {
      throw new BadRequestException(
        `Insufficient amount for second swap leg. Received: ${actualReceivedAmount}, ` +
          `Gas reserve needed: ${gasReserve.toString()}. ` +
          `First swap did not yield enough to cover gas for second swap.`,
      );
    }

    this.logger.log('✅ Second leg amount calculated with gas reservation', {
      actualReceivedAmount,
      gasReserve: gasReserve.toString(),
      inputAmount: inputAmount.toString(),
      strategy: reserveCalculation.strategy,
    });

    return {
      inputAmount,
      gasReserve,
      reason: `Native token: reserved ${gasReserve.toString()} for gas`,
    };
  }

  /**
   * Fetch actual received amount from blockchain after transaction confirmation
   *
   * This method queries the blockchain to get the ACTUAL amount received after
   * first swap completes, accounting for slippage, fees, etc.
   *
   * @param ecosystem - Blockchain ecosystem
   * @param chainId - Chain ID
   * @param txHash - Transaction hash
   * @param recipientAddress - Recipient address
   * @param tokenAddress - Token address (undefined for native)
   * @returns Actual received amount in smallest unit (wei, lamports, etc.)
   */
  async fetchActualReceivedAmount(
    ecosystem: string,
    chainId: number | string,
    txHash: string,
    recipientAddress: string,
    tokenAddress: string | undefined,
  ): Promise<{
    amount: string;
    blockNumber: number;
    confirmations: number;
    timestamp: string;
  }> {
    this.logger.log('Fetching actual received amount from blockchain', {
      ecosystem,
      chainId,
      txHash,
      recipientAddress,
      tokenAddress,
    });

    // This will be implemented with chain-specific logic in requirement #9
    // For now, throw not implemented
    throw new Error(
      'fetchActualReceivedAmount will be implemented in requirement #9',
    );
  }

  /**
   * Map generic ecosystem string to gas reserve tracker type
   */
  private mapEcosystemToTrackerType(
    ecosystem: string,
  ): 'evm' | 'solana' | 'tron' | 'bitcoin' {
    const normalized = ecosystem.toLowerCase();

    if (normalized === BlockchainEcosystem.SOLANA) {
      return 'solana';
    }

    if (normalized === BlockchainEcosystem.BITCOIN) {
      return 'bitcoin';
    }

    if (normalized === BlockchainEcosystem.TRON) {
      return 'tron';
    }

    // Default to EVM for all EVM-compatible chains
    return 'evm';
  }

  /**
   * Fetch a simple balance snapshot for an address/token on a given chain.
   * Used as a secondary verification strategy for cross-chain receipts.
   */
  async getBalanceSnapshot(
    ecosystem: string,
    chainId: number | string,
    tokenAddress: string | undefined,
    tokenSymbol: string,
    walletAddress: string,
  ): Promise<string> {
    try {
      const info = await this.walletService.getBalance(
        chainId,
        walletAddress,
        tokenAddress,
        ecosystem,
      );
      return info.balance || '0';
    } catch (error) {
      this.logger.warn('Failed to fetch balance snapshot', {
        ecosystem,
        chainId,
        tokenSymbol,
        walletAddress,
        error: (error as Error).message,
      });
      return '0';
    }
  }
}
