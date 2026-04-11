import { Injectable, Logger } from '@nestjs/common';
import { type Address, type Hex } from 'viem';
import {
  SwapRequest,
  SwapQuote,
  SwapResult,
  AggregatorType,
} from '@swap/models/swap-request.model';
import { TransactionDataDto } from '@swap/dto/allowance-holder-execute-request.dto';
import { isNativeToken, ChainUtilsService } from '@shared/utils/chain.utils';
import {
  validatePrivateKey,
  validateTokenAddress,
  validateAmount,
  validateSlippage,
  validateDeadline,
} from '@shared/utils/validation.utils';
import {
  createViemPublicClient,
  createViemWalletClient,
  getViemChain,
  getAccountFromPrivateKey,
} from '@shared/utils/viem.utils';
import type { TransactionReceipt } from 'viem';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { AggregatorManagerService } from '../aggregation/aggregator-manager.service';
import { ApprovalService } from '@swap/services/blockchain/approval/approval.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Swap execution service with pre-flight checks
 */
@Injectable()
export class SwapExecutionService {
  constructor(
    private readonly walletService: WalletService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly approvalService: ApprovalService,
    private readonly chainUtils: ChainUtilsService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.winstonLogger.setContext('SwapExecutionService');
  }

  /**
   * Execute complete swap with pre-flight checks and comprehensive error handling
   */
  async executeSwap(
    chainId: number,
    privateKey: string,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
    aggregatorType?: AggregatorType,
  ): Promise<SwapResult> {
    const startTime = Date.now();

    try {
      // Log execution start with detailed parameters
      this.winstonLogger.log(
        `Starting swap execution - Chain: ${chainId}, Sell: ${sellToken}, Buy: ${buyToken}, Amount: ${sellAmount}`,
      );
      this.winstonLogger.debug(
        `Swap execution parameters: ${JSON.stringify({
          chainId,
          sellToken,
          buyToken,
          sellAmount,
          slippagePercentage,
          deadline,
          aggregatorType: aggregatorType || 'auto',
          recipient: recipient || 'not specified',
        })}`,
      );

      // Validate inputs
      this.validateSwapInputs(
        chainId,
        privateKey,
        sellToken,
        buyToken,
        sellAmount,
        slippagePercentage,
        deadline,
      );
      this.winstonLogger.debug('Input validation passed');

      // Create wallet and get address
      const chainConfig = this.chainUtils.getChainConfig(chainId);
      const account = getAccountFromPrivateKey(privateKey);
      const taker = account.address;
      this.winstonLogger.debug(
        `Wallet address derived: ${taker} on chain ${chainId}`,
      );

      // Set recipient to taker if not provided (ensures funds go back to same wallet)
      const finalRecipient = recipient || taker;

      // Build swap request
      const swapRequest: SwapRequest = {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient: finalRecipient,
        slippagePercentage,
        deadline,
        aggregator: aggregatorType,
      };

      // Audit log execution start
      this.winstonLogger.audit('SWAP_EXECUTION_START', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient: finalRecipient,
        aggregator: aggregatorType || 'auto',
        slippagePercentage,
        deadline,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Starting swap execution: ${sellToken} -> ${buyToken}, amount: ${sellAmount}`,
      );

      // Pre-flight checks
      this.winstonLogger.debug('Performing pre-flight checks');
      await this.performPreFlightChecks(swapRequest);
      this.winstonLogger.debug('Pre-flight checks passed');

      // Get quote with retry logic
      this.winstonLogger.log(
        `Requesting quote from aggregator: ${aggregatorType || 'auto'}`,
      );
      let quote: SwapQuote | undefined;
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          const quoteStartTime = Date.now();
          quote = await this.aggregatorManager.getQuote(
            swapRequest,
            aggregatorType,
          );
          const quoteDuration = Date.now() - quoteStartTime;
          this.winstonLogger.log(
            `Quote obtained successfully in ${quoteDuration}ms - Aggregator: ${quote.aggregator}, Sell: ${quote.sellAmount}, Buy: ${quote.buyAmount}, Attempt: ${retryCount + 1}`,
          );
          break;
        } catch (error) {
          retryCount++;
          this.winstonLogger.warn(
            `Quote attempt ${retryCount}/${maxRetries} failed: ${error.message} - Chain: ${chainId}, Sell: ${sellToken}, Buy: ${buyToken}, Aggregator: ${aggregatorType || 'auto'}`,
          );
          if (retryCount >= maxRetries) {
            throw new Error(
              `Failed to get quote after ${maxRetries} attempts: ${error.message}`,
            );
          }
          const backoffDelay = 1000 * retryCount;
          this.winstonLogger.debug(
            `Retrying quote request after ${backoffDelay}ms delay`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }

      if (!quote) {
        this.winstonLogger.error(
          'Quote retrieval failed - no quote obtained after all retry attempts',
        );
        throw new Error('Failed to get quote after all retry attempts');
      }

      // Handle approval if needed
      if (!isNativeToken(sellToken)) {
        this.winstonLogger.log(`Checking token approval for ${sellToken}`);
        await this.handleApproval(
          chainId,
          privateKey,
          sellToken,
          quote,
          aggregatorType,
        );
        this.winstonLogger.debug('Token approval check completed');
      } else {
        this.winstonLogger.debug(
          'Native token detected - skipping approval check',
        );
      }

      // Execute swap with retry logic
      this.winstonLogger.log(
        `Executing swap transaction - To: ${quote.to}, Value: ${quote.value}, GasLimit: ${quote.gas}, DataLength: ${quote.data?.length || 0}`,
      );
      let txHash: string | undefined;
      retryCount = 0;

      while (retryCount < maxRetries) {
        try {
          const txStartTime = Date.now();
          txHash = await this.walletService.executeSwap(
            chainId,
            privateKey,
            quote.to,
            quote.data,
            quote.value,
            quote.gas,
          );
          const txDuration = Date.now() - txStartTime;
          this.winstonLogger.log(
            `Transaction submitted successfully in ${txDuration}ms - Hash: ${txHash}, Attempt: ${retryCount + 1}`,
          );
          break;
        } catch (error) {
          retryCount++;
          this.winstonLogger.warn(
            `Swap execution attempt ${retryCount}/${maxRetries} failed: ${error.message} - Chain: ${chainId}, To: ${quote.to}, Attempt: ${retryCount}`,
          );
          if (retryCount >= maxRetries) {
            throw new Error(
              `Failed to execute swap after ${maxRetries} attempts: ${error.message}`,
            );
          }
          const backoffDelay = 2000 * retryCount;
          this.winstonLogger.debug(
            `Retrying transaction execution after ${backoffDelay}ms delay`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }

      if (!txHash) {
        this.winstonLogger.error(
          'Transaction execution failed - no transaction hash after all retry attempts',
        );
        throw new Error('Failed to execute swap after all retry attempts');
      }

      // Wait for confirmation with timeout
      this.winstonLogger.log(`Waiting for transaction confirmation: ${txHash}`);
      const confirmationStartTime = Date.now();
      const receipt = await this.walletService.waitForTransactionConfirmation(
        chainId,
        txHash,
      );
      const confirmationDuration = Date.now() - confirmationStartTime;
      this.winstonLogger.log(
        `Transaction confirmed in ${confirmationDuration}ms - Hash: ${txHash}, Block: ${receipt.blockNumber}, Status: ${receipt.status}`,
      );

      // Parse result
      this.winstonLogger.debug('Parsing swap result from transaction receipt');
      const result = await this.parseSwapResult(
        receipt,
        quote,
        txHash,
        finalRecipient,
        chainId,
      );

      const duration = Date.now() - startTime;

      // Audit log successful execution
      this.winstonLogger.audit('SWAP_EXECUTION_SUCCESS', {
        chainId,
        transactionHash: txHash,
        sellToken,
        buyToken,
        sellAmount: result.sellAmount,
        buyAmount: result.buyAmount,
        aggregator: result.aggregator,
        gasUsed: result.gasUsed,
        gasPrice: result.gasPrice,
        duration,
        confirmationDuration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Swap executed successfully in ${duration}ms - Hash: ${txHash}, Sell: ${result.sellAmount}, Buy: ${result.buyAmount}, Aggregator: ${result.aggregator}, GasUsed: ${result.gasUsed}`,
      );
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log failed execution with detailed context
      this.winstonLogger.audit('SWAP_EXECUTION_FAILED', {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        aggregator: aggregatorType || 'auto',
        error: error.message,
        errorStack: error.stack,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Swap execution failed after ${duration}ms: ${error.message} - Chain: ${chainId}, Sell: ${sellToken}, Buy: ${buyToken}, Amount: ${sellAmount}, Aggregator: ${aggregatorType || 'auto'}`,
        error.stack,
      );

      // Provide more specific error messages
      if (
        error.message.includes('Insufficient funds') ||
        error.message.includes('insufficient funds')
      ) {
        throw new Error(
          'Insufficient funds for transaction. Please check your wallet balance.',
        );
      } else if (error.message.includes('gas')) {
        throw new Error(
          'Gas estimation failed. The transaction may fail or gas limit may be too low.',
        );
      } else if (error.message.includes('slippage')) {
        throw new Error(
          'Transaction failed due to slippage tolerance exceeded',
        );
      } else if (error.message.includes('deadline')) {
        throw new Error('Transaction failed due to deadline exceeded');
      } else if (error.message.includes('network')) {
        throw new Error('Network error occurred during transaction');
      }

      throw new Error(`Swap execution failed: ${error.message}`);
    }
  }

  /**
   * Validate swap inputs
   */
  private validateSwapInputs(
    chainId: number,
    privateKey: string,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    slippagePercentage?: number,
    deadline?: number,
  ): void {
    validatePrivateKey(privateKey);
    validateTokenAddress(sellToken);
    validateTokenAddress(buyToken);
    validateAmount(sellAmount);

    if (slippagePercentage !== undefined) {
      validateSlippage(slippagePercentage);
    }

    if (deadline !== undefined) {
      validateDeadline(deadline);
    }

    if (sellToken === buyToken) {
      throw new Error('Sell token and buy token cannot be the same');
    }
  }

  /**
   * Perform pre-flight checks
   */
  private async performPreFlightChecks(request: SwapRequest): Promise<void> {
    this.winstonLogger.debug('Performing pre-flight checks...');

    const checkStartTime = Date.now();

    // Check wallet balance
    await this.checkWalletBalance(request);

    // Check aggregator support
    await this.checkAggregatorSupport(request);

    // Check token addresses
    await this.checkTokenAddresses(request);

    const checkDuration = Date.now() - checkStartTime;

    // Audit log pre-flight checks passed
    this.winstonLogger.audit('PREFLIGHT_CHECKS_PASSED', {
      chainId: request.chainId,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      taker: request.taker,
      duration: checkDuration,
      timestamp: new Date().toISOString(),
    });

    this.winstonLogger.debug('Pre-flight checks passed');
  }

  /**
   * Check wallet balance
   */
  private async checkWalletBalance(request: SwapRequest): Promise<void> {
    const balance = await this.walletService.getBalance(
      request.chainId,
      request.taker,
      request.sellToken,
    );

    const requiredAmount = BigInt(request.sellAmount);
    const availableBalance = BigInt(balance.balance);

    if (availableBalance < requiredAmount) {
      throw new Error(
        `Insufficient funds. Required: ${request.sellAmount}, Available: ${balance.balance}`,
      );
    }

    // For native token swaps, also check gas balance
    if (isNativeToken(request.sellToken)) {
      const gasEstimate = BigInt('21000'); // Minimum gas for simple transfer
      const gasPrice = BigInt('20000000000'); // 20 gwei
      const gasCost = gasEstimate * gasPrice;

      if (availableBalance < requiredAmount + gasCost) {
        throw new Error(
          `Insufficient funds for gas. Required: ${request.sellAmount}, Gas cost: ${gasCost}, Available: ${balance.balance}`,
        );
      }
    }
  }

  /**
   * Check aggregator support
   */
  private async checkAggregatorSupport(request: SwapRequest): Promise<void> {
    if (request.aggregator) {
      const isSupported = this.aggregatorManager.isAggregatorSupported(
        request.chainId,
        request.aggregator,
      );

      if (!isSupported) {
        throw new Error(
          `Aggregator ${request.aggregator} does not support chain ${request.chainId}`,
        );
      }
    } else {
      const supportedAggregators =
        this.aggregatorManager.getSupportedAggregators(request.chainId);

      if (supportedAggregators.length === 0) {
        throw new Error(`No aggregators support chain ${request.chainId}`);
      }
    }
  }

  /**
   * Check token addresses
   */
  private async checkTokenAddresses(request: SwapRequest): Promise<void> {
    try {
      await Promise.all([
        this.walletService.getTokenInfo(request.chainId, request.sellToken),
        this.walletService.getTokenInfo(request.chainId, request.buyToken),
      ]);
    } catch (error) {
      throw new Error(`Invalid token address: ${error.message}`);
    }
  }

  /**
   * Handle token approval (supports both ERC-20 and Permit2)
   */
  private async handleApproval(
    chainId: number,
    privateKey: string,
    sellToken: string,
    quote: SwapQuote,
    aggregatorType?: AggregatorType,
  ): Promise<void> {
    if (!quote.allowanceTarget) {
      throw new Error('Allowance target not provided in quote');
    }

    const chainConfig = this.chainUtils.getChainConfig(chainId);
    const account = getAccountFromPrivateKey(privateKey);

    const isApprovalNeeded = await this.approvalService.isApprovalNeeded(
      chainId,
      sellToken,
      account.address,
      quote.allowanceTarget,
      quote.sellAmount,
    );

    if (isApprovalNeeded) {
      this.winstonLogger.log(
        'Approval needed, executing ERC-20 approval transaction...',
      );

      const approvalResult = await this.approvalService.executeApproval(
        chainId,
        privateKey,
        sellToken,
        quote.allowanceTarget,
        quote.sellAmount,
      );

      // Wait for approval confirmation
      await this.walletService.waitForTransactionConfirmation(
        chainId,
        approvalResult.transactionHash,
      );
      this.winstonLogger.log(
        `Approval confirmed: ${approvalResult.transactionHash}`,
      );
    } else {
      this.winstonLogger.log('No approval needed');
    }
  }

  /**
   * Parse swap result from transaction receipt
   */
  private async parseSwapResult(
    receipt: TransactionReceipt,
    quote: SwapQuote,
    txHash: string,
    recipient: string,
    chainId: number,
  ): Promise<SwapResult> {
    const gasUsed = receipt.gasUsed.toString();
    const gasPrice = receipt.effectiveGasPrice?.toString() || '0';

    // Parse token transfers to get actual buy amount
    // Pass chainId for proper provider routing
    const transfers = this.walletService.parseTransactionReceipt(
      receipt,
      quote.buyToken,
      chainId,
    );
    const buyTransfer = transfers.find(
      (transfer) => transfer.to.toLowerCase() === recipient.toLowerCase(),
    );

    const actualBuyAmount = buyTransfer
      ? buyTransfer.amount.toString()
      : quote.buyAmount;

    return {
      transactionHash: txHash,
      sellToken: quote.sellToken,
      buyToken: quote.buyToken,
      sellAmount: quote.sellAmount,
      buyAmount: actualBuyAmount,
      gasUsed,
      gasPrice,
      aggregator: quote.aggregator,
      timestamp: Date.now(),
    };
  }

  /**
   * Get swap quote without execution
   */
  async getSwapQuote(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    taker: string,
    recipient?: string,
    slippagePercentage?: number,
    deadline?: number,
    aggregatorType?: AggregatorType,
  ): Promise<SwapQuote> {
    try {
      this.validateSwapInputs(
        chainId,
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        sellToken,
        buyToken,
        sellAmount,
        slippagePercentage,
        deadline,
      );

      const swapRequest: SwapRequest = {
        chainId,
        sellToken,
        buyToken,
        sellAmount,
        taker,
        recipient: recipient || taker,
        slippagePercentage,
        deadline,
        aggregator: aggregatorType,
      };

      return await this.aggregatorManager.getQuote(swapRequest, aggregatorType);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get swap quote: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get swap quote: ${error.message}`);
    }
  }

  /**
   * Execute AllowanceHolder swap transaction
   * Takes transaction data from allowance-holder/quote and executes it
   */
  async executeAllowanceHolderSwap(
    chainId: number,
    privateKey: string,
    transaction: TransactionDataDto,
    metadata?: {
      sellToken?: string;
      buyToken?: string;
      sellAmount?: string;
      buyAmount?: string;
    },
  ): Promise<{
    transactionHash: string;
    chainId: number;
    from: string;
    to: string;
    value: string;
    gasUsed?: string;
    gasPrice?: string;
    status: string;
    blockNumber?: number;
    blockHash?: string;
    sellToken?: string;
    buyToken?: string;
    sellAmount?: string;
    buyAmount?: string;
  }> {
    try {
      this.winstonLogger.log(
        `Executing AllowanceHolder swap on chain ${chainId}`,
      );

      // Validate inputs
      validatePrivateKey(privateKey);

      if (!transaction?.to || !transaction?.data) {
        throw new Error('Invalid transaction data: missing to or data fields');
      }

      // Get chain configuration and create clients
      const chainConfig = this.chainUtils.getChainConfig(chainId);
      const rpcUrl = chainConfig.rpcUrl;
      if (!rpcUrl) {
        throw new Error(`No RPC URL configured for chain ${chainId}`);
      }

      const chain = getViemChain(chainId);
      const publicClient = createViemPublicClient(chainId, rpcUrl);
      const walletClient = createViemWalletClient(chainId, privateKey, rpcUrl);
      const account = getAccountFromPrivateKey(privateKey);

      this.winstonLogger.debug(
        `Sending AllowanceHolder swap transaction: to=${transaction.to}, value=${transaction.value}, dataLength=${transaction.data.length}, from=${account.address}, chainId=${chainId}`,
        'SwapExecutionService',
      );

      // Send transaction
      const txHash = await walletClient.sendTransaction({
        account: account,
        to: transaction.to as Address,
        data: transaction.data as Hex,
        value: transaction.value ? BigInt(transaction.value) : 0n,
        gas: transaction.gas ? BigInt(transaction.gas) : undefined,
        gasPrice: transaction.gasPrice
          ? BigInt(transaction.gasPrice)
          : undefined,
        chain: chain,
      });

      this.winstonLogger.log(
        `AllowanceHolder swap transaction sent: ${txHash}`,
      );

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 300000, // 5 minutes timeout
      });

      this.winstonLogger.log(
        `AllowanceHolder swap confirmed in block ${receipt.blockNumber}`,
      );

      // Prepare response
      const result = {
        transactionHash: txHash,
        chainId,
        from: account.address,
        to: transaction.to,
        value: transaction.value || '0',
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.effectiveGasPrice?.toString(),
        status: receipt.status === 'success' ? 'success' : 'failed',
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        sellToken: metadata?.sellToken,
        buyToken: metadata?.buyToken,
        sellAmount: metadata?.sellAmount,
        buyAmount: metadata?.buyAmount,
      };

      if (receipt.status !== 'success') {
        this.winstonLogger.error(
          `AllowanceHolder swap transaction failed: ${txHash}`,
          '',
          'SwapExecutionService',
        );
        throw new Error(`Transaction failed: ${txHash}`);
      }

      return result;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to execute AllowanceHolder swap: ${error.message} | chainId=${chainId} | to=${transaction?.to} | metadata=${JSON.stringify(metadata)}`,
        error.stack,
        'SwapExecutionService',
      );

      // Re-throw with more context
      if (
        error.message.includes('Insufficient funds') ||
        error.message.includes('insufficient funds')
      ) {
        throw new Error(
          'Insufficient funds for transaction. Please check your wallet balance.',
        );
      } else if (error.message.includes('gas')) {
        throw new Error(
          'Gas estimation failed. The transaction may fail or gas limit may be too low.',
        );
      } else if (error.message.includes('nonce')) {
        throw new Error('Transaction nonce issue. Please try again.');
      } else if (error.message.includes('replacement')) {
        throw new Error(
          'Transaction replacement issue. Please wait for pending transactions to complete.',
        );
      } else {
        throw new Error(
          `AllowanceHolder swap execution failed: ${error.message}`,
        );
      }
    }
  }
}
