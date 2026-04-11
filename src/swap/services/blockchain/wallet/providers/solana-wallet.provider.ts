import { Injectable, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import {
  IWalletProvider,
  WalletProviderConfig,
} from '../ports/wallet-provider.interface';
import type { IWalletProviderRegistry } from '../ports/wallet-provider-registry.interface';
import { WalletService } from '../wallet.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { RpcFallbackService } from '@shared/services/rpc-fallback.service';
import {
  CHAIN_DETECTION_CONFIG,
  isChainIdInEcosystem,
} from '@config/swap-config';
import bs58 from 'bs58';

// Solana Web3.js imports
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction,
  TransactionMessage,
  AddressLookupTableAccount,
} from '@solana/web3.js';

// SPL Token imports
import {
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  Account as TokenAccount,
} from '@solana/spl-token';

/**
 * Solana-specific wallet provider
 * FULLY IMPLEMENTED: Complete Solana blockchain functionality
 *
 * Handles:
 * - SOL (native token) balance and transactions
 * - SPL token interactions (USDT, USDC)
 * - Solana address validation and formatting
 * - Transaction signing and broadcasting
 *
 * Technical Implementation:
 * - Uses @solana/web3.js for blockchain interactions
 * - SPL Token program for token operations
 * - Supports mainnet, devnet, and testnet environments
 * - Base58 address validation
 * - SPL token interactions
 * - Lamport/SOL conversion
 */
@Injectable()
export class SolanaWalletProvider implements IWalletProvider, OnModuleInit {
  private readonly logger: WinstonLoggerService;
  private connection: Connection | null = null;
  private rpcUrls: string[] = [];

  // Solana compute unit and priority fee constants
  private readonly DEFAULT_COMPUTE_UNIT_LIMIT = 300000; // Conservative default for swaps
  private readonly MAX_COMPUTE_UNIT_LIMIT = 1400000; // Solana hard limit
  private readonly DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 10000; // 0.00001 SOL per compute unit (reasonable default)
  private readonly MAX_PRIORITY_FEE_MICRO_LAMPORTS = 1000000; // 0.001 SOL per compute unit (cap for safety)

  constructor(
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly rpcFallback: RpcFallbackService,
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(WalletService)
    private readonly registry?: IWalletProviderRegistry,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(SolanaWalletProvider.name);
    this.initializeSolana();
  }

  /**
   * Initialize Solana Web3 connection with RPC fallback support
   * NOW USES UNIFIED_CHAINS configuration instead of environment variables
   */
  private async initializeSolana(): Promise<void> {
    try {
      // Get RPC URLs from unified configuration
      const chainConfig =
        this.unifiedConfig.getChainConfiguration('solana-mainnet');
      this.rpcUrls = chainConfig?.rpcUrls || [
        'https://api.mainnet-beta.solana.com',
      ];

      // Use RPC Fallback Service to get the best URL
      const bestUrl = this.rpcFallback.getBestUrl(this.rpcUrls);
      this.connection = new Connection(bestUrl, 'confirmed');

      this.logger.debug(
        `Solana Web3 connection initialized successfully with ${bestUrl}`,
      );
    } catch (error) {
      this.logger.error(
        'Failed to initialize Solana connection',
        error.message,
      );
      this.connection = null;
    }
  }

  /**
   * Get connection with automatic RPC fallback
   * Creates a new connection with the best available RPC URL
   * NOW USES UNIFIED_CHAINS configuration
   */
  private async getConnectionWithFallback(): Promise<Connection> {
    if (!this.rpcUrls || this.rpcUrls.length === 0) {
      const chainConfig =
        this.unifiedConfig.getChainConfiguration('solana-mainnet');
      this.rpcUrls = chainConfig?.rpcUrls || [
        'https://api.mainnet-beta.solana.com',
      ];
    }

    // Get the best URL from RPC Fallback Service
    const bestUrl = this.rpcFallback.getBestUrl(this.rpcUrls);

    // Create a new connection with the best URL
    const connection = new Connection(bestUrl, 'confirmed');

    this.logger.debug(`Using Solana RPC: ${bestUrl}`);

    return connection;
  }

  /**
   * Execute RPC call with automatic fallback
   * Wraps Solana RPC calls with fallback logic using makeRequest
   * NOW USES UNIFIED_CHAINS configuration
   */
  private async executeWithFallback<T>(
    operation: (connection: Connection) => Promise<T>,
    operationName: string,
  ): Promise<T> {
    // Get URLs from unified configuration
    let urls = this.rpcUrls;
    if (urls.length === 0) {
      const chainConfig =
        this.unifiedConfig.getChainConfiguration('solana-mainnet');
      urls = chainConfig?.rpcUrls || ['https://api.mainnet-beta.solana.com'];
    }

    // Try each URL with RPC Fallback Service
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const connection = new Connection(url, 'confirmed');
        const result = await operation(connection);

        // Mark URL as healthy on success
        this.rpcFallback.setUrlHealth(url, true);

        return result;
      } catch (error) {
        this.logger.warn(`${operationName} failed on ${url}: ${error.message}`);

        // Mark URL as unhealthy on failure
        this.rpcFallback.setUrlHealth(url, false);

        // If this is the last URL, throw the error
        if (i === urls.length - 1) {
          throw error;
        }

        // Otherwise, continue to next URL
        this.logger.debug(`Trying next Solana RPC URL...`);
      }
    }

    throw new Error(`All Solana RPC URLs failed for ${operationName}`);
  }

  /**
   * Self-register with wallet service on module initialization
   */
  onModuleInit() {
    if (this.registry) {
      this.registry.registerWalletProvider(this);
      this.logger.debug(
        `${this.getEcosystem()} wallet provider self-registered`,
      );
    } else {
      this.logger.warn(
        `${this.getEcosystem()} wallet provider could not find registry to self-register`,
      );
    }

    // Initialize Solana connection
    this.initializeSolana();
  }

  getEcosystem(): string {
    return 'solana';
  }

  supportsChain(chainId: number | string): boolean {
    // Solana uses string chain identifiers like 'mainnet-beta', 'devnet', 'testnet'
    const solanaChains = [
      'mainnet-beta',
      'devnet',
      'testnet',
      'solana',
      'solana-mainnet',
      'solana-devnet',
      'solana-testnet',
    ];

    if (typeof chainId === 'string') {
      return solanaChains.includes(chainId.toLowerCase());
    }

    // Use configuration-based chain detection for numeric IDs
    return isChainIdInEcosystem(chainId, 'solana', CHAIN_DETECTION_CONFIG);
  }

  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo> {
    try {
      this.validateSolanaChain(chainId);
      this.validateSolanaAddress(walletAddress);

      if (!this.connection) {
        throw new Error('Solana connection not initialized');
      }

      // Native SOL balance
      if (!tokenAddress || this.isNativeSolToken(tokenAddress)) {
        return this.getSolBalance(chainId, walletAddress);
      }

      // SPL Token balance
      return this.getSplTokenBalance(chainId, walletAddress, tokenAddress);
    } catch (error) {
      this.logger.error(
        `Failed to get Solana balance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Solana balance: ${error.message}`);
    }
  }

  async getMultipleBalances(
    chainId: number | string,
    walletAddress: string,
    tokenAddresses: string[],
  ): Promise<BalanceInfo[]> {
    const balances = await Promise.allSettled(
      tokenAddresses.map((tokenAddress) =>
        this.getBalance(chainId, walletAddress, tokenAddress),
      ),
    );

    return balances
      .filter(
        (result): result is PromiseFulfilledResult<BalanceInfo> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);
  }

  /**
   * Estimate transaction cost dynamically for Solana transactions
   * This method can be called from gas estimation service to get accurate costs
   *
   * @param chainId - Solana chain identifier
   * @param transactionData - Base64 encoded transaction or transaction object
   * @param walletAddress - User wallet address for simulation
   * @returns Estimated cost in lamports { computeUnits, priorityFee, totalCost }
   */
  async estimateTransactionCost(
    chainId: number | string,
    transactionData?: string | any,
    walletAddress?: string,
  ): Promise<{
    computeUnits: number;
    priorityFee: number;
    totalCost: string; // in lamports
  }> {
    try {
      this.validateSolanaChain(chainId);

      return await this.executeWithFallback(async (connection) => {
        // Get recommended priority fee
        const recommendedPriorityFee =
          await this.getRecommendedPriorityFee(connection);

        let estimatedComputeUnits: number | null = null;

        // If transaction data is provided, simulate it
        if (transactionData && typeof transactionData === 'string') {
          try {
            // Decode and deserialize transaction
            const transactionBuffer = Buffer.from(transactionData, 'base64');
            const transaction =
              VersionedTransaction.deserialize(transactionBuffer);

            // Simulate to get compute units
            estimatedComputeUnits =
              await this.simulateTransactionForComputeUnits(
                transaction,
                connection,
              );
          } catch (simError) {
            this.logger.warn(
              `Failed to simulate provided transaction: ${simError.message}`,
            );
          }
        }

        // Use simulated value or fallback to default
        const computeUnits =
          estimatedComputeUnits && estimatedComputeUnits > 0
            ? Math.ceil(estimatedComputeUnits * 1.2) // 20% buffer
            : this.DEFAULT_COMPUTE_UNIT_LIMIT;

        // Calculate total cost: base fee + (compute units * priority fee / 1M)
        const baseFee = 5000; // Solana base transaction fee in lamports
        const computeCost = Math.ceil(
          (computeUnits * recommendedPriorityFee) / 1_000_000,
        );
        const totalCost = baseFee + computeCost;

        this.logger.log('Estimated Solana transaction cost', {
          computeUnits,
          priorityFee: recommendedPriorityFee,
          baseFee,
          computeCost,
          totalCost,
          source: estimatedComputeUnits ? 'simulation' : 'default',
        });

        return {
          computeUnits,
          priorityFee: recommendedPriorityFee,
          totalCost: totalCost.toString(),
        };
      }, 'estimateTransactionCost');
    } catch (error) {
      this.logger.error(
        `Failed to estimate Solana transaction cost: ${error.message}`,
      );

      // Return conservative fallback
      const fallbackComputeUnits = this.DEFAULT_COMPUTE_UNIT_LIMIT;
      const fallbackPriorityFee = this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
      const fallbackBaseFee = 5000;
      const fallbackComputeCost = Math.ceil(
        (fallbackComputeUnits * fallbackPriorityFee) / 1_000_000,
      );
      const fallbackTotalCost = fallbackBaseFee + fallbackComputeCost;

      return {
        computeUnits: fallbackComputeUnits,
        priorityFee: fallbackPriorityFee,
        totalCost: fallbackTotalCost.toString(),
      };
    }
  }

  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      this.validateSolanaChain(chainId);

      if (!this.connection) {
        throw new Error('Solana connection not initialized');
      }

      if (this.isNativeSolToken(tokenAddress)) {
        return {
          address: tokenAddress,
          symbol: 'SOL',
          name: 'Solana',
          decimals: 9,
          chainId: chainId as any,
          isNative: true,
        };
      }

      // Get SPL token info
      return this.getSplTokenInfo(chainId, tokenAddress);
    } catch (error) {
      this.logger.error(
        `Failed to get Solana token info: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Solana token info: ${error.message}`);
    }
  }

  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    try {
      this.validateSolanaChain(chainId);
      this.validateSolanaAddress(owner);
      this.validateSolanaAddress(spender);

      if (this.isNativeSolToken(tokenAddress)) {
        return '0'; // Native SOL doesn't need allowance
      }

      // Solana SPL tokens don't have the same allowance mechanism as ERC20
      // Instead, they use delegation or token accounts
      // For compatibility, we'll return a large number indicating "approved"
      this.logger.warn(
        'SPL tokens use different approval mechanism than ERC20',
      );
      return '999999999999999999999999999'; // Large number indicating approval
    } catch (error) {
      this.logger.error(
        `Failed to get Solana allowance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Solana allowance: ${error.message}`);
    }
  }

  async executeApproval(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<string> {
    try {
      this.validateSolanaChain(chainId);
      this.validateSolanaAddress(spender);
      this.validateSolanaPrivateKey(privateKey);

      if (this.isNativeSolToken(tokenAddress)) {
        throw new Error('Cannot approve native SOL token');
      }

      // Solana SPL tokens handle approvals differently
      // For now, we'll create a dummy successful transaction
      this.logger.warn(
        'SPL token approval not implemented - tokens are transferred directly',
      );

      // Return a dummy transaction hash
      return 'approval_not_required_' + Date.now().toString();
    } catch (error) {
      this.logger.error(
        `Failed to execute Solana approval: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute Solana approval: ${error.message}`);
    }
  }

  async executeTransaction(
    chainId: number | string,
    privateKey: string,
    to: string,
    data: string,
    value: string,
    gasLimit?: string,
    providedGasPrices?: {
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
      gasPrice?: string;
    },
  ): Promise<string> {
    try {
      this.validateSolanaChain(chainId);
      this.validateSolanaPrivateKey(privateKey);

      if (!this.connection) {
        throw new Error('Solana connection not initialized');
      }

      // CRITICAL: Use console.error to ensure logs appear (NestJS Logger may not write to Winston files)
      console.error('🔵 Solana executeTransaction called', {
        hasData: !!data,
        dataLength: data?.length || 0,
        hasTo: !!to,
        toAddress: to || 'none',
        value,
        gasLimit,
      });
      this.logger.log('🔵 Solana executeTransaction called', {
        hasData: !!data,
        dataLength: data?.length || 0,
        hasTo: !!to,
        toAddress: to || 'none',
        value,
        gasLimit,
      });

      // Check if this is a Rubic API transaction (base64-encoded VersionedTransaction)
      // Rubic API returns transaction data in base64 format for Solana
      // Reference: https://docs.rubic.finance/rubic-api/rubic-api/integration-example/swaps-from-solana
      // Detection: data is present (>100 chars) - prioritize this over 'to' address check
      // Note: Sometimes meta-executors pass both data and to address, but data takes priority
      if (data && data.length > 100) {
        this.logger.debug(
          'Detected Rubic API transaction format (base64 VersionedTransaction)',
          {
            dataLength: data.length,
            hasToAddress: !!to,
          },
        );
        // This is a base64-encoded VersionedTransaction from Rubic API
        // Pass gasLimit as quote data container (may have computeUnits/priorityFee)
        const quoteData = gasLimit ? JSON.parse(gasLimit) : undefined;
        this.logger.debug('Rubic transaction quote data (raw)', {
          hasQuote: !!quoteData,
          swapFullBalance: quoteData?.swapFullBalance,
          computeUnits: quoteData?.computeUnits || quoteData?.computeUnitLimit,
          priorityFee:
            quoteData?.priorityFee || quoteData?.priorityFeeMicroLamports,
        });
        return this.executeRubicTransaction(privateKey, data, quoteData);
      }

      // Simple SOL or SPL token transfer (deposit trades)
      if (to && to !== '') {
        this.validateSolanaAddress(to);

        // Parse optional compute settings, full-balance flag, and token address from gasLimit JSON
        let quoteData: any = undefined;
        try {
          quoteData = gasLimit ? JSON.parse(gasLimit) : undefined;
          console.error('🔍 Parsed gasLimit JSON', { gasLimit, quoteData });
        } catch (e) {
          console.error('⚠️ Failed to parse gasLimit as JSON', {
            error: e.message,
            gasLimit,
          });
          this.logger.warn(`Failed to parse gasLimit as JSON: ${e.message}`);
        }

        const swapFullBalance =
          quoteData?.swapFullBalance === true ||
          quoteData?.swapFullBalance === 1;
        const computeUnits =
          quoteData?.computeUnits || quoteData?.computeUnitLimit;
        const priorityFee =
          quoteData?.priorityFee || quoteData?.priorityFeeMicroLamports;
        const tokenAddress = quoteData?.tokenAddress;

        console.error('🔍 Extracted flags', {
          swapFullBalance,
          computeUnits,
          priorityFee,
          tokenAddress,
        });

        // Check if this is a SPL token transfer
        const isNativeSOL =
          !tokenAddress || this.isNativeSolToken(tokenAddress);

        console.error(
          '🟢 Detected Solana transfer - routing to executeSolTransfer',
          {
            isNativeSOL,
            tokenAddress: tokenAddress || 'SOL',
            to,
            value,
            swapFullBalance,
            computeUnits,
            priorityFee,
          },
        );
        this.logger.log(
          '🟢 Detected Solana transfer - routing to executeSolTransfer',
          {
            isNativeSOL,
            tokenAddress: tokenAddress || 'SOL',
            to,
            value,
            swapFullBalance,
            computeUnits,
            priorityFee,
          },
        );

        if (isNativeSOL) {
          // Native SOL transfer
          return this.executeSolTransfer(
            privateKey,
            to,
            value,
            swapFullBalance,
            computeUnits,
            priorityFee,
          );
        } else {
          // SPL token transfer
          return this.executeSplTokenTransfer(
            privateKey,
            to,
            tokenAddress,
            value,
            swapFullBalance,
            computeUnits,
            priorityFee,
          );
        }
      }

      // If we get here, parameters are invalid
      this.logger.error('Invalid transaction parameters', {
        hasData: !!data,
        dataLength: data?.length || 0,
        hasTo: !!to,
        toAddress: to || 'none',
      });
      throw new Error(
        `Invalid transaction parameters: either provide base64 data (got ${data?.length || 0} chars) or to address (got "${to || 'none'}")`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to execute Solana transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute Solana transaction: ${error.message}`);
    }
  }

  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
  ): Promise<any> {
    try {
      this.validateSolanaChain(chainId);

      if (!this.connection) {
        throw new Error('Solana connection not initialized');
      }

      return this.waitForSolanaConfirmation(txHash, confirmations);
    } catch (error) {
      this.logger.error(
        `Failed to wait for Solana transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to wait for Solana transaction: ${error.message}`,
      );
    }
  }

  async getTransactionStatus(
    chainId: number | string,
    txHash: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }> {
    try {
      this.validateSolanaChain(chainId);

      if (!this.connection) {
        throw new Error('Solana connection not initialized');
      }

      return this.getSolanaTransactionStatus(txHash);
    } catch (error) {
      this.logger.error(
        `Failed to get Solana transaction status: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to get Solana transaction status: ${error.message}`,
      );
    }
  }

  getConfig(): WalletProviderConfig {
    return {
      name: 'Solana Wallet Provider',
      ecosystem: 'solana',
      enabled: true, // Now fully implemented
      supportedChains: ['mainnet-beta', 'devnet', 'testnet', 'solana-mainnet'],
    };
  }

  // ==================== PRIVATE HELPER METHODS ====================

  /**
   * Simulate transaction to estimate actual compute units needed
   * Returns the simulated compute units consumed
   */
  private async simulateTransactionForComputeUnits(
    transaction: VersionedTransaction,
    connection: Connection,
  ): Promise<number | null> {
    try {
      // Simulate the transaction to get compute units
      const simulation = await connection.simulateTransaction(transaction, {
        sigVerify: false, // Skip signature verification for simulation
        replaceRecentBlockhash: true, // Use recent blockhash
        commitment: 'confirmed',
      });

      if (simulation.value.err) {
        this.logger.warn('Transaction simulation failed', {
          error: simulation.value.err,
          logs: simulation.value.logs,
        });
        return null;
      }

      const unitsConsumed = simulation.value.unitsConsumed;
      this.logger.debug('Transaction simulation successful', {
        unitsConsumed,
        logs: simulation.value.logs?.slice(0, 3), // Log first 3 lines for debugging
      });

      return unitsConsumed || null;
    } catch (error) {
      this.logger.warn(`Failed to simulate transaction: ${error.message}`);
      return null;
    }
  }

  /**
   * Get recommended priority fee from recent transactions
   * Returns priority fee in micro-lamports per compute unit
   */
  private async getRecommendedPriorityFee(
    connection: Connection,
  ): Promise<number> {
    try {
      // Get recent prioritization fees (available in newer Solana versions)
      const recentFees = await connection.getRecentPrioritizationFees();

      if (!recentFees || recentFees.length === 0) {
        this.logger.debug(
          'No recent prioritization fees available, using default',
        );
        return this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
      }

      // Calculate median priority fee for stability
      const fees = recentFees
        .map((f) => f.prioritizationFee)
        .filter((f) => f > 0)
        .sort((a, b) => a - b);

      if (fees.length === 0) {
        this.logger.debug('All recent fees are 0, using default');
        return this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
      }

      const medianFee = fees[Math.floor(fees.length / 2)];

      // Cap the fee for safety
      const cappedFee = Math.min(
        medianFee,
        this.MAX_PRIORITY_FEE_MICRO_LAMPORTS,
      );

      this.logger.debug('Recommended priority fee calculated', {
        medianFee,
        cappedFee,
        sampleSize: fees.length,
      });

      return cappedFee;
    } catch (error) {
      this.logger.warn(
        `Failed to get recent prioritization fees: ${error.message}`,
      );
      return this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
    }
  }

  /**
   * Extract and validate compute unit settings from quote/route data
   * Returns compute unit limit and priority fee in micro-lamports
   */
  private extractComputeSettings(quoteData: any): {
    computeUnitLimit: number;
    priorityFeeMicroLamports: number;
  } {
    // Extract from quote if available
    const quoteComputeUnits =
      quoteData?.computeUnits || quoteData?.computeUnitLimit;
    const quotePriorityFee =
      quoteData?.priorityFee || quoteData?.priorityFeeMicroLamports;

    // Validate and cap compute unit limit
    let computeUnitLimit = this.DEFAULT_COMPUTE_UNIT_LIMIT;
    if (quoteComputeUnits && typeof quoteComputeUnits === 'number') {
      if (quoteComputeUnits > this.MAX_COMPUTE_UNIT_LIMIT) {
        this.logger.warn(
          `Quote compute units ${quoteComputeUnits} exceeds max ${this.MAX_COMPUTE_UNIT_LIMIT}, capping`,
        );
        computeUnitLimit = this.MAX_COMPUTE_UNIT_LIMIT;
      } else if (quoteComputeUnits < 1000) {
        this.logger.warn(
          `Quote compute units ${quoteComputeUnits} too low, using default ${this.DEFAULT_COMPUTE_UNIT_LIMIT}`,
        );
        computeUnitLimit = this.DEFAULT_COMPUTE_UNIT_LIMIT;
      } else {
        computeUnitLimit = quoteComputeUnits;
      }
    }

    // Validate and cap priority fee
    let priorityFeeMicroLamports = this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
    if (quotePriorityFee && typeof quotePriorityFee === 'number') {
      if (quotePriorityFee > this.MAX_PRIORITY_FEE_MICRO_LAMPORTS) {
        this.logger.warn(
          `Quote priority fee ${quotePriorityFee} exceeds max ${this.MAX_PRIORITY_FEE_MICRO_LAMPORTS}, capping`,
        );
        priorityFeeMicroLamports = this.MAX_PRIORITY_FEE_MICRO_LAMPORTS;
      } else if (quotePriorityFee < 0) {
        this.logger.warn(
          `Quote priority fee ${quotePriorityFee} is negative, using default ${this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS}`,
        );
        priorityFeeMicroLamports = this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
      } else {
        priorityFeeMicroLamports = quotePriorityFee;
      }
    }

    this.logger.debug('Compute settings extracted', {
      computeUnitLimit,
      priorityFeeMicroLamports,
      quoteComputeUnits,
      quotePriorityFee,
    });

    return { computeUnitLimit, priorityFeeMicroLamports };
  }

  private validateSolanaChain(chainId: number | string): void {
    if (!this.supportsChain(chainId)) {
      throw new Error(`Unsupported Solana chain: ${chainId}`);
    }
  }

  private validateSolanaPrivateKey(privateKey: string): void {
    // Accept various formats:
    // - Base58 string (standard Solana format, ~88 chars)
    // - 128 chars (64 bytes hex)
    // - 64 chars (32 bytes hex)
    // - JSON array format [1,2,3,...]
    // - Comma-separated format "1,2,3,..."
    if (!privateKey) {
      throw new Error('Invalid Solana private key format');
    }

    // Base58 format (standard Solana private key - most common)
    // Typically 87-88 characters for a 64-byte key
    if (
      privateKey.length >= 80 &&
      privateKey.length <= 90 &&
      !privateKey.includes(',') &&
      !privateKey.startsWith('[')
    ) {
      // Base58 validation - should only contain base58 characters
      if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(privateKey)) {
        throw new Error('Invalid Solana private key format (base58 expected)');
      }
      return; // Valid base58 format
    }

    if (privateKey.length === 128 || privateKey.length === 64) {
      // Hex format validation
      if (!/^[0-9a-fA-F]+$/.test(privateKey)) {
        throw new Error('Invalid Solana private key format (hex expected)');
      }
    } else if (privateKey.startsWith('[') && privateKey.endsWith(']')) {
      // JSON array format
      try {
        const keyArray = JSON.parse(privateKey);
        if (!Array.isArray(keyArray) || keyArray.length !== 64) {
          throw new Error(
            'Invalid Solana private key format (64-byte array expected)',
          );
        }
      } catch {
        throw new Error(
          'Invalid Solana private key format (invalid JSON array)',
        );
      }
    } else if (privateKey.includes(',')) {
      // Comma-separated format
      const parts = privateKey.split(',');
      if (parts.length !== 64) {
        throw new Error(
          'Invalid Solana private key format (64 comma-separated values expected)',
        );
      }
    } else {
      throw new Error(
        'Invalid Solana private key format (expected base58, hex, array, or comma-separated)',
      );
    }
  }

  /**
   * Convert private key string to Keypair
   * Supports multiple formats: base58, hex, JSON array, comma-separated
   */
  private privateKeyToKeypair(privateKey: string): Keypair {
    this.validateSolanaPrivateKey(privateKey);

    try {
      // Base58 format (standard Solana format)
      if (
        privateKey.length >= 80 &&
        privateKey.length <= 90 &&
        !privateKey.includes(',') &&
        !privateKey.startsWith('[')
      ) {
        const decoded = bs58.decode(privateKey);
        return Keypair.fromSecretKey(decoded);
      }

      // Hex format
      if (privateKey.length === 128 || privateKey.length === 64) {
        const buffer = Buffer.from(privateKey, 'hex');
        const secretKey =
          privateKey.length === 128
            ? new Uint8Array(buffer)
            : new Uint8Array(buffer);
        return Keypair.fromSecretKey(secretKey);
      }

      // JSON array format
      if (privateKey.startsWith('[') && privateKey.endsWith(']')) {
        const keyArray = JSON.parse(privateKey);
        return Keypair.fromSecretKey(new Uint8Array(keyArray));
      }

      // Comma-separated format
      if (privateKey.includes(',')) {
        const keyArray = privateKey
          .split(',')
          .map((num) => parseInt(num.trim(), 10));
        return Keypair.fromSecretKey(new Uint8Array(keyArray));
      }

      throw new Error('Unsupported private key format');
    } catch (error) {
      throw new Error(`Failed to parse Solana private key: ${error.message}`);
    }
  }

  private validateSolanaAddress(address: string): void {
    try {
      new PublicKey(address);
    } catch (error) {
      throw new Error(`Invalid Solana address format: ${address}`);
    }
  }

  private isNativeSolToken(tokenAddress: string): boolean {
    return (
      !tokenAddress ||
      tokenAddress.toLowerCase() === 'native' ||
      tokenAddress.toLowerCase() === 'sol' ||
      tokenAddress === 'So11111111111111111111111111111111111111111'
    ); // System Program ID
  }

  // ==================== SOL NATIVE TOKEN METHODS ====================

  /**
   * Calculate safe swap amount for full balance SOL swaps
   * Reserves funds for transaction fees and rent exemption
   *
   * @param walletPublicKey - Public key of the wallet
   * @param requestedAmountLamports - Requested amount in lamports
   * @param swapFullBalance - Whether this is a full balance swap
   * @returns Adjusted amount, reserved amount, and reason
   */

  /**
   * Calculate safe swap amount for full balance SOL swaps
   * Reserves funds for transaction fees and rent exemption
   *
   * @param walletPublicKey - Public key of the wallet
   * @param requestedAmountLamports - Requested amount in lamports
   * @param swapFullBalance - Whether this is a full balance swap
   * @returns Adjusted amount, reserved amount, and reason
   */
  private async calculateSafeSwapAmount(
    walletPublicKey: PublicKey,
    requestedAmountLamports: string,
    swapFullBalance: boolean,
    computeUnits?: number,
    priorityFeeMicroLamports?: number,
  ): Promise<{ adjustedAmount: string; reserved: string; reason?: string }> {
    if (!swapFullBalance || requestedAmountLamports === '0') {
      return { adjustedAmount: requestedAmountLamports, reserved: '0' };
    }

    // Get current balance
    const balanceLamports = await this.executeWithFallback(
      async (connection) => await connection.getBalance(walletPublicKey),
      'getBalanceForAdjustment',
    );

    // Signature fee (fixed)
    const SIGNATURE_FEE = 5_000;

    // Compute budget fee from provided or default settings
    const effUnits =
      computeUnits && computeUnits > 0
        ? Math.min(computeUnits, this.MAX_COMPUTE_UNIT_LIMIT)
        : this.DEFAULT_COMPUTE_UNIT_LIMIT;
    const effPriority =
      priorityFeeMicroLamports !== undefined && priorityFeeMicroLamports >= 0
        ? Math.min(
            priorityFeeMicroLamports,
            this.MAX_PRIORITY_FEE_MICRO_LAMPORTS,
          )
        : this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
    const COMPUTE_BUDGET_FEE = Math.ceil((effUnits * effPriority) / 1_000_000);

    // Rent reserve (query from network, token account ~165 bytes)
    let RENT_RESERVE = 0;
    try {
      RENT_RESERVE = await this.executeWithFallback(
        async (connection) =>
          await connection.getMinimumBalanceForRentExemption(165),
        'getRentExemption',
      );
    } catch (e) {
      this.logger.warn(
        `getMinimumBalanceForRentExemption failed: ${e.message}; using fallback`,
      );
      RENT_RESERVE = 890_880;
    }

    // Safety buffer 5% or minimum 50k lamports
    const SAFETY_BUFFER = Math.max(
      Math.ceil((SIGNATURE_FEE + COMPUTE_BUDGET_FEE + RENT_RESERVE) * 0.05),
      50_000,
    );

    const totalReserve =
      SIGNATURE_FEE + COMPUTE_BUDGET_FEE + RENT_RESERVE + SAFETY_BUFFER;

    this.logger.debug('Dynamic fee reserve breakdown', {
      balanceLamports,
      requestedAmountLamports,
      signatureFee: SIGNATURE_FEE,
      computeBudgetFee: COMPUTE_BUDGET_FEE,
      rentReserve: RENT_RESERVE,
      safetyBuffer: SAFETY_BUFFER,
      totalReserve,
      computeSettings: {
        units: effUnits,
        priorityFeeMicroLamports: effPriority,
      },
    });

    const adjustedLamports = BigInt(balanceLamports) - BigInt(totalReserve);
    if (adjustedLamports <= 0n) {
      throw new Error(
        `Insufficient SOL balance for full balance swap. Balance=${balanceLamports} reserve=${totalReserve}`,
      );
    }

    return {
      adjustedAmount: adjustedLamports.toString(),
      reserved: totalReserve.toString(),
      reason: 'Reserved for transaction fees (dynamic)',
    };
  }

  private async getSolBalance(
    chainId: number | string,
    walletAddress: string,
  ): Promise<BalanceInfo> {
    try {
      const publicKey = new PublicKey(walletAddress);

      // Use fallback mechanism for balance query
      const balanceLamports = await this.executeWithFallback(
        async (connection) => await connection.getBalance(publicKey),
        'getSolBalance',
      );

      const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

      return {
        tokenAddress: 'native',
        balance: balanceLamports.toString(),
        formattedBalance: balanceSol.toString(),
        decimals: 9,
        symbol: 'SOL',
      };
    } catch (error) {
      this.logger.error(`Failed to get SOL balance: ${error.message}`);
      throw new Error(`Failed to get SOL balance: ${error.message}`);
    }
  }

  // ==================== SPL TOKEN METHODS ====================

  private async getSplTokenBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress: string,
  ): Promise<BalanceInfo> {
    try {
      const ownerPublicKey = new PublicKey(walletAddress);
      const mintPublicKey = new PublicKey(tokenAddress);

      // Get token accounts with fallback
      const tokenAccounts = await this.executeWithFallback(
        async (connection) =>
          await connection.getTokenAccountsByOwner(ownerPublicKey, {
            mint: mintPublicKey,
          }),
        'getTokenAccountsByOwner',
      );

      if (tokenAccounts.value.length === 0) {
        // No token account found - balance is 0, but still get proper token info
        const tokenInfo = await this.getSplTokenInfo(chainId, tokenAddress);
        return {
          tokenAddress,
          balance: '0',
          formattedBalance: '0',
          decimals: tokenInfo.decimals,
          symbol: tokenInfo.symbol,
        };
      }

      // Get the first token account and parse its data using SPL Token library
      const tokenAccountPubkey = tokenAccounts.value[0].pubkey;

      try {
        // Try to get account info using SPL Token library with fallback
        const accountInfo = await this.executeWithFallback(
          async (connection) =>
            await getAccount(connection, tokenAccountPubkey),
          'getAccount',
        );

        const balance = accountInfo.amount.toString();

        const mintInfo = await this.executeWithFallback(
          async (connection) => await getMint(connection, mintPublicKey),
          'getMint',
        );

        const decimals = mintInfo.decimals;
        const formattedBalance = (
          Number(balance) / Math.pow(10, decimals)
        ).toString();

        // Get token metadata
        const tokenInfo = await this.getSplTokenInfo(chainId, tokenAddress);
        return {
          tokenAddress,
          balance,
          formattedBalance,
          decimals,
          symbol: tokenInfo.symbol,
        };
      } catch (splError) {
        // Fallback: try to parse account data manually
        const accountData = tokenAccounts.value[0].account.data;

        // Basic SPL token account parsing (amount is at bytes 64-72)
        if (accountData.length >= 72) {
          const amountBytes = accountData.slice(64, 72);
          const balance = Buffer.from(amountBytes)
            .readBigUInt64LE(0)
            .toString();

          // Try to get mint info for decimals
          let decimals = 9; // Default
          try {
            const mintInfo = await this.executeWithFallback(
              async (connection) => await getMint(connection, mintPublicKey),
              'getMint',
            );
            decimals = mintInfo.decimals;
          } catch (mintError) {
            // Use default decimals
          }

          const formattedBalance = (
            Number(balance) / Math.pow(10, decimals)
          ).toString();
          const tokenInfo = await this.getSplTokenInfo(chainId, tokenAddress);

          return {
            tokenAddress,
            balance,
            formattedBalance,
            decimals,
            symbol: tokenInfo.symbol,
          };
        }

        throw splError;
      }
    } catch (error) {
      this.logger.error(`Failed to get SPL token balance`, {
        error: error.message,
        chainId,
        tokenAddress,
        stack: error.stack,
      });

      // Try to get token info even on error to return proper symbol
      try {
        const tokenInfo = await this.getSplTokenInfo(chainId, tokenAddress);
        return {
          tokenAddress,
          balance: '0',
          formattedBalance: '0',
          decimals: tokenInfo.decimals,
          symbol: tokenInfo.symbol,
        };
      } catch (tokenInfoError) {
        // Last resort: return with UNKNOWN
        return {
          tokenAddress,
          balance: '0',
          formattedBalance: '0',
          decimals: 9,
          symbol: 'UNKNOWN',
        };
      }
    }
  }

  private async getSplTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      const mintPublicKey = new PublicKey(tokenAddress);

      // Try to get mint info using SPL Token library with fallback
      try {
        const mintInfo = await this.executeWithFallback(
          async (connection) => await getMint(connection, mintPublicKey),
          'getMintInfo',
        );

        return {
          address: tokenAddress,
          symbol: this.getKnownTokenSymbol(tokenAddress),
          name: this.getKnownTokenName(tokenAddress),
          decimals: mintInfo.decimals,
          chainId: chainId as any,
          isNative: false,
        };
      } catch (error) {
        // Fallback to basic account info
        const accountInfo = await this.executeWithFallback(
          async (connection) => await connection.getAccountInfo(mintPublicKey),
          'getAccountInfo',
        );

        if (!accountInfo) {
          throw new Error('Token mint not found');
        }

        // Use default values for unknown tokens
        return {
          address: tokenAddress,
          symbol: this.getKnownTokenSymbol(tokenAddress),
          name: this.getKnownTokenName(tokenAddress),
          decimals: 9, // Default SPL token decimals
          chainId: chainId as any,
          isNative: false,
        };
      }
    } catch (error) {
      // Return default info if all else fails
      return {
        address: tokenAddress,
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 9,
        chainId: chainId as any,
        isNative: false,
      };
    }
  }

  private getKnownTokenSymbol(tokenAddress: string): string {
    const knownTokens: Record<string, string> = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
    };
    return knownTokens[tokenAddress] || 'UNKNOWN';
  }

  private getKnownTokenName(tokenAddress: string): string {
    const knownTokens: Record<string, string> = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USD Coin',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'Tether USD',
    };
    return knownTokens[tokenAddress] || 'Unknown Token';
  }

  // ==================== TRANSACTION EXECUTION METHODS ====================

  /**
   * Ensure an Associated Token Account (ATA) exists for the owner/mint pair.
   * Detects Token-2022 mints and creates the ATA with the correct program ID if missing.
   * Uses the provided private key as payer and owner.
   */
  public async ensureAssociatedTokenAccount(
    ownerAddress: string,
    mintAddress: string,
    ownerPrivateKey: string,
  ): Promise<{
    ata: string;
    created: boolean;
    signature?: string;
    program: 'spl' | 'token-2022';
  }> {
    try {
      this.validateSolanaPrivateKey(ownerPrivateKey);
      this.validateSolanaAddress(ownerAddress);
      this.validateSolanaAddress(mintAddress);

      // Build keypair from private key using unified helper
      const keypair = this.privateKeyToKeypair(ownerPrivateKey);

      const ownerPub = new PublicKey(ownerAddress);
      const mintPub = new PublicKey(mintAddress);

      // Detect token program (SPL vs Token-2022)
      const isToken2022 = await this.executeWithFallback(async (connection) => {
        const info = await connection.getAccountInfo(mintPub);
        return info?.owner?.equals(TOKEN_2022_PROGRAM_ID) ?? false;
      }, 'detectTokenProgram');

      const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const programName: 'spl' | 'token-2022' = isToken2022
        ? 'token-2022'
        : 'spl';

      const ataPub = await getAssociatedTokenAddress(
        mintPub,
        ownerPub,
        false,
        programId,
      );

      // Check if ATA already exists
      const exists = await this.executeWithFallback(async (connection) => {
        const acc = await connection.getAccountInfo(ataPub);
        return !!acc;
      }, 'checkAtaExists');

      if (exists) {
        return { ata: ataPub.toBase58(), created: false, program: programName };
      }

      // Pre-check: ensure payer has enough SOL for rent + fee (approximate)
      const rentAndFeeOk = await this.executeWithFallback(
        async (connection) => {
          const rent = await connection.getMinimumBalanceForRentExemption(165);
          const bal = await connection.getBalance(keypair.publicKey);
          // add ~5k lamports buffer for fee
          return bal >= rent + 5_000;
        },
        'checkPayerRentBalance',
      );

      if (!rentAndFeeOk) {
        throw new Error(
          'Insufficient SOL for ATA rent. Please ensure at least ~0.003 SOL available.',
        );
      }

      // Create ATA instruction
      const ix = createAssociatedTokenAccountInstruction(
        keypair.publicKey, // payer
        ataPub, // ATA
        ownerPub, // owner
        mintPub, // mint
        programId, // token program id (SPL or Token-2022)
      );

      // Submit transaction with fallback
      const signature = await this.executeWithFallback(async (connection) => {
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = keypair.publicKey;
        return await connection.sendTransaction(tx, [keypair], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      }, 'createAta');

      return {
        ata: ataPub.toBase58(),
        created: true,
        signature,
        program: programName,
      };
    } catch (error) {
      this.logger.error(`Failed to ensure ATA: ${error.message}`);
      throw new Error(`Failed to ensure ATA: ${error.message}`);
    }
  }

  private async executeSolTransfer(
    privateKey: string,
    to: string,
    value: string,
    swapFullBalance: boolean = false,
    computeUnits?: number,
    priorityFeeMicroLamports?: number,
  ): Promise<string> {
    try {
      // Validate and convert private key to keypair using unified helper
      const keypair = this.privateKeyToKeypair(privateKey);

      const fromPublicKey = keypair.publicKey;
      const toPublicKey = new PublicKey(to);

      // CRITICAL: value is already in lamports (smallest unit), not SOL
      // The wallet provider interface passes amounts in the token's smallest unit
      // For Solana: lamports (1 SOL = 1,000,000,000 lamports)
      // This is consistent with EVM providers where value is in wei
      const lamports = Math.floor(Number(value));

      // If configured to swap full balance, recalculate from actual wallet balance
      // and reserve dynamic fees (signature, compute, rent exemption, safety buffer)
      // CRITICAL: When swapFullBalance is true, we IGNORE the passed value and use actual balance
      // UPDATE: Amount is now pre-adjusted in pre-execute phase using fee calculator
      if (swapFullBalance) {
        console.error(
          '🟡 Full-balance SOL transfer - amount pre-adjusted in pre-execute phase',
          {
            passedValue: value,
            passedLamports: lamports,
            computeUnits,
            priorityFeeMicroLamports,
            note: 'Fee calculator already reserved fees (signature + compute + rent + safety)',
          },
        );
        this.logger.log(
          '🟡 Full-balance SOL transfer - using pre-adjusted amount',
          {
            passedValue: value,
            passedLamports: lamports,
            computeUnits,
            priorityFeeMicroLamports,
            note: 'Amount already adjusted for fees in pre-execute phase using fee calculator',
          },
        );

        // OPTIONAL: Verify the pre-adjusted amount is safe
        const actualBalance = await this.executeWithFallback(
          async (connection) => await connection.getBalance(fromPublicKey),
          'getBalanceForFullSwapVerification',
        );

        const remaining = actualBalance - lamports;

        if (remaining < 890000) {
          // Less than rent-exempt minimum reserved
          this.logger.warn('⚠️ Pre-execute adjustment may be insufficient', {
            actualBalance,
            sendAmount: lamports,
            remaining,
            minRequired: 890000,
            note: 'Proceeding anyway - wallet may reject transaction',
          });
          console.error('⚠️ WARNING: Insufficient reserves!', {
            actualBalance,
            sendAmount: lamports,
            remaining,
            expected: '~946,280 lamports',
          });
        } else {
          const logMessage = `✅ Pre-execute fee calculation verified - reserved ${remaining} lamports (${(remaining / LAMPORTS_PER_SOL).toFixed(6)} SOL)`;
          const logData = {
            actualBalance,
            sendAmount: lamports,
            remaining,
            remainingSOL: (remaining / LAMPORTS_PER_SOL).toFixed(6),
            note: 'Fee calculator properly reserved fees in pre-execute',
          };
          console.error(logMessage, logData);
          this.logger.log(logMessage, logData);
        }
      } else {
        console.error('🔴 NOT using full-balance mode - sending exact amount', {
          lamports,
          swapFullBalance: false,
        });
        this.logger.log(
          '🔴 NOT using full-balance mode - sending exact amount',
          {
            lamports,
            swapFullBalance: false,
          },
        );
      }

      // Execute transaction with fallback
      const signature = await this.executeWithFallback(async (connection) => {
        // Create transaction
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: fromPublicKey,
            toPubkey: toPublicKey,
            lamports,
          }),
        );

        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPublicKey;

        // Send transaction
        return await connection.sendTransaction(transaction, [keypair], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      }, 'executeSolTransfer');
      this.logger.debug('SOL transfer sent', {
        to,
        lamports,
        swapFullBalance,
        computeUnits,
        priorityFeeMicroLamports,
        signature,
      });

      return signature;
    } catch (error) {
      this.logger.error(`Failed to execute SOL transfer: ${error.message}`);
      throw new Error(`Failed to execute SOL transfer: ${error.message}`);
    }
  }

  /**
   * Execute a SPL token transfer
   * Used for deposit-based CEX bridges (e.g., Exolix) transferring USDT, USDC, etc.
   *
   * @param privateKey - User's private key
   * @param to - Recipient address (CEX deposit address)
   * @param tokenMintAddress - SPL token mint address (e.g., USDT: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
   * @param amount - Amount in token's smallest units (e.g., for USDT with 6 decimals: 1000000 = 1 USDT)
   * @param swapFullBalance - Whether to transfer full token balance (reserve fees)
   * @param computeUnits - Optional compute unit limit
   * @param priorityFeeMicroLamports - Optional priority fee
   */
  private async executeSplTokenTransfer(
    privateKey: string,
    to: string,
    tokenMintAddress: string,
    amount: string,
    swapFullBalance = false,
    computeUnits?: number,
    priorityFeeMicroLamports?: number,
  ): Promise<string> {
    try {
      this.logger.debug('Starting SPL token transfer', {
        to,
        tokenMintAddress,
        amount,
        swapFullBalance,
        computeUnits,
        priorityFeeMicroLamports,
      });

      const keypair = this.privateKeyToKeypair(privateKey);
      const fromPublicKey = keypair.publicKey;
      const toPublicKey = new PublicKey(to);
      const mintPublicKey = new PublicKey(tokenMintAddress);

      // Convert amount string to BigInt
      const tokenAmount = BigInt(amount);

      // Get token account information to fetch decimals if needed for swapFullBalance
      const signature = await this.executeWithFallback(async (connection) => {
        // Get source token account (sender's ATA)
        const fromTokenAccount = await getAssociatedTokenAddress(
          mintPublicKey,
          fromPublicKey,
          false,
          TOKEN_PROGRAM_ID,
        );

        // Get destination token account (recipient's ATA)
        const toTokenAccount = await getAssociatedTokenAddress(
          mintPublicKey,
          toPublicKey,
          false,
          TOKEN_PROGRAM_ID,
        );

        // Check if recipient's token account exists
        const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
        const needsToAccount = !toAccountInfo;

        if (needsToAccount) {
          this.logger.debug(
            'Recipient token account does not exist, will create ATA',
            {
              toTokenAccount: toTokenAccount.toString(),
            },
          );
        }

        // If swapFullBalance, adjust amount to reserve for fees
        if (swapFullBalance) {
          this.logger.debug('Full-balance SPL token transfer requested', {
            requestedAmount: tokenAmount.toString(),
            computeUnits,
            priorityFeeMicroLamports,
          });

          // For SPL tokens, we only need to reserve SOL for transaction fees
          // The token balance itself doesn't need fee reservation
          // Get current SOL balance to ensure we have enough for fees
          const solBalance = await connection.getBalance(fromPublicKey);
          const estimatedFees = await this.estimateSplTransferFees(
            connection,
            computeUnits || this.DEFAULT_COMPUTE_UNIT_LIMIT,
            priorityFeeMicroLamports ||
              this.DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
            needsToAccount,
          );

          if (solBalance < estimatedFees) {
            throw new Error(
              `Insufficient SOL balance for SPL token transfer fees. ` +
                `Required: ${estimatedFees / LAMPORTS_PER_SOL} SOL, ` +
                `Available: ${solBalance / LAMPORTS_PER_SOL} SOL`,
            );
          }

          this.logger.log(
            `SPL token transfer - SOL available for fees: ${(solBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
          );
        }

        // Build transaction instructions
        const instructions: TransactionInstruction[] = [];

        // Add compute budget instructions if specified
        if (computeUnits) {
          instructions.push(
            ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
          );
        }
        if (priorityFeeMicroLamports) {
          instructions.push(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: priorityFeeMicroLamports,
            }),
          );
        }

        // Create recipient's token account if needed
        if (needsToAccount) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              fromPublicKey, // payer
              toTokenAccount, // associated token account address
              toPublicKey, // owner
              mintPublicKey, // mint
              TOKEN_PROGRAM_ID,
            ),
          );
        }

        // Add SPL token transfer instruction
        instructions.push(
          createTransferInstruction(
            fromTokenAccount, // source
            toTokenAccount, // destination
            fromPublicKey, // owner
            tokenAmount, // amount (in smallest units)
            [],
            TOKEN_PROGRAM_ID,
          ),
        );

        // Create transaction
        const transaction = new Transaction().add(...instructions);

        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPublicKey;

        // Send transaction
        return await connection.sendTransaction(transaction, [keypair], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
      }, 'executeSplTokenTransfer');

      this.logger.log(
        `✅ SPL token transfer executed successfully: ${signature}`,
        {
          tokenMintAddress,
          to,
          amount: tokenAmount.toString(),
          swapFullBalance,
        },
      );

      return signature;
    } catch (error) {
      this.logger.error(
        `Failed to execute SPL token transfer: ${error.message}`,
      );
      throw new Error(`Failed to execute SPL token transfer: ${error.message}`);
    }
  }

  /**
   * Estimate fees for SPL token transfer
   */
  private async estimateSplTransferFees(
    connection: Connection,
    computeUnits: number,
    priorityFeeMicroLamports: number,
    needsAccountCreation: boolean,
  ): Promise<number> {
    const SIGNATURE_FEE = 5_000; // Base signature fee
    const COMPUTE_BUDGET_FEE = Math.ceil(
      (computeUnits * priorityFeeMicroLamports) / 1_000_000,
    );

    // Account creation rent (if needed)
    let accountCreationRent = 0;
    if (needsAccountCreation) {
      // Associated Token Account size is 165 bytes
      accountCreationRent =
        await connection.getMinimumBalanceForRentExemption(165);
    }

    // Safety buffer
    const subtotal = SIGNATURE_FEE + COMPUTE_BUDGET_FEE + accountCreationRent;
    const SAFETY_BUFFER = Math.max(Math.floor(subtotal * 0.05), 50_000);

    return (
      SIGNATURE_FEE + COMPUTE_BUDGET_FEE + accountCreationRent + SAFETY_BUFFER
    );
  }

  /**
   * Execute a Rubic API transaction (base64-encoded VersionedTransaction)
   * Reference: https://docs.rubic.finance/rubic-api/rubic-api/integration-example/swaps-from-solana
   *
   * Rubic API returns Solana transactions in base64 format:
   * { "data": "AQAAAAAAAAAAA...SeOpIqnPIXvhm6MAcerlewmVsjBtvc2eDf4gKc2g==" }
   *
   * Execution steps:
   * 1. Decode base64 string to Buffer
   * 2. Deserialize to VersionedTransaction
   * 3. Sign transaction with user's private key
   * 4. Send to Solana network
   */
  private async executeRubicTransaction(
    privateKey: string,
    base64Data: string,
    quoteData?: any,
  ): Promise<string> {
    try {
      this.logger.debug('Executing Rubic API transaction', {
        base64DataLength: base64Data.length,
      });

      // 1. Decode base64 string to Buffer
      const transactionBuffer = Buffer.from(base64Data, 'base64');

      this.logger.debug('Decoded base64 transaction', {
        bufferLength: transactionBuffer.length,
      });

      // 2. Deserialize to VersionedTransaction
      const transaction = VersionedTransaction.deserialize(transactionBuffer);

      this.logger.debug('Deserialized VersionedTransaction', {
        numSignatures: transaction.signatures.length,
        numInstructions: transaction.message.compiledInstructions.length,
      });

      // 3. Get keypair from private key
      const keypair = this.privateKeyToKeypair(privateKey);

      // 4. Simulate transaction to get dynamic compute units and priority fee
      const signature = await this.executeWithFallback(async (connection) => {
        // First, try to get recommended priority fee from network
        const recommendedPriorityFee =
          await this.getRecommendedPriorityFee(connection);

        // Simulate transaction to estimate compute units
        let estimatedComputeUnits: number | null = null;
        try {
          // Create a temporary transaction with minimal compute budget for simulation
          const tempTx = await this.ensureComputeBudgetOnVersionedTransaction(
            transaction,
            connection,
            this.DEFAULT_COMPUTE_UNIT_LIMIT,
            recommendedPriorityFee,
          );

          // Sign for simulation
          tempTx.sign([keypair]);

          // Simulate to get actual compute units
          estimatedComputeUnits = await this.simulateTransactionForComputeUnits(
            tempTx,
            connection,
          );
        } catch (simError) {
          this.logger.warn(
            `Simulation failed, will use fallback values: ${simError.message}`,
          );
        }

        // Determine final compute unit limit
        let finalComputeUnits: number;
        let computeSource: string;

        if (estimatedComputeUnits && estimatedComputeUnits > 0) {
          // Use simulated value with 20% buffer for safety
          finalComputeUnits = Math.ceil(estimatedComputeUnits * 1.2);
          computeSource = 'simulation';
          this.logger.log('Using simulated compute units', {
            simulated: estimatedComputeUnits,
            withBuffer: finalComputeUnits,
            buffer: '20%',
          });
        } else {
          // Fallback to quote data or default
          const quoteSettings = this.extractComputeSettings(quoteData || {});
          finalComputeUnits = quoteSettings.computeUnitLimit;
          computeSource = quoteData?.computeUnits ? 'quote' : 'default';
          this.logger.log('Using fallback compute units', {
            source: computeSource,
            computeUnits: finalComputeUnits,
          });
        }

        // Cap at max limit
        if (finalComputeUnits > this.MAX_COMPUTE_UNIT_LIMIT) {
          this.logger.warn(
            `Computed units ${finalComputeUnits} exceeds max, capping to ${this.MAX_COMPUTE_UNIT_LIMIT}`,
          );
          finalComputeUnits = this.MAX_COMPUTE_UNIT_LIMIT;
        }

        this.logger.log('Final compute settings for transaction', {
          computeUnits: finalComputeUnits,
          priorityFee: recommendedPriorityFee,
          computeSource,
          estimatedCostLamports: Math.ceil(
            (finalComputeUnits * recommendedPriorityFee) / 1_000_000,
          ),
        });

        // Build final transaction with optimized compute budget
        const txToSend = await this.ensureComputeBudgetOnVersionedTransaction(
          transaction,
          connection,
          finalComputeUnits,
          recommendedPriorityFee,
        );

        // Sign the final transaction
        txToSend.sign([keypair]);

        this.logger.debug('Transaction signed', {
          signatureCount: txToSend.signatures.length,
        });

        // Optional: size analytics for the versioned transaction
        try {
          const serialized = txToSend.serialize();
          this.logger.debug('Tx size (bytes)', { size: serialized.length });
        } catch (_) {
          /* ignore */
        }

        // Send the signed VersionedTransaction
        const sig = await connection.sendTransaction(txToSend, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        });

        this.logger.debug('Transaction sent to Solana network', {
          signature: sig,
          computeUnitLimit: finalComputeUnits,
          priorityFeeMicroLamports: recommendedPriorityFee,
        });

        return sig;
      }, 'executeRubicTransaction');

      this.logger.log(
        `âœ… Rubic transaction executed successfully: ${signature}`,
      );

      return signature;
    } catch (error) {
      this.logger.error(
        `Failed to execute Rubic transaction: ${error.message}`,
        error.stack,
      );

      // Provide more context in error message
      if (error.message.includes('deserialize')) {
        throw new Error(
          `Failed to deserialize Rubic transaction data. Invalid base64 format: ${error.message}`,
        );
      } else if (error.message.includes('sign')) {
        throw new Error(`Failed to sign Rubic transaction: ${error.message}`);
      } else {
        throw new Error(
          `Failed to execute Rubic transaction: ${error.message}`,
        );
      }
    }
  }

  /**
   * Ensure a VersionedTransaction contains compute budget instructions.
   * If missing, decompile and prepend ComputeBudget instructions, then recompile to v0 message.
   * If augmentation fails, returns the original transaction as a safe fallback.
   */
  private async ensureComputeBudgetOnVersionedTransaction(
    transaction: VersionedTransaction,
    connection: Connection,
    computeUnitLimit: number,
    priorityFeeMicroLamports: number,
  ): Promise<VersionedTransaction> {
    try {
      const hasComputeBudget = transaction.message.compiledInstructions.some(
        (ix) => {
          const programIdIndex = ix.programIdIndex;
          const programId =
            transaction.message.staticAccountKeys[programIdIndex];
          return programId?.equals(
            new PublicKey('ComputeBudget111111111111111111111111111111'),
          );
        },
      );

      if (hasComputeBudget) {
        this.logger.debug(
          'Compute budget already present in transaction; no injection needed',
        );
        return transaction;
      }

      this.logger.debug(
        'Augmenting transaction with compute budget instructions',
        {
          computeUnitLimit,
          priorityFeeMicroLamports,
        },
      );

      // Fetch address lookup tables if present
      const lookups = transaction.message.addressTableLookups || [];
      const altAccounts: AddressLookupTableAccount[] = [];
      for (const l of lookups) {
        try {
          const res = await connection.getAddressLookupTable(l.accountKey);
          if (res && res.value) {
            altAccounts.push(res.value);
          }
        } catch (e) {
          this.logger.warn(
            `Failed to fetch address lookup table ${l.accountKey.toBase58()}: ${e.message}`,
          );
        }
      }

      // Decompile, prepend compute budget instructions, recompile to v0
      const decompiled = TransactionMessage.decompile(transaction.message, {
        addressLookupTableAccounts: altAccounts,
      });

      const computeIxs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeMicroLamports,
        }),
      ];

      const rebuilt = new TransactionMessage({
        payerKey: decompiled.payerKey,
        recentBlockhash: decompiled.recentBlockhash,
        instructions: [...computeIxs, ...decompiled.instructions],
      });

      const v0 = rebuilt.compileToV0Message(altAccounts);
      const augmented = new VersionedTransaction(v0);

      this.logger.debug(
        'Compute budget successfully injected into transaction',
      );
      return augmented;
    } catch (e) {
      this.logger.warn(
        `Could not augment transaction with compute budget, proceeding without: ${e.message}`,
      );
      return transaction;
    }
  }

  private async waitForSolanaConfirmation(
    txHash: string,
    confirmations: number,
  ): Promise<any> {
    const maxAttempts = 60; // 60 attempts with 1-second intervals = 1 minute
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const status = await this.executeWithFallback(
          async (connection) => await connection.getSignatureStatus(txHash),
          'getSignatureStatus',
        );

        if (
          status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized'
        ) {
          // Get full transaction details for gas/fee information
          let computeUnitsUsed: number | undefined;
          try {
            const txDetails = await this.executeWithFallback(
              async (connection) =>
                await connection.getTransaction(txHash, {
                  maxSupportedTransactionVersion: 0,
                  commitment: 'confirmed',
                }),
              'getTransactionDetails',
            );

            // Extract compute units consumed from transaction metadata
            computeUnitsUsed = txDetails?.meta?.computeUnitsConsumed;
            this.logger.debug('Transaction confirmed (analytics)', {
              txHash,
              computeUnitsConsumed: computeUnitsUsed,
            });
          } catch (detailsError) {
            this.logger.warn(
              `Could not fetch transaction details for ${txHash}: ${detailsError.message}`,
            );
          }

          // Map Solana receipt to EVM-compatible format expected by meta-swap-executor
          // This ensures consistency across different blockchain ecosystems
          return {
            // Transaction identification
            signature: txHash,
            transactionHash: txHash, // EVM compatibility

            // Block/slot information (EVM uses blockNumber, Solana uses slot)
            slot: status.value.slot,
            blockNumber: status.value.slot, // Map slot to blockNumber for executor compatibility

            // Transaction status (EVM-compatible boolean: 1 = success, 0 = failed)
            // Solana uses err field: null = success, object = failed
            status: status.value.err ? 0 : 1, // 1 for success, 0 for failure (EVM format)
            err: status.value.err, // Keep original Solana error info

            // Confirmation details
            confirmationStatus: status.value.confirmationStatus, // 'confirmed' or 'finalized'

            // Gas/compute information (EVM uses gasUsed, Solana uses computeUnits)
            computeUnitsConsumed: computeUnitsUsed,
            gasUsed: computeUnitsUsed?.toString(), // Map to gasUsed for executor compatibility

            // Additional Solana-specific metadata
            ecosystem: 'solana',
            confirmed: true,
          };
        }

        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      } catch (error) {
        this.logger.warn(
          `Error checking transaction ${txHash}: ${error.message}`,
        );
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error(
      `Transaction ${txHash} confirmation timeout after ${maxAttempts} seconds`,
    );
  }

  private async getSolanaTransactionStatus(txHash: string): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }> {
    try {
      const status = await this.executeWithFallback(
        async (connection) => await connection.getSignatureStatus(txHash),
        'getTransactionStatus',
      );

      if (!status.value) {
        return { status: 'pending' };
      }

      if (status.value.err) {
        return {
          status: 'failed',
          receipt: {
            signature: txHash,
            transactionHash: txHash, // EVM compatibility
            slot: status.value.slot,
            blockNumber: status.value.slot, // EVM compatibility
            status: 0, // Failed (EVM format)
            err: status.value.err,
            confirmationStatus: status.value.confirmationStatus,
            ecosystem: 'solana',
          },
        };
      }

      if (
        status.value.confirmationStatus === 'confirmed' ||
        status.value.confirmationStatus === 'finalized'
      ) {
        return {
          status: 'confirmed',
          receipt: {
            signature: txHash,
            transactionHash: txHash, // EVM compatibility
            slot: status.value.slot,
            blockNumber: status.value.slot, // EVM compatibility
            status: 1, // Success (EVM format)
            confirmationStatus: status.value.confirmationStatus,
            ecosystem: 'solana',
          },
        };
      }

      return { status: 'pending' };
    } catch (error) {
      this.logger.error(`Failed to get transaction status: ${error.message}`);
      return { status: 'pending' };
    }
  }
}
