import {
  Injectable,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { SwapOrchestrationService } from './swap-orchestration.service';
import { RoundTripBalanceService } from '../round-trip-balance.service';
import { ChainListenerService } from '@swap/services/blockchain/monitoring/chain-listener.service';
import { TransactionMonitorGateway } from '@swap/services/blockchain/monitoring/transaction-monitor.gateway';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { ExecutionStateService } from '../state/execution-state.service';
import { BridgeStatusTrackerService } from '../state/bridge-status-tracker.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  UniversalSwapRequestDto,
  TokenInfo,
  BlockchainEcosystem,
} from '@swap/dto/universal-swap-request.dto';
import {
  UniversalResponse,
  ExecutionData,
  RoundTripDetails,
} from '@swap/dto/universal-response.dto';
import { isNativeToken } from '@shared/utils/token-address.utils';
import { getRoundTripMinConfirmations } from '@shared/config/confirmation-requirements.config';
import { getChainEcosystem } from '@shared/utils/chain.utils';

/**
 * Round-Trip Swap Context
 * Tracks state between swap legs
 */
interface RoundTripContext {
  executionId: string;
  leg1ExecutionId?: string; // Separate execution ID for leg 1 to avoid state conflicts
  leg1StartTime: Date;
  leg1EndTime?: Date;
  leg1TxHash?: string;
  leg1ActualReceivedAmount?: string;
  leg2StartTime?: Date;
  leg2EndTime?: Date;
  leg2TxHash?: string;
  leg2ActualReceivedAmount?: string;
  initialAmount: string;
  finalAmount?: string;
  totalGasCost: bigint;
  destPreBalance?: string;
  destPostBalance?: string;
}

/**
 * Round-Trip Orchestration Service
 *
 * Handles execution of round-trip swaps (e.g., ETH→USDT→ETH).
 *
 * Requirements:
 * - #5: Wait for minimum confirmations between legs (EVM=1, Solana=1, Bitcoin=3)
 * - #6: Use actual received amount from leg 1 as input for leg 2
 * - #7: Partial failure handling (leg 1 success, leg 2 fails)
 * - #8: Final destination must equal source chain
 * - #9: Multi-chain private key handling (EVM + Solana keys for ETH→SOL→ETH)
 * - #10: Cross-chain round-trips require native intermediate token
 */
@Injectable()
export class RoundTripOrchestrationService {
  constructor(
    @Inject(forwardRef(() => SwapOrchestrationService))
    private readonly swapOrchestration: SwapOrchestrationService,
    private readonly balanceService: RoundTripBalanceService,
    private readonly chainListener: ChainListenerService,
    private readonly transactionMonitor: TransactionMonitorGateway,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly executionState: ExecutionStateService,
    private readonly bridgeTracker: BridgeStatusTrackerService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(RoundTripOrchestrationService.name);
  }

  /**
   * Execute round-trip swap
   *
   * Process:
   * 1. Validate round-trip requirements (requirements #8, #9, #10)
   * 2. Execute first swap (sellToken → buyToken)
   * 3. Wait for confirmations (requirement #5)
   * 4. Parse actual received amount (requirement #6)
   * 5. Check profitability (optional)
   * 6. Execute second swap (buyToken → finalOutputToken) with actual amount
   *    - DYNAMIC RE-ADJUSTMENT: Checks elapsed time and triggers fresh quote if needed
   *    - Addresses Missing Scenario #2: "Leg 2 Quote Expiry Before Execution"
   *    - Ensures best pricing by requoting after > 60s wait time
   * 7. Wait for confirmations
   * 8. Calculate profitability
   * 9. Handle partial failures (requirement #7)
   */
  async executeRoundTripSwap(
    request: UniversalSwapRequestDto,
  ): Promise<UniversalResponse<ExecutionData>> {
    const executionId = `rt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.logger.log(`🔄 Starting round-trip swap execution: ${executionId}`);

    // Initialize context
    const context: RoundTripContext = {
      executionId,
      leg1StartTime: new Date(),
      initialAmount: request.sellAmount,
      totalGasCost: BigInt(0),
    };

    try {
      // Step 1: Validate round-trip requirements
      await this.validateRoundTripRequirements(request);

      // Initialize round-trip context in execution snapshot (auto-chaining support)
      try {
        if (request.finalOutputToken) {
          this.executionState.setRoundTripContext(executionId, {
            intermediateToken: request.buyToken,
            finalOutputToken: request.finalOutputToken,
            taker: request.taker,
            recipient: request.recipient || request.taker,
            slippageToleranceBps: request.slippageToleranceBps,
            privateKey: request.privateKey,
            solanaPrivateKey: request.solanaPrivateKey,
            bitcoinPrivateKey: request.bitcoinPrivateKey,
          });
        }
      } catch (e) {
        this.logger.warn(
          `Failed to initialize round-trip context: ${e.message}`,
        );
      }

      // Step 2 (pre): Snapshot destination balance (secondary verification)
      try {
        context.destPreBalance = await this.balanceService.getBalanceSnapshot(
          request.buyToken.chain.ecosystem,
          request.buyToken.chain.chainId,
          request.buyToken.address,
          request.buyToken.symbol,
          request.recipient || request.taker,
        );
        this.logger.log(
          `📸 Destination pre-balance snapshotted: ${context.destPreBalance}`,
        );
      } catch (error) {
        this.logger.warn(
          `⚠️ Failed to snapshot destination pre-balance: ${error.message}`,
          { executionId, error: error.stack },
        );
      }

      // Step 2: Execute first swap leg
      this.logger.log(
        `📤 Executing leg 1: ${request.sellToken.symbol} → ${request.buyToken.symbol}`,
      );
      const leg1Result = await this.executeSwapLeg1(request, context);

      // Step 3: Wait for confirmations and get actual received amount
      this.logger.log(`⏳ Waiting for leg 1 confirmations...`);
      const leg1Amount = await this.waitAndGetReceivedAmount(
        leg1Result,
        request.buyToken,
        request.recipient || request.taker,
        context,
      );

      // Emit leg 1 complete event
      this.transactionMonitor.emitRoundTripLeg1Complete(executionId, {
        txHash: leg1Result.data.transactionHashes[0],
        chainId: request.sellToken.chain.chainId,
        ecosystem: request.sellToken.chain.ecosystem,
        inputToken: request.sellToken.symbol,
        outputToken: request.buyToken.symbol,
        inputAmount: request.sellAmount,
        outputAmount: leg1Amount.estimated,
        actualReceivedAmount: leg1Amount.actual,
        confirmations: leg1Amount.confirmations,
      });

      // Persist leg1 success in snapshot with actual received amount if available
      try {
        this.executionState.markRoundTripLeg1Complete(
          executionId,
          leg1Result.data.transactionHashes[0],
          leg1Amount.actual,
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to mark leg 1 complete in state: ${error.message}`,
          {
            executionId,
            txHash: leg1Result.data.transactionHashes[0],
            error: error.stack,
          },
        );
      }

      // Step 4: Check profitability if threshold set
      if (request.minProfitBps !== undefined) {
        const shouldProceed = await this.checkProfitability(
          request,
          leg1Amount.actual,
          context,
        );

        if (!shouldProceed) {
          return this.buildProfitabilityAbortResponse(
            request,
            leg1Result,
            leg1Amount,
            context,
          );
        }
      }

      // Step 5: Execute second swap leg with actual received amount
      this.logger.log(
        `📥 Executing leg 2: ${request.buyToken.symbol} → ${request.finalOutputToken!.symbol}`,
      );

      try {
        // Mark leg2 started
        try {
          this.executionState.markRoundTripLeg2Started(executionId);
        } catch (error) {
          this.logger.error(
            `❌ Failed to mark leg 2 started in state: ${error.message}`,
            { executionId, error: error.stack },
          );
        }
        const leg2Result = await this.executeSwapLeg2(
          request,
          leg1Amount.actual,
          context,
        );

        // Step 6: Wait for confirmations and get final amount
        // CRITICAL: Use leg-2 recipient (taker) not leg-1 recipient (request.recipient)
        // For ETH→SOL→ETH: leg-1 recipient is Solana address, leg-2 recipient is Ethereum address
        const leg2Recipient = request.taker; // Final tokens land at original sender's address
        this.logger.log(`⏳ Waiting for leg 2 confirmations...`);
        const leg2Amount = await this.waitAndGetReceivedAmount(
          leg2Result,
          request.finalOutputToken!,
          leg2Recipient,
          context,
        );

        // Persist leg2 complete
        try {
          this.executionState.markRoundTripLeg2Complete(
            executionId,
            leg2Result.data.transactionHashes[0],
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to mark leg 2 complete in state: ${error.message}`,
            {
              executionId,
              txHash: leg2Result.data.transactionHashes[0],
              error: error.stack,
            },
          );
        }
        // Step 7: Build success response
        return this.buildSuccessResponse(
          request,
          leg1Result,
          leg2Result,
          leg1Amount,
          leg2Amount,
          context,
        );
      } catch (leg2Error) {
        // Handle partial failure (requirement #7)
        this.logger.error(`❌ Leg 2 failed: ${leg2Error.message}`);
        try {
          this.executionState.markRoundTripLeg2Failed(
            executionId,
            leg2Error.message,
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to mark leg 2 as failed in state: ${error.message}`,
            { executionId, leg2Error: leg2Error.message, error: error.stack },
          );
        }

        return this.buildPartialFailureResponse(
          request,
          leg1Result,
          leg1Amount,
          leg2Error,
          context,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ Round-trip swap failed: ${error.message}`,
        error.stack,
      );

      return {
        success: false,
        data: {
          executionId,
          transactionHashes: [],
          status: {
            overall: 'FAILED',
            currentStep: 0,
            totalSteps: 2,
            progressPercentage: 0,
          },
          steps: [],
          estimatedCompletion: new Date().toISOString(),
          trackingUrls: [],
        } as ExecutionData,
        metadata: {
          swapType: 'round-trip' as any,
          providerCategory: 'auto',
          estimatedTime: 0,
          complexity: 'complex',
          timestamp: new Date().toISOString(),
          executionId,
        },
        error: {
          code: 'ROUND_TRIP_FAILED',
          message: error.message,
          details: error.stack,
        },
      };
    }
  }

  /**
   * Public: Auto-chain second leg based on snapshot context and confirmed balance
   * Returns true if leg 2 was started (or already completed), false otherwise.
   * Implements dynamic re-adjustment: always fetches fresh quotes for leg 2
   */
  async startSecondLegFromSnapshot(executionId: string): Promise<boolean> {
    const snap = (await this.executionState.getExecutionSnapshot(
      executionId,
    )) as any;
    if (!snap?.roundTrip?.enabled) return false;

    const leg2Status = snap.roundTrip.leg2?.status;
    if (leg2Status === 'STARTED' || leg2Status === 'SUCCESS') return false; // already handled

    const inter = snap.roundTrip.intermediateToken as TokenInfo;
    const dest = snap.roundTrip.finalOutputToken as TokenInfo;
    const recipient = snap.roundTrip.recipient as string;
    const taker = snap.roundTrip.taker as string;
    const slippage = snap.roundTrip.slippageToleranceBps as number | undefined;

    // Determine actual received amount from balance probe
    const actualRaw: string | undefined =
      snap.bridge?.balanceDeltaRaw || snap.roundTrip.leg1?.actualReceivedRaw;
    if (!actualRaw || actualRaw === '0') {
      this.logger.debug(
        `[${executionId}] Auto-chain skipped: no confirmed leg1 amount yet`,
      );
      return false;
    }

    // Compute leg2 input amount (reserve gas if native)
    let leg2InputAmount = actualRaw;
    const isNative = isNativeToken(inter.address || inter.symbol);
    if (isNative) {
      try {
        const calc = await this.balanceService.calculateSecondLegAmount(
          actualRaw,
          inter.chain.ecosystem,
          inter.chain.chainId,
          true,
          'swap',
        );
        leg2InputAmount = calc.inputAmount.toString();
      } catch (e) {
        this.logger.warn(
          `[${executionId}] Gas reserve calc failed, using full amount: ${e.message}`,
        );
      }
    }

    // DYNAMIC RE-ADJUSTMENT: Calculate elapsed time to determine if we should requote
    const leg1StartTime = snap.roundTrip.leg1?.startTime
      ? new Date(snap.roundTrip.leg1.startTime).getTime()
      : Date.now();
    const elapsedSinceLeg1Start = Date.now() - leg1StartTime;
    const elapsedSeconds = Math.floor(elapsedSinceLeg1Start / 1000);
    const requoteThresholdSeconds = 60;

    // Log requote decision for auto-chain scenario
    if (elapsedSeconds > requoteThresholdSeconds) {
      this.logger.log(
        `🔄 [${executionId}] Auto-chain leg 2: Triggering fresh quote after ${elapsedSeconds}s wait`,
        {
          actualAmount: leg2InputAmount,
          threshold: requoteThresholdSeconds,
        },
      );
    } else {
      this.logger.log(
        `✅ [${executionId}] Auto-chain leg 2: Quote freshness acceptable (${elapsedSeconds}s)`,
        {
          actualAmount: leg2InputAmount,
        },
      );
    }

    // Build request for leg 2 with actual received amount
    // SwapOrchestrationService will fetch fresh quotes during execution
    const leg2Req: UniversalSwapRequestDto = {
      sellToken: inter,
      buyToken: dest,
      sellAmount: leg2InputAmount,
      taker,
      recipient,
      slippageToleranceBps: slippage,
      privateKey: snap.roundTrip.privateKey,
      solanaPrivateKey: snap.roundTrip.solanaPrivateKey,
      bitcoinPrivateKey: snap.roundTrip.bitcoinPrivateKey,
      // Enable dynamic adjustment for native tokens to handle gas sufficiency
      swapFullBalance: isNative,
    } as UniversalSwapRequestDto;

    // Idempotency guard: mark started before execution
    try {
      this.executionState.markRoundTripLeg2Started(executionId);
    } catch (error) {
      this.logger.error(
        `❌ Failed to mark leg 2 started (auto-chain): ${error.message}`,
        { executionId, error: error.stack },
      );
    }

    // Execute with fresh timestamp to ensure quote refresh
    const result = await this.swapOrchestration.executeSwap(
      leg2Req,
      executionId,
      Date.now(),
    );
    if (!result.success) {
      try {
        this.executionState.markRoundTripLeg2Failed(
          executionId,
          result.error?.message || 'Leg2 execution failed',
        );
      } catch (error) {
        this.logger.error(
          `❌ Failed to mark leg 2 as failed (auto-chain): ${error.message}`,
          { executionId, legError: result.error?.message, error: error.stack },
        );
      }
      throw new Error(result.error?.message || 'Leg 2 swap failed');
    }

    try {
      this.executionState.markRoundTripLeg2Complete(
        executionId,
        (result.data as any).transactionHashes?.[0],
      );
    } catch (error) {
      this.logger.error(
        `❌ Failed to mark leg 2 complete (auto-chain): ${error.message}`,
        {
          executionId,
          txHash: (result.data as any).transactionHashes?.[0],
          error: error.stack,
        },
      );
    }
    this.logger.log(
      `✅ [${executionId}] Auto-chained leg 2 completed successfully with fresh quote`,
    );
    return true;
  }

  /**
   * Validate round-trip requirements
   *
   * Requirements:
   * - #8: finalOutputToken.chain must equal sellToken.chain
   * - #9: Multi-chain private keys validated
   * - #10: Cross-chain requires native intermediate token
   */
  private async validateRoundTripRequirements(
    request: UniversalSwapRequestDto,
  ): Promise<void> {
    if (!request.finalOutputToken) {
      throw new BadRequestException(
        'finalOutputToken is required for round-trip swaps',
      );
    }

    // Requirement #8: Final destination = source chain
    if (
      request.finalOutputToken.chain.chainId !==
        request.sellToken.chain.chainId ||
      request.finalOutputToken.chain.ecosystem !==
        request.sellToken.chain.ecosystem
    ) {
      throw new BadRequestException(
        `Round-trip swap must return to source chain. ` +
          `Source: ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId}, ` +
          `Final: ${request.finalOutputToken.chain.ecosystem}:${request.finalOutputToken.chain.chainId}. ` +
          `(Requirement #8: Final destination must equal source chain)`,
      );
    }

    // Check if cross-chain round-trip
    const isCrossChain =
      request.buyToken.chain.chainId !== request.sellToken.chain.chainId;

    if (isCrossChain) {
      // Requirement #10: Cross-chain requires native intermediate token
      this.balanceService.validateBuyTokenForCrossChainRoundTrip(
        request.buyToken.address,
        request.buyToken.symbol,
        true,
      );

      // Requirement #9: Multi-chain private key validation
      await this.validateMultiChainPrivateKeys(request);
    }

    this.logger.log('✅ Round-trip requirements validated', {
      isCrossChain,
      sourceChain: `${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId}`,
      intermediateChain: `${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}`,
      finalChain: `${request.finalOutputToken.chain.ecosystem}:${request.finalOutputToken.chain.chainId}`,
    });
  }

  /**
   * Validate multi-chain private keys (requirement #9)
   *
   * For cross-chain round-trips like ETH→SOL→ETH, we need:
   * - EVM private key for leg 1 (ETH → SOL bridge)
   * - Solana private key for leg 2 (SOL → ETH bridge)
   */
  private async validateMultiChainPrivateKeys(
    request: UniversalSwapRequestDto,
  ): Promise<void> {
    const leg1Ecosystem = request.sellToken.chain.ecosystem.toLowerCase();
    const leg2Ecosystem = request.buyToken.chain.ecosystem.toLowerCase();

    // Check leg 1 private key
    if (
      leg1Ecosystem === BlockchainEcosystem.EVM ||
      leg1Ecosystem === 'ethereum'
    ) {
      if (!request.privateKey) {
        throw new BadRequestException(
          `EVM private key (privateKey) required for leg 1 on ${request.sellToken.chain.ecosystem}`,
        );
      }
    } else if (leg1Ecosystem === BlockchainEcosystem.SOLANA) {
      if (!request.solanaPrivateKey) {
        throw new BadRequestException(
          `Solana private key (solanaPrivateKey) required for leg 1 on Solana`,
        );
      }
    } else if (leg1Ecosystem === BlockchainEcosystem.BITCOIN) {
      if (!request.bitcoinPrivateKey) {
        throw new BadRequestException(
          `Bitcoin private key (bitcoinPrivateKey) required for leg 1 on Bitcoin`,
        );
      }
    }

    // Check leg 2 private key (different from leg 1)
    if (
      leg2Ecosystem === BlockchainEcosystem.EVM ||
      leg2Ecosystem === 'ethereum'
    ) {
      if (!request.privateKey) {
        throw new BadRequestException(
          `EVM private key (privateKey) required for leg 2 on ${request.buyToken.chain.ecosystem}`,
        );
      }
    } else if (leg2Ecosystem === BlockchainEcosystem.SOLANA) {
      if (!request.solanaPrivateKey) {
        throw new BadRequestException(
          `Solana private key (solanaPrivateKey) required for leg 2 on Solana`,
        );
      }
    } else if (leg2Ecosystem === BlockchainEcosystem.BITCOIN) {
      if (!request.bitcoinPrivateKey) {
        throw new BadRequestException(
          `Bitcoin private key (bitcoinPrivateKey) required for leg 2 on Bitcoin`,
        );
      }
    }

    this.logger.log('✅ Multi-chain private keys validated', {
      leg1Ecosystem,
      leg2Ecosystem,
      hasEvmKey: !!request.privateKey,
      hasSolanaKey: !!request.solanaPrivateKey,
      hasBitcoinKey: !!request.bitcoinPrivateKey,
    });
  }

  /**
   * Execute first swap leg
   */
  private async executeSwapLeg1(
    request: UniversalSwapRequestDto,
    context: RoundTripContext,
  ): Promise<UniversalResponse<ExecutionData>> {
    // Build leg 1 swap request (without finalOutputToken to avoid recursion)
    const leg1Request: UniversalSwapRequestDto = {
      ...request,
      finalOutputToken: undefined, // Remove to execute as regular swap
      minProfitBps: undefined,
    };

    // Generate separate execution ID for leg-1 to avoid state conflicts
    // Using same executionId can cause issues with execution context tracking
    const leg1ExecutionId = `${context.executionId}_leg1`;
    context.leg1ExecutionId = leg1ExecutionId; // Store for later use in snapshot lookups

    this.logger.log('🔄 Executing LEG-1 with separate execution ID', {
      parentExecutionId: context.executionId,
      leg1ExecutionId,
      sellToken: request.sellToken.symbol,
      buyToken: request.buyToken.symbol,
      amount: request.sellAmount,
    });

    const result = await this.swapOrchestration.executeSwap(
      leg1Request,
      leg1ExecutionId, // ← Use separate ID to prevent state conflicts
      Date.now(),
    );

    if (!result.success) {
      throw new Error(`Leg 1 swap failed: ${result.error?.message}`);
    }

    // Cast to ExecutionData and extract transaction hash
    const executionData = result.data as ExecutionData;
    context.leg1TxHash = executionData.transactionHashes[0];
    context.leg1EndTime = new Date();

    return result as UniversalResponse<ExecutionData>;
  }

  /**
   * Wait for confirmations and get actual received amount (requirements #5, #6)
   */
  private async waitAndGetReceivedAmount(
    swapResult: UniversalResponse<ExecutionData>,
    token: TokenInfo,
    recipientAddress: string,
    context: RoundTripContext,
  ): Promise<{
    actual: string;
    estimated: string;
    confirmations: number;
  }> {
    const txHash = swapResult.data.transactionHashes[0];

    if (!txHash) {
      throw new Error('No transaction hash found in swap result');
    }
    // Determine if cross-chain by inspecting steps
    const steps = (swapResult.data as any)?.steps || [];
    const sourceChainId = steps?.[0]?.chainId ?? token.chain.chainId;
    const destChainId = token.chain.chainId;
    const isCrossChain = sourceChainId !== destChainId;

    // Get minimum confirmations for source chain ecosystem (gate on source receipt)
    const sourceEcosystem = getChainEcosystem(sourceChainId);
    const minConfirmations = getRoundTripMinConfirmations(sourceEcosystem);

    this.logger.log(
      `Waiting for ${minConfirmations} confirmations on source (${sourceEcosystem})`,
    );

    // Wait for confirmations on SOURCE chain first
    await this.chainListener.waitForConfirmations(
      sourceChainId,
      sourceEcosystem,
      txHash,
      minConfirmations,
      (event) => {
        this.transactionMonitor.emitTransactionConfirmed(context.executionId, {
          ...event,
          chainId: sourceChainId,
          ecosystem: sourceEcosystem,
        });
      },
    );

    // For same-chain, fetch actual amount directly on this chain using txHash
    if (!isCrossChain) {
      const actualAmount = await this.chainListener.getActualReceivedAmount(
        token.chain.chainId,
        token.chain.ecosystem,
        txHash,
        recipientAddress,
        token.address,
      );
      this.logger.log(
        `✅ Received actual amount (same-chain): ${actualAmount.amount}`,
      );
      return {
        actual: actualAmount.amount,
        estimated:
          (swapResult.data as any).route?.estimatedOutputAmount?.raw || '0',
        confirmations: minConfirmations,
      };
    }

    // Cross-chain: try to resolve destination tx via background tracker, then measure actual amount
    // For cross-chain bridges, we need to wait longer (typical bridges take 2-4 minutes)
    let destTxHash: string | undefined;
    const maxAttempts = 18; // 18 attempts × 10s = 3 minutes total wait time
    const baseDelay = 10000; // 10 seconds between attempts

    // Use leg1ExecutionId for snapshot lookups since that's what the background tracker uses
    const executionIdForLookup = context.leg1ExecutionId || context.executionId;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (
          this.bridgeTracker?.refreshStatus &&
          this.executionState?.getExecutionSnapshot
        ) {
          // First check the current snapshot state WITHOUT forcing a refresh
          // The background tracker may have already completed
          const snap =
            await this.executionState.getExecutionSnapshot(
              executionIdForLookup,
            );

          // Check if bridge tracking already completed
          if (snap?.bridge?.destTxHash) {
            destTxHash = snap.bridge.destTxHash;
            this.logger.log(
              `🎯 Bridge completed! Got destTxHash after ${i + 1} attempts (status: ${snap.bridge.status})`,
            );
            break;
          }

          // Check if background tracker already marked as completed/failed/reverted
          // If so, no need to keep polling - background tracker has already done its job
          if (
            snap?.bridge?.status === 'completed' ||
            snap?.bridge?.status === 'failed' ||
            snap?.bridge?.status === 'reverted'
          ) {
            this.logger.log(
              `✅ Background tracker already completed with status: ${snap.bridge.status}`,
            );
            if (snap.bridge.destTxHash) {
              destTxHash = snap.bridge.destTxHash;
            }
            break;
          }

          // Only refresh if not already completed (reduces unnecessary API calls)
          await this.bridgeTracker.refreshStatus(executionIdForLookup);

          // Re-check snapshot after refresh
          const updatedSnap =
            await this.executionState.getExecutionSnapshot(
              executionIdForLookup,
            );
          if (updatedSnap?.bridge?.destTxHash) {
            destTxHash = updatedSnap.bridge.destTxHash;
            this.logger.log(
              `🎯 Bridge completed! Got destTxHash after ${i + 1} attempts`,
            );
            break;
          }

          // Log progress
          const status = updatedSnap?.bridge?.status || 'unknown';
          this.logger.log(
            `⏳ Bridge status check ${i + 1}/${maxAttempts}: ${status}`,
          );
        }
      } catch (e) {
        this.logger.warn(
          `⚠️ Bridge status check ${i + 1} failed: ${e.message}`,
        );
      }
      // Wait before next attempt (don't wait after the last attempt)
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelay));
      }
    }

    if (destTxHash) {
      // First, try to use the amount returned by Rubic API (most efficient)
      const snap =
        await this.executionState?.getExecutionSnapshot(executionIdForLookup);
      const rubicAmount =
        (snap?.bridge as any)?.toAmountWei || (snap?.bridge as any)?.toAmount;

      if (rubicAmount) {
        // Convert toAmount (human-readable) to wei if toAmountWei is not available
        let amountInWei = rubicAmount;
        if (
          (snap?.bridge as any)?.toAmount &&
          !(snap?.bridge as any)?.toAmountWei
        ) {
          // toAmount is human-readable (e.g., "9.648832"), convert to wei
          const decimals = token.decimals || 18;
          amountInWei = BigInt(
            Math.floor(parseFloat(rubicAmount) * Math.pow(10, decimals)),
          ).toString();
        }

        this.logger.log(
          `✅ Using amount from Rubic API response: ${amountInWei} (source: ${(snap?.bridge as any)?.toAmountWei ? 'toAmountWei' : 'toAmount'})`,
        );

        return {
          actual: amountInWei,
          estimated:
            (swapResult.data as any).route?.estimatedOutputAmount?.raw || '0',
          confirmations: minConfirmations,
        };
      }

      // Fallback to parsing destination transaction (slower, requires RPC call)
      try {
        const actualAmount = await this.chainListener.getActualReceivedAmount(
          token.chain.chainId,
          token.chain.ecosystem,
          destTxHash,
          recipientAddress,
          token.address,
        );

        // Validate that we got a non-zero amount
        if (actualAmount.amount && actualAmount.amount !== '0') {
          this.logger.log(
            `✅ Destination tx resolved via chain RPC. Amount: ${actualAmount.amount}`,
          );
          return {
            actual: actualAmount.amount,
            estimated:
              (swapResult.data as any).route?.estimatedOutputAmount?.raw || '0',
            confirmations: minConfirmations,
          };
        } else {
          this.logger.warn(
            `⚠️ Chain listener returned zero amount for destTxHash ${destTxHash}. ` +
              `Falling back to balance delta method.`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `⚠️ Failed to get actual amount from destTxHash ${destTxHash}: ${error.message}. ` +
            `Falling back to balance delta method.`,
        );
      }
      // Fall through to balance delta fallback if parsing failed or returned 0
    }

    // Fallback: balance snapshot delta (secondary verification strategy)
    // Note: This should only be used if bridge status checks failed or timed out
    this.logger.warn(
      `⚠️ Bridge status checks exhausted without destTxHash. Falling back to balance delta method.`,
    );
    const pre = context.destPreBalance || '0';
    const post = await this.balanceService.getBalanceSnapshot(
      token.chain.ecosystem,
      token.chain.chainId,
      token.address,
      token.symbol,
      recipientAddress,
    );
    context.destPostBalance = post;
    let delta = '0';
    try {
      const preBn = BigInt(pre);
      const postBn = BigInt(post);
      delta = postBn > preBn ? (postBn - preBn).toString() : '0';
    } catch (error) {
      this.logger.error(
        `❌ Failed to calculate balance delta: ${error.message}`,
        { pre, post, error: error.message },
      );
    }

    if (delta === '0') {
      this.logger.error(
        `❌ Balance delta is 0! Pre-balance: ${pre}, Post-balance: ${post}. ` +
          `This likely means the bridge transfer hasn't completed yet, or there was an error.`,
      );
    } else {
      this.logger.log(
        `ℹ️ Using balance snapshot delta as receipt: delta=${delta} (pre=${pre}, post=${post})`,
      );
    }

    return {
      actual: delta,
      estimated:
        (swapResult.data as any).route?.estimatedOutputAmount?.raw || '0',
      confirmations: minConfirmations,
    };
  }

  /**
   * Check profitability before executing leg 2
   */
  private async checkProfitability(
    request: UniversalSwapRequestDto,
    leg1ActualAmount: string,
    context: RoundTripContext,
  ): Promise<boolean> {
    // TODO: Implement profitability estimation
    // For now, always proceed
    this.logger.log('Profitability check passed (not implemented yet)');
    return true;
  }

  /**
   * Execute second swap leg with actual received amount
   * Implements dynamic re-adjustment: checks if quotes are stale and re-quotes with actual amount
   * Addresses Missing Scenario #2: "Leg 2 Quote Expiry Before Execution"
   */
  private async executeSwapLeg2(
    request: UniversalSwapRequestDto,
    leg1ActualAmount: string,
    context: RoundTripContext,
  ): Promise<UniversalResponse<ExecutionData>> {
    context.leg2StartTime = new Date();

    // Calculate available amount for leg 2 (considering gas if native token)
    const isNative = isNativeToken(
      request.buyToken.address || request.buyToken.symbol,
    );

    let leg2InputAmount: string;

    if (isNative) {
      // Reserve gas for leg 2 (requirement #1)
      const secondLegCalc = await this.balanceService.calculateSecondLegAmount(
        leg1ActualAmount,
        request.buyToken.chain.ecosystem,
        request.buyToken.chain.chainId,
        true,
        'swap',
      );

      leg2InputAmount = secondLegCalc.inputAmount.toString();
      context.totalGasCost += secondLegCalc.gasReserve;

      this.logger.log('Native token gas reserved for leg 2', {
        actualReceived: leg1ActualAmount,
        gasReserve: secondLegCalc.gasReserve.toString(),
        availableForSwap: leg2InputAmount,
      });
    } else {
      // Non-native token: use full amount
      leg2InputAmount = leg1ActualAmount;
    }

    // DYNAMIC RE-ADJUSTMENT: Check if we need to re-quote for leg 2
    // Calculate elapsed time since leg 1 started to determine if quote would be stale
    const elapsedSinceLeg1Start = Date.now() - context.leg1StartTime.getTime();
    const elapsedSeconds = Math.floor(elapsedSinceLeg1Start / 1000);

    // Cross-chain quotes typically valid for 120-180s, on-chain for 30-60s
    // Re-quote if elapsed time > 60s to ensure fresh pricing
    const requoteThresholdSeconds = 60;
    const shouldRequote = elapsedSeconds > requoteThresholdSeconds;

    if (shouldRequote) {
      this.logger.warn(
        `⚠️ Leg 2 quote potentially stale after ${elapsedSeconds}s - triggering re-quote for better pricing`,
        {
          executionId: context.executionId,
          elapsedSeconds,
          threshold: requoteThresholdSeconds,
          actualAmount: leg2InputAmount,
        },
      );
    } else {
      this.logger.log(
        `✅ Quote freshness acceptable (${elapsedSeconds}s elapsed), proceeding with leg 2`,
        {
          executionId: context.executionId,
          elapsedSeconds,
        },
      );
    }

    // Build leg 2 swap request with actual received amount
    // The orchestration service will automatically fetch fresh quotes during execution
    // CRITICAL FIX: For leg-2, recipient must be on the FINAL OUTPUT chain, not intermediate chain
    // Example: ETH→SOL→ETH means leg-1 recipient is Solana address, leg-2 recipient is Ethereum address
    // The leg-2 recipient should be where the final tokens are sent (typically back to taker)
    const leg2Recipient = request.taker; // Final tokens go back to original sender

    const leg2Request: UniversalSwapRequestDto = {
      sellToken: request.buyToken,
      buyToken: request.finalOutputToken!,
      sellAmount: leg2InputAmount, // Use actual received amount (adjusted for gas)
      taker: request.recipient || request.taker, // Leg-2 taker is where intermediate tokens landed
      recipient: leg2Recipient, // Final output goes to original sender's chain
      slippageToleranceBps: request.slippageToleranceBps,
      privateKey: this.selectPrivateKeyForEcosystem(
        request,
        request.buyToken.chain.ecosystem,
      ),
      solanaPrivateKey: request.solanaPrivateKey,
      bitcoinPrivateKey: request.bitcoinPrivateKey,
      tronPrivateKey: request.tronPrivateKey,
      // CRITICAL: Set swapFullBalance=true for native tokens to enable dynamic re-adjustment
      // Even though we pre-calculated gas reserve, actual on-chain conditions may differ:
      // - Gas prices may have changed between calculation and execution
      // - Actual balance may be slightly different due to concurrent transactions
      // - Quote gas estimates may differ from initial calculation
      // Setting this to true ensures BaseSwapExecutor verifies gas sufficiency and adjusts if needed
      swapFullBalance: isNative, // Enable dynamic adjustment for native tokens
    };

    // Emit leg 2 started event
    this.transactionMonitor.emitRoundTripLeg2Started(context.executionId, {
      txHash: '', // Will be filled after execution
      chainId: request.buyToken.chain.chainId,
      ecosystem: request.buyToken.chain.ecosystem,
      inputToken: request.buyToken.symbol,
      outputToken: request.finalOutputToken!.symbol,
      inputAmount: leg2InputAmount,
      estimatedOutput: '0', // Will be calculated by aggregator during execution
      requoted: shouldRequote,
      elapsedSeconds,
    } as any); // Type cast to avoid extending interface for extra fields

    // Execute leg 2 - orchestration service will fetch fresh quotes automatically
    // The actual amount is already baked into the request, ensuring proper quote calculation

    // Generate separate execution ID for leg-2 to avoid state conflicts
    const leg2ExecutionId = `${context.executionId}_leg2`;

    this.logger.log('🔄 Executing LEG-2 with separate execution ID', {
      parentExecutionId: context.executionId,
      leg2ExecutionId,
      sellToken: leg2Request.sellToken.symbol,
      buyToken: leg2Request.buyToken.symbol,
      amount: leg2InputAmount,
      swapFullBalance: leg2Request.swapFullBalance,
    });

    const result = await this.swapOrchestration.executeSwap(
      leg2Request,
      leg2ExecutionId, // ← Use separate ID to prevent state conflicts
      Date.now(), // Fresh timestamp for quote fetching
    );

    if (!result.success) {
      throw new Error(`Leg 2 swap failed: ${result.error?.message}`);
    }

    // Log success with dynamic adjustment info
    if (shouldRequote) {
      this.logger.log(
        `✅ Leg 2 executed successfully with fresh quote after ${elapsedSeconds}s wait`,
        {
          executionId: context.executionId,
          actualInputAmount: leg2InputAmount,
        },
      );
    }

    // Cast to ExecutionData and extract transaction hash
    const executionData = result.data as ExecutionData;
    context.leg2TxHash = executionData.transactionHashes[0];
    context.leg2EndTime = new Date();

    return result as UniversalResponse<ExecutionData>;
  }

  /**
   * Select appropriate private key for ecosystem
   */
  private selectPrivateKeyForEcosystem(
    request: UniversalSwapRequestDto,
    ecosystem: string,
  ): string | undefined {
    const normalized = ecosystem.toLowerCase();

    if (normalized === BlockchainEcosystem.SOLANA) {
      return request.solanaPrivateKey;
    } else if (normalized === BlockchainEcosystem.BITCOIN) {
      return request.bitcoinPrivateKey;
    } else if (normalized === BlockchainEcosystem.TRON) {
      return request.tronPrivateKey;
    } else {
      // EVM and others use standard privateKey
      return request.privateKey;
    }
  }

  /**
   * Build success response with round-trip details
   */
  private buildSuccessResponse(
    request: UniversalSwapRequestDto,
    leg1Result: UniversalResponse<ExecutionData>,
    leg2Result: UniversalResponse<ExecutionData>,
    leg1Amount: { actual: string; estimated: string; confirmations: number },
    leg2Amount: { actual: string; estimated: string; confirmations: number },
    context: RoundTripContext,
  ): UniversalResponse<ExecutionData> {
    const initialAmount = BigInt(context.initialAmount);
    const finalAmount = BigInt(leg2Amount.actual);
    const profitLoss = finalAmount - initialAmount;
    const profitLossBps = Number((profitLoss * BigInt(10000)) / initialAmount);

    const roundTripDetails: RoundTripDetails = {
      swap1: {
        txHash: context.leg1TxHash!,
        status: 'SUCCESS',
        inputToken: request.sellToken.symbol,
        outputToken: request.buyToken.symbol,
        inputAmount: context.initialAmount,
        outputAmount: leg1Amount.estimated,
        actualReceivedAmount: leg1Amount.actual,
        chainId: request.sellToken.chain.chainId,
        confirmations: leg1Amount.confirmations,
        completedAt: context.leg1EndTime!.toISOString(),
        gasUsed: leg1Result.data.route?.gasDetails?.gasCostWei,
      },
      swap2: {
        txHash: context.leg2TxHash!,
        status: 'SUCCESS',
        inputToken: request.buyToken.symbol,
        outputToken: request.finalOutputToken!.symbol,
        inputAmount: leg1Amount.actual,
        outputAmount: leg2Amount.estimated,
        actualReceivedAmount: leg2Amount.actual,
        chainId: request.finalOutputToken!.chain.chainId,
        confirmations: leg2Amount.confirmations,
        completedAt: context.leg2EndTime!.toISOString(),
        gasUsed: leg2Result.data.route?.gasDetails?.gasCostWei,
      },
      profitability: {
        initialAmount: context.initialAmount,
        finalAmount: leg2Amount.actual,
        profitLoss: profitLoss.toString(),
        profitLossBps,
        totalGasCost: context.totalGasCost.toString(),
        netProfit: (profitLoss - context.totalGasCost).toString(),
        isProfitable: profitLoss > context.totalGasCost,
      },
      timing: {
        swap1StartedAt: context.leg1StartTime.toISOString(),
        swap1CompletedAt: context.leg1EndTime!.toISOString(),
        swap1DurationSeconds: Math.round(
          (context.leg1EndTime!.getTime() - context.leg1StartTime.getTime()) /
            1000,
        ),
        waitBetweenSwaps: Math.round(
          (context.leg2StartTime!.getTime() - context.leg1EndTime!.getTime()) /
            1000,
        ),
        swap2StartedAt: context.leg2StartTime!.toISOString(),
        swap2CompletedAt: context.leg2EndTime!.toISOString(),
        swap2DurationSeconds: Math.round(
          (context.leg2EndTime!.getTime() - context.leg2StartTime!.getTime()) /
            1000,
        ),
        totalDurationSeconds: Math.round(
          (context.leg2EndTime!.getTime() - context.leg1StartTime.getTime()) /
            1000,
        ),
      },
    };

    // Emit completion event
    this.transactionMonitor.emitRoundTripLeg2Complete(context.executionId, {
      txHash: context.leg2TxHash!,
      chainId: request.finalOutputToken!.chain.chainId,
      ecosystem: request.finalOutputToken!.chain.ecosystem,
      inputToken: request.buyToken.symbol,
      outputToken: request.finalOutputToken!.symbol,
      inputAmount: leg1Amount.actual,
      outputAmount: leg2Amount.estimated,
      actualReceivedAmount: leg2Amount.actual,
      confirmations: leg2Amount.confirmations,
      profitability: roundTripDetails.profitability,
    });

    return {
      success: true,
      data: {
        executionId: context.executionId,
        transactionHashes: [context.leg1TxHash!, context.leg2TxHash!],
        status: {
          overall: 'SUCCESS',
          currentStep: 2,
          totalSteps: 2,
          progressPercentage: 100,
        },
        steps: [
          {
            step: 1,
            action: `Swap ${request.sellToken.symbol} → ${request.buyToken.symbol}`,
            status: 'SUCCESS',
            txHash: context.leg1TxHash,
            chainId: request.sellToken.chain.chainId,
            provider: 'auto',
            estimatedTime: roundTripDetails.timing.swap1DurationSeconds,
            actualTime: roundTripDetails.timing.swap1DurationSeconds,
          },
          {
            step: 2,
            action: `Swap ${request.buyToken.symbol} → ${request.finalOutputToken!.symbol}`,
            status: 'SUCCESS',
            txHash: context.leg2TxHash,
            chainId: request.finalOutputToken!.chain.chainId,
            provider: 'auto',
            estimatedTime: roundTripDetails.timing.swap2DurationSeconds,
            actualTime: roundTripDetails.timing.swap2DurationSeconds,
          },
        ],
        estimatedCompletion: new Date().toISOString(),
        trackingUrls: [
          ...leg1Result.data.trackingUrls,
          ...leg2Result.data.trackingUrls,
        ],
        roundTripDetails,
      } as ExecutionData,
      metadata: {
        swapType: 'round-trip' as any,
        providerCategory: 'auto',
        estimatedTime: roundTripDetails.timing.totalDurationSeconds,
        complexity: 'complex',
        timestamp: new Date().toISOString(),
        executionId: context.executionId,
      },
    };
  }

  /**
   * Build partial failure response (requirement #7)
   */
  private buildPartialFailureResponse(
    request: UniversalSwapRequestDto,
    leg1Result: UniversalResponse<ExecutionData>,
    leg1Amount: { actual: string; estimated: string; confirmations: number },
    leg2Error: Error,
    context: RoundTripContext,
  ): UniversalResponse<ExecutionData> {
    const recoveryInstructions =
      `First swap completed successfully. You now hold ${leg1Amount.actual} ${request.buyToken.symbol} ` +
      `on ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId}. ` +
      `To complete the round-trip manually, retry via: POST /universal-swap/round-trip/retry/${context.executionId}`;

    // Emit partial failure event
    this.transactionMonitor.emitRoundTripPartialFailure(context.executionId, {
      swap1: {
        txHash: context.leg1TxHash!,
        status: 'SUCCESS',
        outputAmount: leg1Amount.estimated,
        actualReceivedAmount: leg1Amount.actual,
      },
      swap2: {
        txHash: context.leg2TxHash,
        status: 'FAILED',
        error: leg2Error.message,
        reason: leg2Error.message,
      },
      recoveryInstructions,
    });

    const roundTripDetails: RoundTripDetails = {
      swap1: {
        txHash: context.leg1TxHash!,
        status: 'SUCCESS',
        inputToken: request.sellToken.symbol,
        outputToken: request.buyToken.symbol,
        inputAmount: context.initialAmount,
        outputAmount: leg1Amount.estimated,
        actualReceivedAmount: leg1Amount.actual,
        chainId: request.sellToken.chain.chainId,
        confirmations: leg1Amount.confirmations,
        completedAt: context.leg1EndTime!.toISOString(),
        gasUsed: leg1Result.data.route?.gasDetails?.gasCostWei,
      },
      swap2: {
        txHash: context.leg2TxHash,
        status: 'FAILED',
        inputToken: request.buyToken.symbol,
        outputToken: request.finalOutputToken!.symbol,
        inputAmount: leg1Amount.actual,
        chainId: request.finalOutputToken!.chain.chainId,
        error: {
          code: 'LEG_2_EXECUTION_FAILED',
          message: leg2Error.message,
          recoverable: true,
          recoverySuggestion: recoveryInstructions,
        },
      },
      profitability: {
        initialAmount: context.initialAmount,
        finalAmount: '0',
        profitLoss: `-${context.initialAmount}`,
        profitLossBps: -10000,
        totalGasCost: context.totalGasCost.toString(),
        netProfit: `-${(BigInt(context.initialAmount) + context.totalGasCost).toString()}`,
        isProfitable: false,
      },
      timing: {
        swap1StartedAt: context.leg1StartTime.toISOString(),
        swap1CompletedAt: context.leg1EndTime!.toISOString(),
        swap1DurationSeconds: Math.round(
          (context.leg1EndTime!.getTime() - context.leg1StartTime.getTime()) /
            1000,
        ),
        waitBetweenSwaps: context.leg2StartTime
          ? Math.round(
              (context.leg2StartTime.getTime() -
                context.leg1EndTime!.getTime()) /
                1000,
            )
          : 0,
        swap2StartedAt: context.leg2StartTime?.toISOString(),
        totalDurationSeconds: Math.round(
          (new Date().getTime() - context.leg1StartTime.getTime()) / 1000,
        ),
      },
    };

    return {
      success: false,
      data: {
        executionId: context.executionId,
        transactionHashes: [context.leg1TxHash!],
        status: {
          overall: 'PARTIAL',
          currentStep: 1,
          totalSteps: 2,
          progressPercentage: 50,
        },
        steps: [
          {
            step: 1,
            action: `Swap ${request.sellToken.symbol} → ${request.buyToken.symbol}`,
            status: 'SUCCESS',
            txHash: context.leg1TxHash,
            chainId: request.sellToken.chain.chainId,
            provider: 'auto',
            estimatedTime: roundTripDetails.timing.swap1DurationSeconds,
            actualTime: roundTripDetails.timing.swap1DurationSeconds,
          },
          {
            step: 2,
            action: `Swap ${request.buyToken.symbol} → ${request.finalOutputToken!.symbol}`,
            status: 'FAILED',
            chainId: request.finalOutputToken!.chain.chainId,
            provider: 'auto',
            estimatedTime: 30,
            error: {
              code: 'LEG_2_EXECUTION_FAILED',
              message: leg2Error.message,
              recoverable: true,
            },
          },
        ],
        estimatedCompletion: new Date().toISOString(),
        trackingUrls: leg1Result.data.trackingUrls,
        roundTripDetails,
      } as ExecutionData,
      metadata: {
        swapType: 'round-trip' as any,
        providerCategory: 'auto',
        estimatedTime: roundTripDetails.timing.totalDurationSeconds,
        complexity: 'complex',
        timestamp: new Date().toISOString(),
        executionId: context.executionId,
      },
      error: {
        code: 'ROUND_TRIP_PARTIAL_FAILURE',
        message: `First swap succeeded, second swap failed: ${leg2Error.message}`,
        details: {
          leg1Success: true,
          leg1Amount: leg1Amount.actual,
          leg2Error: leg2Error.message,
          recoveryInstructions,
        },
      },
    };
  }

  /**
   * Build profitability abort response
   */
  private buildProfitabilityAbortResponse(
    request: UniversalSwapRequestDto,
    leg1Result: UniversalResponse<ExecutionData>,
    leg1Amount: { actual: string; estimated: string; confirmations: number },
    context: RoundTripContext,
  ): UniversalResponse<ExecutionData> {
    // Implementation similar to partial failure but with different reason
    throw new Error('Profitability threshold not met, aborting second swap');
  }
}
