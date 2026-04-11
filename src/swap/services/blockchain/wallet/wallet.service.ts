import { Injectable, BadRequestException } from '@nestjs/common';
import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import { IWalletProvider } from './ports/wallet-provider.interface';
import { IWalletProviderRegistry } from './ports/wallet-provider-registry.interface';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { normalizeChainId } from '@shared/config/unified-token-configuration.config';

/**
 * Unified wallet service that manages multi-chain wallet operations
 * Routes requests to appropriate blockchain-specific wallet providers
 * NOW WITH SELF-REGISTRATION: Wallet providers register themselves automatically
 */
@Injectable()
export class WalletService implements IWalletProviderRegistry {
  private readonly providers: Map<string, IWalletProvider> = new Map();
  private registrationComplete = false;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.winstonLogger.setContext('WalletService');
    this.winstonLogger.log(
      'WalletService initialized - awaiting wallet provider self-registration',
    );
  }

  /**
   * Register a wallet provider (called by providers themselves)
   */
  registerWalletProvider(provider: IWalletProvider): void {
    const ecosystem = provider.getEcosystem();

    if (this.providers.has(ecosystem)) {
      this.winstonLogger.warn(
        `⚠️ Wallet provider '${ecosystem}' already registered, skipping duplicate`,
      );
      return;
    }

    this.providers.set(ecosystem, provider);
    this.winstonLogger.log(`✅ Self-registered wallet provider: ${ecosystem}`);
  }

  /**
   * Mark registration as complete and log summary
   */
  onRegistrationComplete(): void {
    if (this.registrationComplete) return;

    this.registrationComplete = true;
    this.winstonLogger.log(
      `📊 Wallet provider registration complete - Total: ${this.providers.size} providers`,
    );

    if (this.providers.size > 0) {
      this.winstonLogger.log(
        `  🔗 Registered ecosystems: ${Array.from(this.providers.keys()).join(', ')}`,
      );
    }
  }

  /**
   * Get all registered wallet providers
   */
  getWalletProviders(): Map<string, IWalletProvider> {
    return this.providers;
  }

  /**
   * Get wallet provider by ecosystem
   */
  getWalletProvider(ecosystem: string): IWalletProvider | undefined {
    return this.providers.get(ecosystem.toLowerCase());
  }

  /**
   * Get appropriate wallet provider for a chain
   * Prioritizes chainId matching over ecosystem for more accurate provider selection
   */
  private getProviderForChain(
    chainId: number | string,
    ecosystem?: string,
  ): IWalletProvider {
    // Normalize chain identifiers to account for aliases (e.g., 195 -> 'tron-mainnet')
    const normalizedChainId = normalizeChainId(chainId);
    const candidateChainIds: Array<number | string> = [];

    const pushCandidate = (candidate: number | string | undefined | null) => {
      if (candidate === undefined || candidate === null) {
        return;
      }
      if (!candidateChainIds.some((existing) => existing === candidate)) {
        candidateChainIds.push(candidate);
      }
    };

    pushCandidate(chainId);
    pushCandidate(normalizedChainId);

    if (typeof normalizedChainId === 'string') {
      pushCandidate(normalizedChainId.toLowerCase());
    }

    this.winstonLogger.log(
      `🔍 Locating wallet provider for chainId: ${chainId} ` +
        `${normalizedChainId !== chainId ? `(normalized: ${normalizedChainId}) ` : ''}` +
        `${ecosystem ? `and ecosystem: ${ecosystem}` : ''}`,
    );

    for (const provider of this.providers.values()) {
      if (
        candidateChainIds.some((candidate) => provider.supportsChain(candidate))
      ) {
        return provider;
      }
    }

    // If no provider found by chainId and ecosystem is specified, try ecosystem fallback
    if (ecosystem) {
      const provider = this.providers.get(ecosystem.toLowerCase());
      if (provider) {
        this.winstonLogger.warn(
          `Using ecosystem fallback for chain ${chainId} with ecosystem ${ecosystem}`,
        );
        return provider;
      }
      throw new BadRequestException(
        `No wallet provider found for chain ${chainId} or ecosystem ${ecosystem}`,
      );
    }

    throw new BadRequestException(
      `No wallet provider found for chain: ${chainId}`,
    );
  }

  /**
   * Get wallet balance for a token (multi-chain support)
   */
  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
    ecosystem?: string,
  ): Promise<BalanceInfo> {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      const balance = await provider.getBalance(
        chainId,
        walletAddress,
        tokenAddress,
      );

      const duration = Date.now() - startTime;

      // Audit log balance query
      this.winstonLogger.audit('WALLET_BALANCE_QUERY', {
        chainId,
        walletAddress,
        tokenAddress: tokenAddress || 'native',
        balance: balance.balance,
        decimals: balance.decimals,
        symbol: balance.symbol,
        ecosystem: provider.getEcosystem(),
        duration,
        timestamp: new Date().toISOString(),
      });

      return balance;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get balance on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get multiple token balances (multi-chain support)
   */
  async getMultipleBalances(
    chainId: number | string,
    walletAddress: string,
    tokenAddresses: string[],
    ecosystem?: string,
  ): Promise<BalanceInfo[]> {
    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      return await provider.getMultipleBalances(
        chainId,
        walletAddress,
        tokenAddresses,
      );
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get multiple balances on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get token information (multi-chain support)
   */
  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
    ecosystem?: string,
  ): Promise<TokenInfo> {
    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      return await provider.getTokenInfo(chainId, tokenAddress);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get token info on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Check token allowance (multi-chain support, EVM-specific)
   */
  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
    ecosystem?: string,
  ): Promise<string> {
    try {
      const provider = this.getProviderForChain(chainId, ecosystem);

      // Check if provider supports allowance (optional method)
      if (!provider.getAllowance) {
        throw new BadRequestException(
          `Allowance check not supported for chain: ${chainId}`,
        );
      }

      return await provider.getAllowance(chainId, tokenAddress, owner, spender);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get allowance on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Execute approval transaction (multi-chain support, EVM-specific)
   */
  async executeApproval(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
    ecosystem?: string,
  ): Promise<string> {
    try {
      const provider = this.getProviderForChain(chainId, ecosystem);

      // Check if provider supports approval (optional method)
      if (!provider.executeApproval) {
        throw new BadRequestException(
          `Approval execution not supported for chain: ${chainId}`,
        );
      }

      return await provider.executeApproval(
        chainId,
        privateKey,
        tokenAddress,
        spender,
        amount,
      );
    } catch (error) {
      this.winstonLogger.error(
        `Failed to execute approval on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Execute swap transaction (multi-chain support)
   */
  async executeSwap(
    chainId: number | string,
    privateKey: string,
    to: string,
    data: string,
    value: string,
    gasLimit?: string,
    ecosystem?: string,
    gasPrices?: {
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
      gasPrice?: string;
    },
  ): Promise<string> {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, ecosystem);

      // Audit log transaction submission
      this.winstonLogger.audit('TRANSACTION_SENT', {
        chainId,
        to,
        value,
        gasLimit,
        ecosystem: provider.getEcosystem(),
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.debug(
        `Executing transaction - Chain: ${chainId}, To: ${to}, Value: ${value}, GasLimit: ${gasLimit || 'not specified'}, Ecosystem: ${provider.getEcosystem()}`,
      );
      this.winstonLogger.log(
        `🔷 WALLET SERVICE: About to call provider.executeTransaction() - Ecosystem: ${provider.getEcosystem()}, Chain: ${chainId}`,
      );
      const txHash = await provider.executeTransaction(
        chainId,
        privateKey,
        to,
        data,
        value,
        gasLimit,
        gasPrices,
      );
      this.winstonLogger.log(
        `🔷 WALLET SERVICE: Returned from provider.executeTransaction() - TxHash: ${txHash}`,
      );

      const duration = Date.now() - startTime;

      // Audit log transaction success
      this.winstonLogger.audit('TRANSACTION_SUBMITTED', {
        chainId,
        transactionHash: txHash,
        to,
        value,
        ecosystem: provider.getEcosystem(),
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(
        `Transaction submitted successfully in ${duration}ms - Hash: ${txHash}, Chain: ${chainId}, Ecosystem: ${provider.getEcosystem()}`,
      );
      return txHash;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log transaction failure
      this.winstonLogger.audit('TRANSACTION_FAILED', {
        chainId,
        to,
        value,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to execute transaction on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Estimate gas for a transaction (multi-chain support)
   */
  async estimateGas(
    chainId: number | string,
    from: string,
    to: string,
    data: string,
    value?: string,
    ecosystem?: string,
  ): Promise<string> {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      if (!provider.estimateGas) {
        this.winstonLogger.warn(
          `Gas estimation not supported for chain ${chainId} in ecosystem ${provider.getEcosystem()}`,
        );
        throw new BadRequestException(
          `Gas estimation not supported for chain: ${chainId}`,
        );
      }

      this.winstonLogger.debug(
        `Estimating gas - Chain: ${chainId}, From: ${from}, To: ${to}, Value: ${value || '0'}, DataLength: ${data?.length || 0}`,
      );
      const gasEstimate = await provider.estimateGas(
        chainId,
        from,
        to,
        data,
        value,
      );
      const duration = Date.now() - startTime;

      this.winstonLogger.debug(
        `Gas estimation completed in ${duration}ms - Chain: ${chainId}, GasEstimate: ${gasEstimate}`,
      );

      // Audit log gas estimation
      this.winstonLogger.audit('WALLET_GAS_ESTIMATED', {
        chainId,
        from,
        to,
        gasEstimate,
        value: value || '0',
        ecosystem: provider.getEcosystem(),
        duration,
        timestamp: new Date().toISOString(),
      });

      return gasEstimate;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log gas estimation failure
      this.winstonLogger.audit('WALLET_GAS_ESTIMATION_FAILED', {
        chainId,
        from,
        to,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to estimate gas on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Estimate fee data (EIP-1559 or legacy) via the underlying provider
   */
  async estimateFees(
    chainId: number | string,
    ecosystem?: string,
  ): Promise<
    | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }
    | { type: 'legacy'; gasPrice: string }
  > {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      if (!provider.estimateFees) {
        // Fallback: try to synthesize legacy gasPrice via execute provider where possible
        throw new BadRequestException(
          `Fee estimation not supported for chain: ${chainId}`,
        );
      }

      const feeData = await provider.estimateFees(chainId);
      const duration = Date.now() - startTime;

      // Audit log fee estimation
      this.winstonLogger.audit('WALLET_FEES_ESTIMATED', {
        chainId,
        feeType: feeData.type,
        ...(feeData.type === 'eip1559'
          ? {
              maxFeePerGas: feeData.maxFeePerGas,
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            }
          : { gasPrice: feeData.gasPrice }),
        ecosystem: provider.getEcosystem(),
        duration,
        timestamp: new Date().toISOString(),
      });

      return feeData;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log fee estimation failure
      this.winstonLogger.audit('WALLET_FEE_ESTIMATION_FAILED', {
        chainId,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  /**
   * Estimate Solana transaction cost dynamically
   * Routes to Solana wallet provider's estimateTransactionCost method
   */
  async estimateSolanaTransactionCost(
    chainId: number | string,
    transactionData?: string | any,
    walletAddress?: string,
  ): Promise<{
    computeUnits: number;
    priorityFee: number;
    totalCost: string;
  }> {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, 'solana');

      if (!provider || provider.getEcosystem() !== 'solana') {
        throw new BadRequestException(
          `Solana provider not found for chain: ${chainId}`,
        );
      }

      // Check if provider has estimateTransactionCost method
      if (typeof (provider as any).estimateTransactionCost !== 'function') {
        throw new BadRequestException(
          `Provider does not support dynamic transaction cost estimation`,
        );
      }

      const estimation = await (provider as any).estimateTransactionCost(
        chainId,
        transactionData,
        walletAddress,
      );

      const duration = Date.now() - startTime;

      // Audit log estimation
      this.winstonLogger.audit('SOLANA_TRANSACTION_COST_ESTIMATED', {
        chainId,
        computeUnits: estimation.computeUnits,
        priorityFee: estimation.priorityFee,
        totalCost: estimation.totalCost,
        hasTransactionData: !!transactionData,
        duration,
        timestamp: new Date().toISOString(),
      });

      return estimation;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log estimation failure
      this.winstonLogger.audit('SOLANA_TRANSACTION_COST_ESTIMATION_FAILED', {
        chainId,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to estimate fees on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Wait for transaction confirmation (multi-chain support)
   */
  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
    ecosystem?: string,
  ): Promise<any> {
    const startTime = Date.now();

    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      const receipt = await provider.waitForTransactionConfirmation(
        chainId,
        txHash,
        confirmations,
      );

      const duration = Date.now() - startTime;

      // Audit log transaction confirmed
      this.winstonLogger.audit('TRANSACTION_CONFIRMED', {
        chainId,
        transactionHash: txHash,
        confirmations,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed?.toString(),
        status: receipt?.status === 'success' ? 'success' : 'reverted',
        ecosystem: provider.getEcosystem(),
        duration,
        timestamp: new Date().toISOString(),
      });

      return receipt;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log confirmation timeout/failure
      this.winstonLogger.audit('TRANSACTION_CONFIRMATION_FAILED', {
        chainId,
        transactionHash: txHash,
        confirmations,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to wait for transaction on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get transaction status (multi-chain support)
   */
  async getTransactionStatus(
    chainId: number | string,
    txHash: string,
    ecosystem?: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }> {
    try {
      const provider = this.getProviderForChain(chainId, ecosystem);
      return await provider.getTransactionStatus(chainId, txHash);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get transaction status on chain ${chainId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get all registered wallet providers
   */
  getProviders(): Map<string, IWalletProvider> {
    return this.providers;
  }

  /**
   * Get provider by ecosystem
   */
  getProvider(ecosystem: string): IWalletProvider | undefined {
    return this.providers.get(ecosystem.toLowerCase());
  }

  /**
   * Parse transaction receipt to extract token transfers (multi-chain support)
   * Primarily for EVM chains - other chains may not support this
   */
  parseTransactionReceipt(
    receipt: any,
    tokenAddress: string,
    chainId?: number | string,
    ecosystem?: string,
  ): Array<{ from: string; to: string; amount: bigint }> {
    try {
      // If chainId is provided, use it to get the right provider
      let provider: IWalletProvider | undefined;

      if (chainId) {
        provider = this.getProviderForChain(chainId, ecosystem);
      } else if (ecosystem) {
        provider = this.providers.get(ecosystem.toLowerCase());
      } else {
        // Default to EVM provider for backward compatibility
        provider = this.providers.get('evm');
      }

      if (!provider) {
        throw new BadRequestException(
          'No provider found for parsing transaction receipt',
        );
      }

      // Check if provider supports receipt parsing
      if (!provider.parseTransactionReceipt) {
        this.winstonLogger.warn(
          `Provider ${provider.getEcosystem()} does not support transaction receipt parsing`,
        );
        return [];
      }

      return provider.parseTransactionReceipt(receipt, tokenAddress);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to parse transaction receipt: ${error.message}`,
        error.stack,
      );
      // Return empty array instead of throwing to maintain backward compatibility
      return [];
    }
  }
}
