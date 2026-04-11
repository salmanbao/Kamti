import { Injectable } from '@nestjs/common';
import { formatUnits, Address, Hex } from 'viem';
import { BaseSwapExecutor } from './base-swap-executor';
import { ExecutionContext } from '../ports/swap-executor.interface';
import { RouteQuote, SwapQuote } from '@swap/models/ports';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { ApprovalService } from '@swap/services/blockchain/approval/approval.service';
import { GasEstimationTrackerService } from '../gas-estimation-tracker.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { isNativeToken } from '@shared/utils/chain.utils';
import { OdosService } from '@swap/services/providers/evm-aggregators/odos.service';
import { AggregatorManagerService } from '../../aggregation/aggregator-manager.service';
import { SwapRequest } from '@swap/models/swap-request.model';
import { GasEstimationService } from '../gas/gas-estimation.service';
import { GaslessTransactionService } from '@swap/services/blockchain/gasless/gasless-transaction.service';
import { EcosystemFeeCalculatorFactory } from '../fee-calculators/ecosystem-fee-calculator.factory';

/**
 * EVM Swap Executor for executing on-chain EVM swaps via 0x, Odos, 1inch, etc.
 *
 * Execution Flow:
 * 1. Validate route and extract transaction data from cached quote
 * 2. Check if approval is needed (for non-native tokens)
 * 3. Execute approval if needed
 * 4. Build transaction with proper gas estimation
 * 5. Send transaction to blockchain
 * 6. Wait for confirmation (12 blocks for EVM)
 *
 * Design Patterns:
 * - Strategy Pattern: Implements ISwapExecutor interface
 * - Template Method: Extends BaseSwapExecutor with EVM-specific logic
 * - Dependency Injection: Uses WalletService, ApprovalService, OdosService
 */
@Injectable()
export class EvmSwapExecutor extends BaseSwapExecutor {
  constructor(
    private readonly walletService: WalletService,
    private readonly approvalService: ApprovalService,
    private readonly odosService: OdosService,
    private readonly gasTracker: GasEstimationTrackerService,
    protected readonly winstonLogger: WinstonLoggerService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly gaslessService: GaslessTransactionService,
    gasEstimationService: GasEstimationService,
    feeCalculatorFactory: EcosystemFeeCalculatorFactory,
  ) {
    super(
      winstonLogger,
      'EvmSwapExecutor',
      gasEstimationService,
      feeCalculatorFactory,
    );
  }

  /**
   * Identify this executor
   */
  getName(): string {
    return 'EVM Swap Executor';
  }

  /**
   * Check if this executor can handle the given route
   * EVM executor handles routes where first step is an EVM chain (chainId < 1000000)
   */
  canExecute(route: RouteQuote): boolean {
    if (!route.steps || route.steps.length === 0) {
      return false;
    }

    const firstStep = route.steps[0];

    // EVM chains typically have chainId < 1000000
    // Solana: 1399811149, Bitcoin/Native L1: string identifiers
    return typeof firstStep.chainId === 'number' && firstStep.chainId < 1000000;
  }

  /**
   * EVM-specific validation
   */
  protected async validateSpecific(
    context: ExecutionContext,
  ): Promise<string[]> {
    const errors: string[] = [];

    try {
      const route = context.request.route;
      this.logger.log('Starting EVM executor validation', {
        routeId: route.routeId,
        stepsCount: route.steps?.length || 0,
      });

      // Ensure Odos transactions are assembled if providerRef only has pathId
      this.logger.debug('Checking if Odos transaction assembly is needed');
      await this.ensureOdosAssembledIfNeeded(context);

      // Validate that providerRef exists (contains SwapQuote from 0x/Odos)
      if (!route.providerRef || typeof route.providerRef !== 'object') {
        errors.push('Missing provider reference data in route');
        this.logger.error('Missing provider reference in route', {
          routeId: route.routeId,
          hasProviderRef: !!route.providerRef,
        });
        return errors;
      }

      const swapQuote = route.providerRef as SwapQuote;
      this.logger.debug('Swap quote details', {
        aggregator: swapQuote.aggregator,
        sellToken: swapQuote.sellToken,
        buyToken: swapQuote.buyToken,
        sellAmount: swapQuote.sellAmount,
        buyAmount: swapQuote.buyAmount,
        to: swapQuote.to,
        hasData: !!swapQuote.data,
        dataLength: swapQuote.data?.length || 0,
        hasGasEstimate: !!(swapQuote.gas || swapQuote.estimatedGas),
      });

      // Validate required transaction fields
      this.logger.debug('Validating transaction fields');
      if (!swapQuote.to) {
        errors.push('Missing "to" address in swap quote');
        this.logger.error('Missing transaction destination address', {
          aggregator: swapQuote.aggregator,
        });
      }

      if (!swapQuote.data) {
        errors.push('Missing transaction "data" in swap quote');
        this.logger.error('Missing transaction data', {
          aggregator: swapQuote.aggregator,
        });
      }

      // Validate gas estimation
      if (!swapQuote.gas && !swapQuote.estimatedGas) {
        this.logger.warn(
          'No gas estimation provided in quote - will use default during execution',
          {
            aggregator: swapQuote.aggregator,
          },
        );
      } else {
        this.logger.debug('Gas estimation present', {
          gas: swapQuote.gas || swapQuote.estimatedGas,
          aggregator: swapQuote.aggregator,
        });
      }

      // Validate sell/buy amounts
      if (!swapQuote.sellAmount || swapQuote.sellAmount === '0') {
        errors.push('Invalid sell amount in swap quote');
        this.logger.error(` Invalid sell amount: ${swapQuote.sellAmount}`);
      }

      if (!swapQuote.buyAmount || swapQuote.buyAmount === '0') {
        errors.push('Invalid buy amount in swap quote');
        this.logger.error(` Invalid buy amount: ${swapQuote.buyAmount}`);
      }

      // CRITICAL: Quote Expiry Validation
      this.logger.debug('Validating quote expiry');
      if (swapQuote.timestamp) {
        const quoteAge = Date.now() - swapQuote.timestamp;
        const aggregator = swapQuote.aggregator;

        // Odos: 55 second max (5s buffer before 60s API expiry)
        // 0x: 60 second max
        const maxAge = aggregator === 'odos' ? 55000 : 60000;
        const ageInSeconds = Math.round(quoteAge / 1000);
        const maxAgeInSeconds = maxAge / 1000;

        this.logger.debug('Quote age check', {
          aggregator,
          ageInSeconds,
          maxAgeInSeconds,
          agePercent: Math.round((quoteAge / maxAge) * 100),
        });

        if (quoteAge > maxAge) {
          errors.push(
            `Quote expired: ${ageInSeconds}s old (max ${maxAgeInSeconds}s for ${aggregator})`,
          );
          this.logger.error('Quote expired - too old for execution', {
            aggregator,
            quoteAgeMs: quoteAge,
            maxAgeMs: maxAge,
            ageInSeconds,
            maxAgeInSeconds,
          });
        } else if (quoteAge > maxAge * 0.8) {
          // Warn if quote is getting close to expiry (80% of max age)
          this.logger.warn('Quote approaching expiry', {
            aggregator,
            ageInSeconds,
            maxAgeInSeconds,
            remainingSeconds: maxAgeInSeconds - ageInSeconds,
          });
        } else {
          this.logger.debug('Quote age acceptable', {
            aggregator,
            ageInSeconds,
            maxAgeInSeconds,
          });
        }
      } else {
        this.logger.warn('No timestamp on quote - cannot validate expiry', {
          aggregator: swapQuote.aggregator,
        });
      }

      // CRITICAL: Liquidity Validation (0x specific)
      if (swapQuote.liquidityAvailable === false) {
        errors.push('No liquidity available for this trade according to 0x');
        this.logger.error(
          'Liquidity check failed - execution will likely fail',
          {
            aggregator: swapQuote.aggregator,
            sellToken: swapQuote.sellToken,
            buyToken: swapQuote.buyToken,
          },
        );
      }

      // CRITICAL: Issues Validation (0x specific)
      if (swapQuote.issues) {
        // Handle array format: ['INSUFFICIENT_LIQUIDITY', 'INVALID_SOURCES']
        if (Array.isArray(swapQuote.issues)) {
          const criticalIssues = swapQuote.issues.filter(
            (issue) =>
              issue === 'INSUFFICIENT_LIQUIDITY' || issue === 'INVALID_SOURCES',
          );

          if (criticalIssues.length > 0) {
            errors.push(
              `Critical liquidity issues: ${criticalIssues.join(', ')}`,
            );
            this.logger.error(' Critical issues detected', {
              issues: criticalIssues,
            });
          }

          // Log other issues as warnings
          const otherIssues = swapQuote.issues.filter(
            (issue) =>
              issue !== 'INSUFFICIENT_LIQUIDITY' && issue !== 'INVALID_SOURCES',
          );
          if (otherIssues.length > 0) {
            this.logger.warn('Non-critical issues detected', {
              issues: otherIssues,
            });
          }
        }
        // Handle object format: {balance: true, allowance: true, simulationIncomplete: true}
        else if (typeof swapQuote.issues === 'object') {
          const issueObj = swapQuote.issues;

          if (issueObj.balance) {
            this.logger.warn(
              ' Balance issue detected - user may have insufficient balance',
            );
          }

          if (issueObj.allowance) {
            this.logger.warn(
              ' Allowance issue detected - approval may be needed',
            );
          }

          if (issueObj.simulationIncomplete) {
            this.logger.warn(
              ' Simulation incomplete - execution may be unpredictable',
            );
          }
        }
      }

      // CRITICAL: Balance Validation
      this.logger.log(` Validating user balance...`);
      // Check if user has sufficient tokens to execute the swap
      const sellToken = swapQuote.sellToken;
      const sellAmount = swapQuote.sellAmount;
      const chainId = route.steps[0].chainId;
      const userWallet = context.request.userWallet;

      this.logger.log(
        ` Balance Check: ${sellToken} on chain ${chainId} for wallet ${userWallet}`,
      );

      // Skip balance check for native tokens (ETH, MATIC, BNB, etc.)
      // Native balance is checked implicitly when transaction is sent
      if (!isNativeToken(sellToken)) {
        try {
          this.logger.log(`Checking ERC20 token balance for ${sellToken}...`);

          const balanceInfo = await this.walletService.getBalance(
            chainId,
            userWallet,
            sellToken,
          );

          const userBalance = BigInt(balanceInfo.balance);
          const requiredAmount = BigInt(sellAmount);

          this.logger.log(
            ` Balance: ${balanceInfo.balance} (${balanceInfo.symbol}), Required: ${sellAmount}`,
          );

          if (userBalance < requiredAmount) {
            // Use token-aware decimals instead of hardcoded 18
            const tokenDecimals =
              typeof balanceInfo.decimals === 'number'
                ? balanceInfo.decimals
                : 18;
            let balanceFormatted: string;
            let requiredFormatted: string;

            try {
              balanceFormatted = Number(
                parseFloat(formatUnits(userBalance, tokenDecimals)),
              ).toFixed(6);
            } catch {
              balanceFormatted = (
                Number(userBalance) / Math.pow(10, tokenDecimals)
              ).toFixed(6);
            }

            try {
              requiredFormatted = Number(
                parseFloat(formatUnits(requiredAmount, tokenDecimals)),
              ).toFixed(6);
            } catch {
              requiredFormatted = (
                Number(requiredAmount) / Math.pow(10, tokenDecimals)
              ).toFixed(6);
            }

            errors.push(
              `Insufficient balance: have ${balanceFormatted} ${balanceInfo.symbol || 'tokens'}, need ${requiredFormatted}`,
            );

            this.logger.error(' Insufficient token balance', {
              token: sellToken,
              userBalance: balanceInfo.balance,
              requiredAmount: sellAmount,
              deficit: (requiredAmount - userBalance).toString(),
              symbol: balanceInfo.symbol,
            });
          } else {
            this.logger.log(
              ` Sufficient balance confirmed: ${balanceInfo.balance} ${balanceInfo.symbol}`,
            );
          }
        } catch (balanceError) {
          // Log error but don't fail validation - let the transaction attempt reveal the issue
          this.logger.warn(
            `Could not verify token balance: ${balanceError.message}`,
            {
              token: sellToken,
              chainId,
              wallet: userWallet,
            },
          );
        }
      } else {
        // Native token path: ensure user has enough native balance for value + gas (with margin)
        this.logger.log(
          `Checking native token balance (ETH/MATIC/BNB etc.)...`,
        );
        try {
          const chainId = route.steps[0].chainId;
          const userWallet = context.request.userWallet;

          // Check if swapFullBalance flag is set - if so, skip balance validation
          // because preExecute() will adjust the amount to account for gas fees
          const swapFullBalance = context.request.swapFullBalance || false;

          // Fetch native balance
          const nativeBalanceInfo = await this.walletService.getBalance(
            chainId,
            userWallet,
            undefined, // native
          );

          const nativeBalance = BigInt(nativeBalanceInfo.balance);
          this.logger.log(
            ` Native Balance: ${nativeBalanceInfo.balance} (${nativeBalanceInfo.symbol})`,
          );

          // Determine tx value: prefer quote.value; if missing and it's a native sell, fall back to sellAmount
          const txValue = BigInt(
            swapQuote.value && swapQuote.value !== '0'
              ? swapQuote.value
              : sellAmount || '0',
          );
          this.logger.log(
            ` Transaction Value: ${swapQuote.value}: ${sellAmount}: ${txValue.toString()}`,
          );

          if (swapFullBalance) {
            // For full balance swaps, skip balance validation - preExecute() will handle amount adjustment
            this.logger.log(
              ' Skipping balance validation for native token full balance swap - amount will be adjusted in preExecute()',
              {
                chainId,
                token: nativeBalanceInfo.symbol,
                balance: (
                  Number(nativeBalance) /
                  Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(4),
                requestedAmount: (
                  Number(txValue) / Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(4),
              },
            );
          } else {
            // Gas estimation inputs (best-effort)
            let gasLimit = (() => {
              const gl = swapQuote.gas || (swapQuote as any).estimatedGas;
              return gl ? BigInt(gl) : 0n;
            })();

            let maxFeePerGas = swapQuote.maxFeePerGas
              ? BigInt(swapQuote.maxFeePerGas)
              : undefined;
            let legacyGasPrice = swapQuote.gasPrice
              ? BigInt(swapQuote.gasPrice)
              : undefined;

            // If no gas limit, we'll use a conservative fallback ONLY for advisory logging; avoid failing validation on unknowns
            // Attempt on-the-fly gas estimation if gas limit missing
            if (gasLimit === 0n) {
              try {
                const estimated = await this.walletService.estimateGas(
                  chainId,
                  userWallet,
                  swapQuote.to,
                  swapQuote.data,
                  swapQuote.value && swapQuote.value !== '0'
                    ? swapQuote.value
                    : sellAmount,
                  'evm',
                );
                const est = BigInt(estimated);
                gasLimit = est > 0n ? est : 0n;
              } catch (e) {
                this.logger.warn(
                  `Could not estimate gas during validation: ${e.message}`,
                );
              }
            }

            // If fee pricing missing, attempt to estimate
            if (maxFeePerGas === undefined && legacyGasPrice === undefined) {
              try {
                const feeData = await this.walletService.estimateFees(
                  chainId,
                  'evm',
                );
                if (feeData.type === 'eip1559') {
                  maxFeePerGas = BigInt(feeData.maxFeePerGas);
                } else {
                  legacyGasPrice = BigInt(feeData.gasPrice);
                }
              } catch (e) {
                this.logger.warn(
                  `Could not estimate fee pricing during validation: ${e.message}`,
                );
              }
            }

            const hasGasPricing =
              gasLimit > 0n &&
              (maxFeePerGas !== undefined || legacyGasPrice !== undefined);

            // Check if this is a full balance scenario (balance equals requested amount)
            const isFullBalanceScenario = nativeBalance === txValue;

            // Always ensure user can cover the value being sent (unless full balance scenario)
            if (nativeBalance < txValue && !isFullBalanceScenario) {
              const have = (
                Number(nativeBalance) / Math.pow(10, nativeBalanceInfo.decimals)
              ).toFixed(6);
              const need = (
                Number(txValue) / Math.pow(10, nativeBalanceInfo.decimals)
              ).toFixed(6);
              errors.push(
                `Insufficient native balance to cover value: have ${have} ${nativeBalanceInfo.symbol}, need ${need}`,
              );
            }

            // If we have enough info, ensure user can also cover gas with a safety margin
            // Skip this check for full balance scenarios - preExecute() will adjust
            if (hasGasPricing && !isFullBalanceScenario) {
              const gasPriceToUse = maxFeePerGas ?? legacyGasPrice!; // prefer EIP-1559 maxFeePerGas
              const gasCost = gasLimit * gasPriceToUse;
              // Apply 20% safety margin
              const gasCostWithMargin = (gasCost * 12n) / 10n; // 1.2x

              // If native is being sent as value (or native sell), total requirement is value + gas
              const totalRequired = txValue + gasCostWithMargin;

              if (nativeBalance < totalRequired) {
                const have = (
                  Number(nativeBalance) /
                  Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(6);
                const need = (
                  Number(totalRequired) /
                  Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(6);
                const valueEth = (
                  Number(txValue) / Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(6);
                const gasEth = (
                  Number(gasCostWithMargin) /
                  Math.pow(10, nativeBalanceInfo.decimals)
                ).toFixed(6);

                errors.push(
                  `Insufficient native balance for value + gas: have ${have} ${nativeBalanceInfo.symbol}, need ~${need} (${valueEth} value + ~${gasEth} gas w/ margin)`,
                );

                this.logger.error(
                  ' Insufficient native balance for value + gas',
                  {
                    chainId,
                    wallet: userWallet,
                    nativeBalance: nativeBalanceInfo.balance,
                    txValue: txValue.toString(),
                    gasLimit: gasLimit.toString(),
                    gasPrice:
                      gasPriceToUse?.toString() ||
                      legacyGasPrice?.toString() ||
                      'unknown',
                    gasCost: gasCost.toString(),
                    gasCostWithMargin: gasCostWithMargin.toString(),
                    symbol: nativeBalanceInfo.symbol,
                  },
                );
              } else {
                this.logger.debug(
                  ' Native balance covers value + gas (with margin)',
                );
              }
            } else if (isFullBalanceScenario) {
              this.logger.log(
                ' Full balance swap detected - amount will be adjusted in preExecute()',
                {
                  chainId,
                  token: nativeBalanceInfo.symbol,
                  balance: (
                    Number(nativeBalance) /
                    Math.pow(10, nativeBalanceInfo.decimals)
                  ).toFixed(4),
                },
              );
            } else {
              this.logger.warn(
                'Native gas pricing incomplete in quote - skipped strict gas margin check',
              );
            }
          }
        } catch (nativeErr) {
          this.logger.warn(
            `Could not verify native balance/gas: ${nativeErr.message}`,
          );
        }
      }
    } catch (error) {
      errors.push(`EVM validation error: ${error.message}`);
      this.logger.error(` EVM validation error: ${error.message}`, error.stack);
    }

    if (errors.length > 0) {
      this.logger.error(
        ` EVM validation failed with ${errors.length} error(s): ${JSON.stringify(errors)}`,
      );
    } else {
      this.logger.log(` EVM validation passed successfully`);
    }

    return errors;
  }

  /**
   * Pre-execution setup for EVM swaps
   * Checks and handles token approvals if needed
   * Calls base preExecute first to handle native token amount adjustment
   */
  protected async preExecute(context: ExecutionContext): Promise<void> {
    // Call base preExecute first to handle native token balance adjustment
    await super.preExecute(context);

    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const chainId = this.getChainIdFromRoute(route) as number;

    this.logger.log(`🔧 EVM EXECUTOR - Starting pre-execution checks...`);
    this.logger.log(
      ` Chain ID: ${chainId}, Aggregator: ${swapQuote.aggregator}`,
    );

    // Assemble Odos tx on-the-fly if needed
    await this.ensureOdosAssembledIfNeeded(context);

    // HIGH PRIORITY: Price Impact Validation
    this.logger.log(` Checking price impact...`);
    if (swapQuote.priceImpact) {
      const priceImpact = parseFloat(swapQuote.priceImpact);

      if (!isNaN(priceImpact)) {
        this.logger.log(` Price Impact: ${priceImpact.toFixed(2)}%`);
        if (priceImpact > 10) {
          this.logger.error(
            `🚨 EXTREME PRICE IMPACT: ${priceImpact.toFixed(2)}% - User should confirm this trade!`,
            {
              aggregator: swapQuote.aggregator,
              sellToken: swapQuote.sellToken,
              buyToken: swapQuote.buyToken,
              sellAmount: swapQuote.sellAmount,
            },
          );
          // Consider requiring explicit user confirmation for >10% impact
        } else if (priceImpact > 5) {
          this.logger.warn(
            ` HIGH PRICE IMPACT: ${priceImpact.toFixed(2)}% - Significant slippage expected`,
            {
              aggregator: swapQuote.aggregator,
              priceImpact: `${priceImpact.toFixed(2)}%`,
            },
          );
        } else if (priceImpact > 1) {
          this.logger.log(
            `ℹ️ Moderate price impact: ${priceImpact.toFixed(2)}%`,
          );
        } else {
          this.logger.log(` Low price impact: ${priceImpact.toFixed(2)}%`);
        }
      }
    } else {
      this.logger.log(`ℹ️ No price impact data available`);
    }

    // Check if we need approval (skip for native tokens)
    this.logger.log(` Checking if token approval needed...`);
    const sellToken = swapQuote.sellToken;
    if (!sellToken || isNativeToken(sellToken)) {
      this.logger.log(' Native token detected, skipping approval check');
      return;
    }

    // Get spender address: prefer explicit allowanceTarget, else fallback to tx.to (assembled router)
    const spender = this.resolveApprovalSpender(route.providerRef as any);
    if (!spender) {
      this.logger.warn(
        ' No allowance target detected, assuming no approval needed',
      );
      return;
    }

    // Check current allowance
    const sellAmount = swapQuote.sellAmount;
    const owner = context.request.userWallet;

    this.logger.log(' Checking token approval status', {
      token: sellToken,
      owner,
      spender,
      amount: sellAmount,
    });

    const approvalStatus = await this.approvalService.getApprovalStatus(
      chainId,
      sellToken,
      owner,
      spender,
      sellAmount,
    );

    this.logger.log(
      ` Approval Status: ${JSON.stringify(approvalStatus, null, 2)}`,
    );

    if (approvalStatus.isApprovalNeeded) {
      this.logger.log(' Approval required, executing approval transaction...');

      // Execute approval
      const approvalTxHash = await this.walletService.executeApproval(
        chainId,
        context.request.privateKey,
        sellToken,
        spender,
        sellAmount,
      );

      this.logger.log(` Approval transaction sent: ${approvalTxHash}`);

      // Audit log: approval transaction
      this.logger.logTransaction({
        executionId: context.request.routeId,
        type: 'approve',
        userWallet: context.request.userWallet,
        sellToken,
        buyToken: 'N/A',
        sellAmount: sellAmount.toString(),
        chainId,
        txHash: approvalTxHash,
        status: 'pending',
        metadata: {
          spender,
          action: 'token_approval',
        },
      });

      // Wait for approval confirmation
      this.logger.log(`⏳ Waiting for approval confirmation (2 blocks)...`);
      await this.walletService.waitForTransactionConfirmation(
        chainId,
        approvalTxHash,
        2, // 2 confirmations for approval
      );

      this.logger.log(' Approval confirmed on-chain');

      // Audit log: approval confirmed
      this.logger.audit('APPROVAL_CONFIRMED', {
        executionId: context.request.routeId,
        userWallet: context.request.userWallet,
        sellToken,
        spender,
        amount: sellAmount.toString(),
        chainId,
        txHash: approvalTxHash,
        timestamp: new Date().toISOString(),
      });
    } else {
      this.logger.log(
        ' Sufficient allowance already granted, no approval needed',
      );
    }
  }

  /**
   * Build transaction data from cached swap quote
   */
  protected async buildTransaction(context: ExecutionContext): Promise<{
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  }> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;

    this.logger.log(
      `🔨 EVM EXECUTOR - Building transaction from swap quote...`,
    );

    // Assemble Odos tx on-the-fly if needed before building
    await this.ensureOdosAssembledIfNeeded(context);

    // Base transaction structure
    // For native token swaps with amount adjustment, use adjusted amount as value
    const isNativeTokenSwap = isNativeToken(swapQuote.sellToken || '');

    // CRITICAL: If we have an amount adjustment, use the quote's sellAmount/value as the transaction value
    // The transaction data (swapQuote.data) is built for the quote's sellAmount, so value MUST match
    // The refinement loop ensures the quote's sellAmount fits within balance limits
    let adjustedValue: string;
    if (context.request.amountAdjustment && isNativeTokenSwap) {
      // Use quote's sellAmount/value (the transaction.data is built for this amount)
      adjustedValue =
        swapQuote.sellAmount ||
        swapQuote.value ||
        context.request.amountAdjustment.adjustedAmount;

      this.logger.log('Using quote amount for native token transaction', {
        originalValue: context.request.amountAdjustment.originalAmount,
        quoteSellAmount: swapQuote.sellAmount,
        quoteValue: swapQuote.value,
        adjustedAmount: context.request.amountAdjustment.adjustedAmount,
        adjustedValue,
        gasCost: context.request.amountAdjustment.gasCost,
        reason: context.request.amountAdjustment.reason,
        note: 'Using quote sellAmount/value - refinement loop ensured it fits within balance',
      });
    } else {
      adjustedValue = swapQuote.value || '0';
    }

    // CRITICAL: Prioritize network-estimated gas limit over quote's gas limit
    // Priority order:
    // 1. amountAdjustment.gasLimit (network-estimated, already accurate, no margin needed)
    // 2. Fresh network estimation (most accurate for current transaction data)
    // 3. Quote's gas limit (fallback only, may be inaccurate placeholder)
    let gasLimit: string | undefined;

    if (context.request.amountAdjustment?.gasLimit) {
      // Use network-estimated gas limit from amount adjustment (raw network estimate, no margin needed)
      // Note: gasLimit is raw network estimate, gasCost includes 2% margin for amount adjustment
      gasLimit = context.request.amountAdjustment.gasLimit;
      this.logger.log(
        'Using network-estimated gas limit from amount adjustment',
        {
          gasLimit,
          source: 'amountAdjustment',
          note: 'Raw network estimate (no margin) - accurate for transaction execution',
        },
      );
    } else {
      // Try fresh network estimation with actual transaction data
      // Don't set gasLimit yet - will be set after estimation or fallback
      gasLimit = undefined;
    }

    const tx: any = {
      to: swapQuote.to,
      data: swapQuote.data,
      value: adjustedValue,
      gasLimit: gasLimit, // Network-estimated (if available), otherwise undefined for fallback
    };

    // CRITICAL: EIP-1559 Gas Support
    // Prefer aggregator-provided EIP-1559 values; if missing, estimate via WalletService
    this.logger.log(` Determining gas pricing strategy...`);
    if (swapQuote.maxFeePerGas && swapQuote.maxPriorityFeePerGas) {
      // Use EIP-1559 gas pricing
      tx.maxFeePerGas = swapQuote.maxFeePerGas;
      tx.maxPriorityFeePerGas = swapQuote.maxPriorityFeePerGas;

      this.logger.log(' Using EIP-1559 gas pricing from quote', {
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      });
    } else if (swapQuote.gasPrice) {
      // Convert legacy gas pricing to EIP-1559 for better UX and priority control
      const chainId = this.getChainIdFromRoute(route) as number;
      const shouldUseEIP1559 = await this.shouldUseEIP1559(chainId);

      if (shouldUseEIP1559) {
        try {
          const eip1559Fees = await this.convertLegacyToEIP1559(
            swapQuote.gasPrice,
            chainId,
          );
          tx.maxFeePerGas = eip1559Fees.maxFeePerGas;
          tx.maxPriorityFeePerGas = eip1559Fees.maxPriorityFeePerGas;

          this.logger.log(' Converted legacy gasPrice to EIP-1559', {
            legacyGasPrice: swapQuote.gasPrice,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          });
        } catch (e) {
          // Fallback to legacy if conversion fails
          tx.gasPrice = swapQuote.gasPrice;
          this.logger.warn(
            ` Failed to convert to EIP-1559, using legacy: ${e.message}`,
          );
        }
      } else {
        // Use legacy gas pricing for non-EIP-1559 chains
        tx.gasPrice = swapQuote.gasPrice;

        this.logger.log(
          ' Using legacy gas pricing from quote (chain does not support EIP-1559)',
          {
            gasPrice: tx.gasPrice,
          },
        );
      }
    } else {
      // No gas pricing from aggregator; try to estimate
      this.logger.log(
        ` No gas pricing in quote, estimating via wallet service...`,
      );
      try {
        const chainId = this.getChainIdFromRoute(route) as number;
        const feeData = await this.walletService.estimateFees(chainId, 'evm');
        if (feeData.type === 'eip1559') {
          tx.maxFeePerGas = feeData.maxFeePerGas;
          tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
          this.logger.log(
            ' Estimated EIP-1559 fees via wallet service',
            feeData,
          );
        } else {
          tx.gasPrice = feeData.gasPrice;
          this.logger.log(
            ' Estimated legacy gasPrice via wallet service',
            feeData,
          );
        }
      } catch (e) {
        this.logger.warn(
          ` No gas pricing available and fee estimation failed: ${e.message}`,
        );
      }
    }

    // Validate extracted data
    if (!tx.to) {
      throw new Error('Missing "to" address in transaction');
    }

    if (!tx.data) {
      throw new Error('Missing transaction data');
    }

    // Gas limit determination priority (enforced):
    // 1. amountAdjustment.gasLimit (network-estimated, already accurate, no margin needed) - already set above
    // 2. Fresh network estimation (most accurate for current transaction data)
    // 3. Quote's gas limit (fallback only, may be inaccurate placeholder)
    if (!tx.gasLimit) {
      // Try fresh network estimation with actual transaction data
      this.logger.log(`Estimating gas limit via network...`);
      try {
        const chainId = this.getChainIdFromRoute(route) as number;
        const from = context.request.userWallet;
        const estimated = await this.walletService.estimateGas(
          chainId,
          from,
          tx.to,
          tx.data,
          tx.value,
          'evm',
        );
        const est = BigInt(estimated);
        // Use 2% margin (consistent with estimateTransactionCost)
        // Network estimation is already accurate, we just need a small buffer
        const withMargin = (est * 102n) / 100n; // 1.02x (2% margin)
        tx.gasLimit = withMargin.toString();
        this.logger.log('Using fresh network-estimated gas limit', {
          estimated: estimated.toString(),
          gasLimit: tx.gasLimit,
          margin: '2%',
          source: 'network-estimation',
        });
      } catch (e) {
        // Network estimation failed - use quote's gas limit as fallback
        const quoteGasLimit = swapQuote.gas || swapQuote.estimatedGas;
        if (quoteGasLimit) {
          // CRITICAL: Only cap obviously wrong values (like 5M+) that are likely placeholders or bugs
          // On-chain swaps typically need 200k-400k gas, but complex swaps may need more
          // Better to use quote's estimate (even if high) than hardcoded fallback that's too low
          const MAX_ABSOLUTE_GAS_LIMIT = 5000000; // Absolute maximum to prevent obviously wrong values
          const quoteGasLimitNum = parseInt(quoteGasLimit);
          if (quoteGasLimitNum > MAX_ABSOLUTE_GAS_LIMIT) {
            // Only reject if it's absurdly high (likely a bug/placeholder)
            tx.gasLimit = '300000';
            this.logger.warn(
              'Quote gas limit exceeds absolute maximum, using conservative fallback',
              {
                quoteGasLimit,
                maxAbsoluteGasLimit: MAX_ABSOLUTE_GAS_LIMIT,
                fallbackGasLimit: tx.gasLimit,
                note: 'Quote gas limit is absurdly high (likely bug/placeholder), using conservative estimate',
              },
            );
          } else {
            // Use quote's gas limit (even if it's higher than typical, as complex swaps may need more)
            tx.gasLimit = quoteGasLimit;
            this.logger.warn(
              'Using quote gas limit as fallback (network estimation failed)',
              {
                gasLimit: tx.gasLimit,
                source: 'quote',
                error: e.message,
                note: 'Network estimation failed, using quote-provided gas limit',
              },
            );
          }
        } else {
          // Last resort: conservative default
          tx.gasLimit = '300000'; // Reduced from 500000 to be more conservative
          this.logger.warn(
            'Using conservative default gas limit (all estimation methods failed)',
            {
              gasLimit: tx.gasLimit,
              source: 'conservative-default',
              error: e.message,
              note: 'Network estimation and quote gas limit both unavailable',
            },
          );
        }
      }
    } else {
      // Log source of gas limit (already set from amountAdjustment)
      this.logger.log(
        `Using network-estimated gas limit from amount adjustment: ${tx.gasLimit} (no additional margin)`,
      );
    }

    this.logger.log(' Transaction built successfully', {
      to: tx.to,
      value: tx.value,
      gasLimit: tx.gasLimit,
      gasType: tx.maxFeePerGas ? 'EIP-1559' : 'Legacy',
      dataLength: tx.data.length,
    });

    this.logger.log(` BUILT TRANSACTION: ${JSON.stringify(tx, null, 2)}`);

    return tx;
  }

  /**
   * For Odos routes that may carry only a pathId in providerRef, assemble the final transaction.
   * Updates route.providerRef in-place with assembled tx fields and sets allowanceTarget to router "to".
   */
  private async ensureOdosAssembledIfNeeded(
    context: ExecutionContext,
  ): Promise<void> {
    try {
      const route = context.request.route;
      const pref: any = route.providerRef;
      if (!pref || typeof pref !== 'object') return;

      const isOdos = pref.aggregator === 'odos' || pref.aggregator === 'ODOS';
      const missingTx = !pref.to || !pref.data;
      const hasPathId = !!pref.pathId;

      if (isOdos && missingTx && hasPathId) {
        this.logger.debug(
          'Assembling Odos transaction in executor (assemble-if-needed)',
          {
            pathId: pref.pathId,
          },
        );

        // We may not have original request in execution context; pass timestamp if available for basic freshness validation
        const assembled = await this.odosService.assembleTransactionPublic(
          pref.pathId,
          context.request.userWallet,
          pref.timestamp, // may be undefined; method handles it
        );

        const tx = assembled.transaction;
        if (!tx?.to || !tx?.data) {
          throw new Error('Odos assemble returned invalid transaction');
        }

        // Update providerRef so downstream steps (approval/build/send) see the final tx
        route.providerRef = {
          ...(route.providerRef as any),
          to: tx.to,
          data: tx.data,
          value: tx.value || '0',
          gas: tx.gas || tx.gasLimit,
          gasPrice: tx.gasPrice || tx.maxFeePerGas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          allowanceTarget: tx.to, // ensure approvals target the router "to"
          timestamp: Date.now(),
        };

        this.logger.debug(
          'Odos transaction assembled and providerRef updated',
          {
            to: tx.to,
          },
        );
      }
    } catch (e) {
      this.logger.error(
        `Failed to assemble Odos transaction in executor: ${e.message}`,
      );
      // Let validation or subsequent steps surface any missing fields
    }
  }

  /**
   * Resolve approval spender address, preferring explicit allowanceTarget.
   * Falls back to transaction "to" (assembled router) when allowanceTarget is absent.
   */
  private resolveApprovalSpender(quote: any): string | undefined {
    if (!quote) return undefined;
    if (quote.allowanceTarget) return quote.allowanceTarget;
    if (quote.to) return quote.to;
    return undefined;
  }

  /**
   * Send transaction to EVM blockchain using WalletService
   */
  protected async sendTransaction(
    txData: {
      to: string;
      data: string;
      value: string;
      gasLimit?: string;
      gasPrice?: string;
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
    },
    context: ExecutionContext,
  ): Promise<string> {
    const chainId = this.getChainIdFromRoute(context.request.route) as number;
    const privateKey = context.request.privateKey;
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;

    // Check if gasless transaction requested (Requirement #11)
    const gaslessRequested = (context.request as any).gasless === true;

    if (gaslessRequested) {
      this.logger.log(`🔐 Gasless transaction requested, checking support...`);

      const gaslessSupport = this.gaslessService.canExecuteGasless(
        chainId,
        'evm',
      );

      if (gaslessSupport.supported) {
        this.logger.log(`✅ Gasless transaction supported on chain ${chainId}`);

        try {
          // Execute via Pimlico bundler (Requirement #13: Skip gas estimation)
          const gaslessResult =
            await this.gaslessService.executeGaslessTransaction(
              {
                to: txData.to as Address,
                data: txData.data as Hex,
                value: BigInt(txData.value || '0'),
              },
              chainId,
              privateKey,
            );

          this.logger.log(
            `✅ Gasless UserOperation submitted: ${gaslessResult.userOpHash}`,
          );

          // Wait for UserOperation to be mined
          const receipt = await this.gaslessService.waitForUserOperationReceipt(
            gaslessResult.userOpHash,
            chainId,
            60000, // 60 second timeout
          );

          if (receipt.success && receipt.transactionHash) {
            this.logger.log(
              `✅ Gasless transaction mined: ${receipt.transactionHash}`,
            );

            // Audit log: gasless transaction sent
            const firstStep = route.steps?.[0];
            this.logger.audit('GASLESS_TRANSACTION_SENT', {
              executionId: context.request.routeId,
              userWallet: context.request.userWallet,
              userOpHash: gaslessResult.userOpHash,
              txHash: receipt.transactionHash,
              chainId,
              aggregator: swapQuote.aggregator,
              gasSponsored: true,
              timestamp: new Date().toISOString(),
            });

            return receipt.transactionHash;
          } else {
            throw new Error('Gasless transaction failed to mine');
          }
        } catch (gaslessError) {
          this.logger.error(
            `❌ Gasless transaction failed: ${gaslessError.message}`,
          );
          this.logger.log('Falling back to regular transaction...');
          // Fall through to regular transaction execution
        }
      } else {
        this.logger.warn(`⚠️ Gasless not supported: ${gaslessSupport.reason}`);
        this.logger.log('Executing as regular transaction...');
      }
    }

    this.logger.log(` EVM EXECUTOR - Sending transaction to blockchain...`);
    this.logger.log(' Transaction details:', {
      chainId,
      aggregator: swapQuote.aggregator,
      to: txData.to,
      value: txData.value,
      gasLimit: txData.gasLimit,
      gasType: txData.maxFeePerGas ? 'EIP-1559' : 'Legacy',
      gasless: gaslessRequested,
    });

    // Use retry logic from base class with aggregator-specific error handling
    try {
      this.logger.log(`⏳ Executing swap transaction (with retry logic)...`);
      const txHash = await this.retryWithBackoff(
        async () => {
          return await this.walletService.executeSwap(
            chainId,
            privateKey,
            txData.to,
            txData.data,
            txData.value,
            txData.gasLimit,
            'evm',
          );
        },
        3,
        2000,
      ); // 3 retries, 2 second base delay

      this.logger.log(` Transaction sent successfully! Hash: ${txHash}`);

      // Audit log: transaction sent
      const firstStep = route.steps?.[0];
      this.logger.audit('SWAP_TRANSACTION_SENT', {
        executionId: context.request.routeId,
        userWallet: context.request.userWallet,
        txHash,
        chainId,
        aggregator: swapQuote.aggregator,
        sellToken: firstStep?.details?.sellToken || 'from_route',
        buyToken: firstStep?.details?.buyToken || 'from_route',
        value: txData.value,
        gasLimit: txData.gasLimit,
        gasType: txData.maxFeePerGas ? 'EIP-1559' : 'Legacy',
        timestamp: new Date().toISOString(),
      });

      return txHash;
    } catch (error) {
      // MEDIUM PRIORITY: Aggregator-specific error handling
      const aggregator = swapQuote.aggregator;
      const quoteAge = swapQuote.timestamp
        ? Date.now() - swapQuote.timestamp
        : 'unknown';

      this.logger.error(` ${aggregator} transaction failed`, {
        aggregator,
        quoteAge:
          typeof quoteAge === 'number'
            ? `${Math.round(quoteAge / 1000)}s`
            : quoteAge,
        error: error.message,
        issues: swapQuote.issues,
        liquidityAvailable: swapQuote.liquidityAvailable,
      });

      // Provide aggregator-specific guidance
      if (aggregator === 'odos' && error.message.includes('pathId')) {
        throw new Error(
          `Odos transaction failed: Quote expired (pathId invalid). Please request a fresh quote.`,
        );
      } else if (aggregator === '0x' && swapQuote.issues) {
        throw new Error(
          `0x transaction failed: ${error.message}. Issues detected: ${JSON.stringify(swapQuote.issues)}`,
        );
      }

      throw new Error(`${aggregator} execution failed: ${error.message}`);
    }
  }

  /**
   * Wait for EVM transaction confirmation
   */
  async waitForConfirmation(
    transactionHash: string,
    chainId: number | string,
    requiredConfirmations: number = 3,
  ): Promise<any> {
    this.logger.log(
      `⏳ EVM EXECUTOR - Waiting for ${requiredConfirmations} confirmations on chain ${chainId}...`,
    );
    this.logger.log(` Transaction Hash: ${transactionHash}`);

    const receipt = await this.walletService.waitForTransactionConfirmation(
      chainId,
      transactionHash,
      requiredConfirmations,
      'evm',
    );

    this.logger.log(
      ` Transaction confirmed! Receipt: ${JSON.stringify(
        {
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed?.toString(),
          status: receipt.status,
        },
        null,
        2,
      )}`,
    );

    return receipt;
  }

  /**
   * Get required confirmations for EVM chains
   * 3 confirmations for faster execution while maintaining security
   */
  protected getRequiredConfirmations(chainId?: number | string): number {
    // TODO: Determine based on chainId (mainnet vs testnet)
    return 3;
  }

  /**
   * Post-execution processing
   */
  protected async postExecute(
    context: ExecutionContext,
    txHash: string,
    receipt: any,
  ): Promise<void> {
    this.logger.log(` EVM EXECUTOR - Post-execution processing...`);

    // Log execution metrics
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const chainId = this.getChainIdFromRoute(route) as number;

    // Calculate actual execution time
    const executionTime = swapQuote.timestamp
      ? Date.now() - swapQuote.timestamp
      : undefined;

    // Record gas estimation accuracy for future improvements
    if (swapQuote.gas && receipt.gasUsed) {
      this.gasTracker.recordGasUsage({
        aggregator: swapQuote.aggregator || 'unknown',
        chainId,
        estimatedGas: swapQuote.gas,
        actualGasUsed: receipt.gasUsed.toString(),
        txHash,
      });

      // Log gas estimation comparison
      const estimated = BigInt(swapQuote.gas);
      const actual = BigInt(receipt.gasUsed.toString());
      const accuracyPct = ((Number(actual) / Number(estimated)) * 100).toFixed(
        1,
      );
      const savings = estimated > actual ? Number(estimated - actual) : 0;

      this.logger.log(
        `⛽ Gas Estimation vs Actual: ${estimated} -> ${actual} (${accuracyPct}% accurate, saved ${savings} gas)`,
      );
    }

    const metrics = {
      aggregator: swapQuote.aggregator,
      sellToken: swapQuote.sellToken,
      buyToken: swapQuote.buyToken,
      sellAmount: swapQuote.sellAmount,
      buyAmount: swapQuote.buyAmount,
      priceImpact: swapQuote.priceImpact
        ? `${swapQuote.priceImpact}%`
        : undefined,
      estimatedGas: swapQuote.gas,
      actualGasUsed: receipt.gasUsed?.toString(),
      gasAccuracy:
        swapQuote.gas && receipt.gasUsed
          ? `${((Number(receipt.gasUsed.toString()) / Number(swapQuote.gas)) * 100).toFixed(1)}%`
          : undefined,
      blockNumber: receipt.blockNumber,
      txHash,
      executionTime: executionTime
        ? `${Math.round(executionTime / 1000)}s`
        : undefined,
      quoteAge: executionTime
        ? `${Math.round(executionTime / 1000)}s`
        : undefined,
    };

    this.logger.log(' EVM swap execution metrics', metrics);
    this.logger.log(
      ` FINAL EXECUTION METRICS: ${JSON.stringify(metrics, null, 2)}`,
    );

    // TODO: Update cache, emit events, etc.
  }

  /**
   * Check if a chain supports EIP-1559 (London upgrade)
   */
  private async shouldUseEIP1559(chainId: number): Promise<boolean> {
    // Chains that support EIP-1559
    const eip1559Chains = [
      1, // Ethereum Mainnet
      5, // Goerli (deprecated)
      11155111, // Sepolia
      137, // Polygon
      80002, // Polygon Amoy
      10, // Optimism
      11155420, // OP Sepolia
      42161, // Arbitrum One
      421614, // Arbitrum Sepolia
      8453, // Base
      84532, // Base Sepolia
      43114, // Avalanche C-Chain
      59144, // Linea
      534352, // Scroll
      324, // zkSync Era
    ];

    return eip1559Chains.includes(chainId);
  }

  /**
   * Convert legacy gasPrice to EIP-1559 format
   * Uses current base fee and adds reasonable priority fee
   */
  private async convertLegacyToEIP1559(
    legacyGasPrice: string,
    chainId: number,
  ): Promise<{ maxFeePerGas: string; maxPriorityFeePerGas: string }> {
    try {
      // Get current network fees to determine base fee
      const feeData = await this.walletService.estimateFees(chainId, 'evm');

      if (feeData.type === 'eip1559') {
        // Network provides EIP-1559 data, use it
        return {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        };
      }

      // Calculate EIP-1559 fees from legacy gasPrice
      const gasPrice = BigInt(legacyGasPrice);

      // Priority fee: 10% of legacy gas price (or 2 gwei minimum)
      const minPriorityFee = BigInt(2_000_000_000); // 2 gwei
      const priorityFee =
        gasPrice / 10n > minPriorityFee ? gasPrice / 10n : minPriorityFee;

      // Max fee: legacy gas price + 20% buffer for base fee fluctuations
      const maxFee = gasPrice + gasPrice / 5n;

      return {
        maxFeePerGas: maxFee.toString(),
        maxPriorityFeePerGas: priorityFee.toString(),
      };
    } catch (e) {
      this.logger.warn(`Failed to convert legacy to EIP-1559: ${e.message}`);
      throw e;
    }
  }

  /**
   * Get blockchain explorer URL for a transaction
   * Maps chainId to appropriate explorer (Etherscan, Polygonscan, etc.)
   */
  protected getExplorerUrl(chainId: number | string, txHash: string): string {
    const chainIdNum =
      typeof chainId === 'string' ? parseInt(chainId) : chainId;

    // Map of chainId to explorer base URL
    const explorerMap: Record<number, string> = {
      // Ethereum Mainnet
      1: 'https://etherscan.io',
      // Ethereum Testnets
      5: 'https://goerli.etherscan.io', // Goerli
      11155111: 'https://sepolia.etherscan.io', // Sepolia

      // Polygon
      137: 'https://polygonscan.com',
      80001: 'https://mumbai.polygonscan.com', // Mumbai testnet (deprecated)
      80002: 'https://amoy.polygonscan.com', // Amoy testnet

      // BSC (Binance Smart Chain)
      56: 'https://bscscan.com',
      97: 'https://testnet.bscscan.com',

      // Arbitrum
      42161: 'https://arbiscan.io',
      421614: 'https://sepolia.arbiscan.io', // Arbitrum Sepolia

      // Optimism
      10: 'https://optimistic.etherscan.io',
      11155420: 'https://sepolia-optimism.etherscan.io', // OP Sepolia

      // Avalanche
      43114: 'https://snowtrace.io',
      43113: 'https://testnet.snowtrace.io',

      // Base
      8453: 'https://basescan.org',
      84532: 'https://sepolia.basescan.org', // Base Sepolia

      // Fantom
      250: 'https://ftmscan.com',
      4002: 'https://testnet.ftmscan.com',

      // Gnosis Chain
      100: 'https://gnosisscan.io',

      // zkSync Era
      324: 'https://explorer.zksync.io',
      280: 'https://goerli.explorer.zksync.io',

      // Linea
      59144: 'https://lineascan.build',
      59140: 'https://goerli.lineascan.build',
    };

    const explorerBaseUrl = explorerMap[chainIdNum];

    if (!explorerBaseUrl) {
      this.logger.warn(`No explorer URL mapping for chainId ${chainId}`);
      return `https://etherscan.io/tx/${txHash}`; // Default to Etherscan
    }

    return `${explorerBaseUrl}/tx/${txHash}`;
  }

  /**
   * Estimate transaction cost (gas) for EVM swap
   * Delegates to GasEstimationService for centralized gas estimation logic
   */
  protected async estimateTransactionCost(context: ExecutionContext): Promise<{
    gasLimit: string;
    gasCost: string;
  }> {
    if (this.gasEstimationService) {
      return await this.gasEstimationService.estimateTransactionCost(
        context,
        'evm',
      );
    }
    // Fallback to legacy implementation if service is not available
    return await this.getConservativeGasEstimateFromRouteLegacy(context);
  }

  /**
   * Adjust swap amount by fetching new quote with adjusted amount
   */
  protected async adjustSwapAmount(
    context: ExecutionContext,
    adjustedAmount: string,
    gasCost: string,
  ): Promise<void> {
    const route = context.request.route;
    const swapQuote = route.providerRef as SwapQuote;
    const chainId = this.getChainIdFromRoute(route) as number;

    this.logger.log('Fetching new quote with adjusted amount', {
      originalAmount: swapQuote.sellAmount,
      adjustedAmount,
      chainId,
      sellToken: swapQuote.sellToken,
      buyToken: swapQuote.buyToken,
    });

    try {
      // Build swap request with adjusted amount
      const swapRequest: SwapRequest = {
        chainId,
        sellToken: swapQuote.sellToken,
        buyToken: swapQuote.buyToken,
        sellAmount: adjustedAmount,
        taker: context.request.userWallet,
        recipient: context.request.recipient || context.request.userWallet,
        slippagePercentage: context.request.slippageToleranceBps
          ? context.request.slippageToleranceBps / 100
          : undefined,
        deadline: context.request.deadline,
        aggregator: swapQuote.aggregator,
      };

      // Fetch new quote
      const newQuote = await this.aggregatorManager.getQuote(swapRequest);

      // CRITICAL: For native token swaps, ensure the value field matches the adjusted sellAmount
      // The transaction data is built with the new quote's sellAmount, so value must match
      if (isNativeToken(swapQuote.sellToken || '')) {
        if (newQuote.sellAmount && newQuote.value !== newQuote.sellAmount) {
          this.logger.log(
            'Updating value field to match adjusted sellAmount for native token',
            {
              oldValue: newQuote.value,
              newValue: newQuote.sellAmount,
              adjustedAmount,
              quoteSellAmount: newQuote.sellAmount,
            },
          );
          newQuote.value = newQuote.sellAmount;
        }

        // Validate that the new quote's sellAmount matches the requested adjustedAmount (within tolerance)
        // Some aggregators may round the amount, so we allow small differences
        const requestedAmount = BigInt(adjustedAmount);
        const quoteAmount = BigInt(newQuote.sellAmount || '0');
        const difference =
          requestedAmount > quoteAmount
            ? requestedAmount - quoteAmount
            : quoteAmount - requestedAmount;
        const differencePercent =
          requestedAmount > 0n
            ? (difference * BigInt(100)) / requestedAmount
            : BigInt(0);

        if (differencePercent > BigInt(1)) {
          // More than 1% difference
          this.logger.warn(
            'New quote sellAmount does not match requested adjusted amount',
            {
              requestedAdjustedAmount: adjustedAmount,
              quoteSellAmount: newQuote.sellAmount,
              difference: difference.toString(),
              differencePercent: differencePercent.toString() + '%',
            },
          );
        } else {
          this.logger.debug(
            'New quote sellAmount matches requested adjusted amount (within tolerance)',
            {
              requestedAdjustedAmount: adjustedAmount,
              quoteSellAmount: newQuote.sellAmount,
              difference: difference.toString(),
            },
          );
        }
      }

      // Update route with new quote data
      route.providerRef = newQuote;
      route.totalEstimatedOut =
        newQuote.buyAmount || newQuote.minBuyAmount || '0';
      route.minOutputAmount = newQuote.minBuyAmount;

      // Update routeId to reflect the new quote (add suffix)
      const originalRouteId = context.request.routeId;
      context.request.routeId = `${originalRouteId}_adjusted_${Date.now()}`;
      route.routeId = context.request.routeId;

      this.logger.log('Quote updated with adjusted amount', {
        newRouteId: context.request.routeId,
        newOutputAmount: route.totalEstimatedOut,
        newMinOutputAmount: route.minOutputAmount,
        newSellAmount: newQuote.sellAmount,
        newValue: newQuote.value,
      });
    } catch (error) {
      this.logger.error('Failed to fetch new quote with adjusted amount', {
        error: error.message,
        stack: error.stack,
      });
      throw new Error(
        `Failed to fetch new quote with adjusted amount: ${error.message}`,
      );
    }
  }

  /**
   * Get native token balance for a wallet
   */
  protected async getNativeTokenBalance(
    chainId: number | string,
    walletAddress: string,
  ): Promise<string> {
    try {
      // Pass undefined for native token (not 'native' string) - walletService handles it correctly
      const balanceInfo = await this.walletService.getBalance(
        Number(chainId),
        walletAddress,
        undefined, // Native token - pass undefined, not 'native' string
      );

      return balanceInfo.balance || '0';
    } catch (error) {
      this.logger.error('Failed to get native token balance', {
        chainId,
        walletAddress,
        error: error.message,
      });
      throw new Error(`Failed to get native token balance: ${error.message}`);
    }
  }

  /**
   * Get gas price from network (Etherscan or RPC)
   * Used when route/quote gas price is missing or 0
   */
  protected async getGasPriceFromNetwork(
    chainId: number | string,
  ): Promise<string> {
    try {
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;

      // Fetch gas price from network via walletService
      const feeData = await this.walletService.estimateFees(
        numericChainId,
        'evm',
      );

      let gasPrice: string;
      if (feeData.type === 'eip1559') {
        // For EIP-1559, use maxFeePerGas
        gasPrice = feeData.maxFeePerGas || '0';
      } else {
        // For legacy, use gasPrice
        gasPrice = feeData.gasPrice || '0';
      }

      // Validate gas price is not 0
      if (!gasPrice || gasPrice === '0' || BigInt(gasPrice) === 0n) {
        this.logger.warn(
          'Network returned gas price 0, using chain-specific default',
          {
            chainId: numericChainId,
            feeData,
          },
        );

        // Use chain-specific defaults as fallback
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

      this.logger.log('Fetched gas price from network', {
        chainId: numericChainId,
        gasPrice,
        feeType: feeData.type,
      });

      return gasPrice;
    } catch (error) {
      this.logger.error('Failed to fetch gas price from network', {
        chainId,
        error: error.message,
      });

      // Use chain-specific defaults as fallback
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
  }
}
