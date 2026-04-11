import { Injectable, OnModuleInit, Optional, Inject } from '@nestjs/common';
import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  formatEther,
  formatUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainUtilsService, isNativeToken } from '@shared/utils/chain.utils';
import {
  createProvider,
  ERC20_ABI,
  waitForTransaction,
  parseTokenTransfers,
} from '@shared/utils/ethereum.utils';
import { RpcFallbackService } from '@shared/services/rpc-fallback.service';
import { EtherscanService } from '@shared/services/etherscan.service';
import { NodeRealService } from '@shared/services/nodereal.service';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import {
  validateWalletAddress,
  validatePrivateKey,
} from '@shared/utils/validation.utils';
import {
  IWalletProvider,
  WalletProviderConfig,
} from '../ports/wallet-provider.interface';
import type { IWalletProviderRegistry } from '../ports/wallet-provider-registry.interface';
import { WalletService } from '../wallet.service';
import {
  CHAIN_DETECTION_CONFIG,
  isChainIdInEcosystem,
} from '@config/swap-config';

/**
 * EVM-specific wallet provider for Ethereum and EVM-compatible chains
 * NOW WITH SELF-REGISTRATION: Automatically registers itself with WalletService
 */
@Injectable()
export class EvmWalletProvider implements IWalletProvider, OnModuleInit {
  private readonly logger: WinstonLoggerService;

  constructor(
    private readonly chainUtils: ChainUtilsService,
    private readonly rpcFallback: RpcFallbackService,
    private readonly etherscanService: EtherscanService,
    private readonly nodeRealService: NodeRealService,
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(WalletService)
    private readonly registry?: IWalletProviderRegistry,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(EvmWalletProvider.name);
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
  }

  getEcosystem(): string {
    return 'evm';
  }

  supportsChain(chainId: number | string): boolean {
    // EVM chains are numeric
    const numericChainId =
      typeof chainId === 'string' ? parseInt(chainId) : chainId;

    // Use configuration-based detection to exclude non-EVM chains
    if (
      isChainIdInEcosystem(numericChainId, 'solana', CHAIN_DETECTION_CONFIG) ||
      isChainIdInEcosystem(numericChainId, 'tron', CHAIN_DETECTION_CONFIG) ||
      isChainIdInEcosystem(numericChainId, 'bitcoin', CHAIN_DETECTION_CONFIG)
    ) {
      return false;
    }

    // Basic check - any numeric chain ID is potentially EVM
    // For production, you might want a whitelist
    return !isNaN(numericChainId) && numericChainId > 0;
  }

  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo> {
    try {
      validateWalletAddress(walletAddress);
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const chainConfig = this.chainUtils.getChainConfig(numericChainId);
      const provider =
        await this.createPublicClientWithFallback(numericChainId);
      this.logger.debug(
        `Fetching balance for ${walletAddress} on chain ${chainId} for token ${tokenAddress || 'native'}`,
      );

      if (!tokenAddress || isNativeToken(tokenAddress)) {
        // Get native token balance
        const balance = await provider.getBalance({
          address: walletAddress as Address,
        });
        this.logger.debug(
          `Fetched native balance for ${walletAddress} on chain ${chainId}: ${balance.toString()}`,
        );
        return {
          tokenAddress: '0x0000000000000000000000000000000000000000',
          balance: balance.toString(),
          formattedBalance: formatEther(balance),
          decimals: 18,
          symbol: chainConfig.nativeCurrency.symbol,
        };
      }

      // Get ERC-20 token balance
      const contract = getContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        client: provider,
      });

      const [balance, decimals, symbol] = await Promise.all([
        contract.read.balanceOf([walletAddress as Address]),
        contract.read.decimals(),
        contract.read.symbol(),
      ]);

      return {
        tokenAddress,
        balance: balance.toString(),
        formattedBalance: formatUnits(balance, decimals),
        decimals: Number(decimals),
        symbol,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get EVM balance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get EVM balance: ${error.message}`);
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

  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const chainConfig = this.chainUtils.getChainConfig(numericChainId);
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      if (isNativeToken(tokenAddress)) {
        return {
          address: tokenAddress,
          symbol: chainConfig.nativeCurrency.symbol,
          name: chainConfig.nativeCurrency.name,
          decimals: chainConfig.nativeCurrency.decimals,
          chainId: numericChainId,
          isNative: true,
        };
      }

      const contract = getContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        client: provider,
      });

      const [name, symbol, decimals] = await Promise.all([
        contract.read.name(),
        contract.read.symbol(),
        contract.read.decimals(),
      ]);

      return {
        address: tokenAddress,
        symbol,
        name,
        decimals: Number(decimals),
        chainId: numericChainId,
        isNative: false,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get EVM token info: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get EVM token info: ${error.message}`);
    }
  }

  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    try {
      if (isNativeToken(tokenAddress)) {
        return '0'; // Native tokens don't need allowance
      }

      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const provider =
        await this.createPublicClientWithFallback(numericChainId);
      const contract = getContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        client: provider,
      });

      const allowance = await contract.read.allowance([
        owner as Address,
        spender as Address,
      ]);
      return allowance.toString();
    } catch (error) {
      this.logger.error(
        `Failed to get EVM allowance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get EVM allowance: ${error.message}`);
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
      validatePrivateKey(privateKey);
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;

      if (isNativeToken(tokenAddress)) {
        throw new Error('Cannot approve native token');
      }

      const { wallet: walletClient } = this.createWalletClientWithFallback(
        numericChainId,
        privateKey,
      );

      // Use writeContract instead of getContract for write operations
      const hash = await walletClient.writeContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender as Address, BigInt(amount)],
        // Remove chain: null to allow proper broadcasting
      });

      this.logger.log(`EVM approval transaction sent: ${hash}`);
      return hash;
    } catch (error) {
      this.logger.error(
        `Failed to execute EVM approval: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute EVM approval: ${error.message}`);
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
      validatePrivateKey(privateKey);
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;

      const { wallet: walletClient } = this.createWalletClientWithFallback(
        numericChainId,
        privateKey,
      );

      // CRITICAL: Use provided gas prices if available (from estimation)
      // This ensures consistency between gas cost calculation and transaction execution
      // If not provided, fetch fresh gas prices from the network
      let feeData;
      if (
        providedGasPrices &&
        (providedGasPrices.maxFeePerGas || providedGasPrices.gasPrice)
      ) {
        // Use provided gas prices from estimation phase
        if (providedGasPrices.maxFeePerGas) {
          feeData = {
            type: 'eip1559' as const,
            maxFeePerGas: providedGasPrices.maxFeePerGas,
            maxPriorityFeePerGas: providedGasPrices.maxPriorityFeePerGas || '0',
          };
          this.logger.debug(
            'Using provided EIP-1559 gas prices for transaction',
            {
              maxFeePerGas: providedGasPrices.maxFeePerGas,
              maxPriorityFeePerGas: providedGasPrices.maxPriorityFeePerGas,
              chainId: numericChainId,
            },
          );
        } else {
          feeData = {
            type: 'legacy' as const,
            gasPrice: providedGasPrices.gasPrice!,
          };
          this.logger.debug('Using provided legacy gas price for transaction', {
            gasPrice: providedGasPrices.gasPrice,
            chainId: numericChainId,
          });
        }
      } else {
        // Fetch fresh gas prices from network
        feeData = await this.estimateFees(numericChainId);
        this.logger.debug('Fetched fresh gas prices for transaction', {
          feeData,
          chainId: numericChainId,
        });
      }

      // Fetch current nonce explicitly to avoid issues with stale "queued cost" from RPC
      // Use 'latest' to get nonce from latest mined block (not including pending txs)
      // This helps when RPC reports phantom "queued cost" for non-existent pending txs
      const publicClient =
        await this.createPublicClientWithFallback(numericChainId);
      const nonce = await publicClient.getTransactionCount({
        address: walletClient.account.address,
        blockTag: 'latest',
      });

      const txParams: any = {
        to: to as Address,
        data: data as Hex,
        value: BigInt(value),
        gas: gasLimit ? BigInt(gasLimit) : undefined,
        nonce, // Explicitly set nonce to avoid RPC confusion
        // Remove chain: null to allow proper broadcasting
      };

      this.logger.debug('Transaction nonce explicitly fetched', {
        nonce,
        address: walletClient.account.address,
        chainId: numericChainId,
      });

      // Set gas prices based on fee type (EIP-1559 or legacy)
      if (feeData.type === 'eip1559') {
        txParams.maxFeePerGas = BigInt(feeData.maxFeePerGas);
        txParams.maxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas);
        this.logger.debug(
          'Using EIP-1559 gas pricing for transaction execution',
          {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            chainId: numericChainId,
          },
        );
      } else {
        txParams.gasPrice = BigInt(feeData.gasPrice);
        this.logger.debug(
          'Using legacy gas pricing for transaction execution',
          {
            gasPrice: feeData.gasPrice,
            chainId: numericChainId,
          },
        );
      }

      this.logger.debug('Sending transaction to network', {
        to: txParams.to,
        value: txParams.value.toString(),
        chainId: numericChainId,
        hasData: !!txParams.data,
        dataLength: txParams.data?.length || 0,
      });

      const hash = await walletClient.sendTransaction(txParams);

      // Immediately verify transaction was broadcast by waiting for it to appear on chain
      // Uses viem's waitForTransactionReceipt with short timeout and retries
      // This ensures transaction actually made it to the network before we return
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      try {
        await provider.waitForTransactionReceipt({
          hash: hash as Hex,
          confirmations: 0, // Just check if it's in mempool/pending, don't wait for confirmations
          timeout: 180_000, // 180 seconds to verify broadcast
          pollingInterval: 10_000, // Check every 10 seconds
          retryCount: 5, // Retry 5 times
          retryDelay: 5_000, // 5 seconds between retries
        });

        this.logger.log(`✅ EVM transaction broadcast verified: ${hash}`);
        return hash;
      } catch (error) {
        // If we timeout or can't find the transaction, it means it wasn't broadcast
        this.logger.error(
          `❌ Transaction ${hash} was signed but never appeared on network: ${error.message}`,
        );
        throw new Error(
          `Transaction was signed locally but failed to broadcast to network. Hash: ${hash}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to execute EVM transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute EVM transaction: ${error.message}`);
    }
  }

  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
  ): Promise<TransactionReceipt> {
    try {
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      // Use viem's waitForTransactionReceipt with proper retry and polling
      const receipt = await waitForTransaction(
        provider,
        txHash as Hex,
        confirmations,
        {
          timeout: 300_000, // 5 minutes for cross-chain transactions
          pollingInterval: 4_000, // 4 seconds between checks
          retryCount: 6, // Retry 6 times if block/tx not found
        },
      );

      this.logger.log(
        `EVM transaction confirmed: ${txHash} with ${confirmations} confirmation(s)`,
      );
      return receipt;
    } catch (error) {
      this.logger.error(
        `Failed to wait for EVM transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to wait for EVM transaction: ${error.message}`);
    }
  }

  parseTransactionReceipt(
    receipt: TransactionReceipt,
    tokenAddress: string,
  ): Array<{ from: string; to: string; amount: bigint }> {
    return parseTokenTransfers(receipt, tokenAddress);
  }

  async getTransactionStatus(
    chainId: number | string,
    txHash: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: TransactionReceipt;
  }> {
    try {
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      const tx = await provider.getTransaction({ hash: txHash as Hex });
      if (!tx) {
        throw new Error('Transaction not found');
      }

      if (tx.blockNumber) {
        const receipt = await provider.getTransactionReceipt({
          hash: txHash as Hex,
        });
        if (receipt) {
          return {
            status: receipt.status === 'success' ? 'confirmed' : 'failed',
            receipt,
          };
        }
      }

      return { status: 'pending' };
    } catch (error) {
      this.logger.error(
        `Failed to get EVM transaction status: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get EVM transaction status: ${error.message}`);
    }
  }

  /**
   * Get RPC URLs for a chain with fallback support
   * Uses chainUtils to get multiple URLs configured for the chain
   */
  private getRpcUrls(chainId: number): string[] {
    try {
      return this.chainUtils.getRpcUrlsForChain(chainId);
    } catch (error) {
      this.logger.warn(
        `Failed to get RPC URLs for chain ${chainId}: ${error.message}`,
      );
      // Fallback to chain config single URL
      const chainConfig = this.chainUtils.getChainConfig(chainId);
      return [chainConfig.rpcUrl];
    }
  }

  /**
   * Create public client with RPC fallback support
   * Tries to get best URL from RPC Fallback Service first
   */
  private async createPublicClientWithFallback(
    chainId: number,
  ): Promise<PublicClient> {
    const rpcUrls = this.getRpcUrls(chainId);

    // Use RPC Fallback Service to get the best URL
    const bestUrl = this.rpcFallback.getBestUrl(rpcUrls);

    this.logger.debug(
      `Creating public client for chain ${chainId} with URL: ${bestUrl}`,
    );

    return createProvider(bestUrl);
  }

  /**
   * Create wallet client with RPC fallback support
   */
  private createWalletClientWithFallback(
    chainId: number,
    privateKey: string,
  ): { wallet: any; public: PublicClient } {
    const rpcUrls = this.getRpcUrls(chainId);
    const bestUrl = this.rpcFallback.getBestUrl(rpcUrls);
    const account = privateKeyToAccount(privateKey as Hex);

    this.logger.debug(
      `Creating wallet client for chain ${chainId} with URL: ${bestUrl}`,
    );

    const walletClient = createWalletClient({
      account,
      transport: http(bestUrl, {
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      }),
    });

    const publicClient = createPublicClient({
      transport: http(bestUrl, {
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      }),
    });

    return { wallet: walletClient, public: publicClient };
  }

  getConfig(): WalletProviderConfig {
    return {
      name: 'EVM Wallet Provider',
      ecosystem: 'evm',
      enabled: true,
      supportedChains: [], // All numeric chain IDs
    };
  }

  /**
   * Estimate gas for an EVM transaction
   */
  async estimateGas(
    chainId: number | string,
    from: string,
    to: string,
    data: string,
    value?: string,
  ): Promise<string> {
    try {
      const numericChainId =
        typeof chainId === 'string' ? parseInt(chainId) : chainId;
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      const gas = await provider.estimateGas({
        account: from as Address,
        to: to as Address,
        data: data as Hex,
        value: value ? BigInt(value) : undefined,
      });

      return gas.toString();
    } catch (error) {
      this.logger.warn(`EVM gas estimation failed: ${error.message}`);
      throw new Error(`Gas estimation failed: ${error.message}`);
    }
  }

  /**
   * Estimate EIP-1559 fee data when supported, otherwise legacy gasPrice
   * PRIMARY SOURCE: Etherscan Gas Oracle API (if available and chain supported)
   * FALLBACK: RPC-based estimation
   *
   * For chains with very low baseFee (< 1 gwei), falls back to legacy getGasPrice()
   * to handle fixed-price chains like BSC that are EIP-1559 compatible but use fixed gas prices
   */
  /**
   * Get chain-specific static gas price fallback
   * Used as final fallback when all dynamic sources fail
   */
  private getStaticGasPrice(chainId: number): string {
    // Chain-specific static gas prices (in wei)
    const staticPrices: Record<number, string> = {
      1: '30000000000', // 30 gwei for Ethereum mainnet
      56: '5000000000', // 5 gwei for BSC
      137: '50000000000', // 50 gwei for Polygon
      42161: '100000000', // 0.1 gwei for Arbitrum
      43114: '25000000000', // 25 gwei for Avalanche
      8453: '100000000', // 0.1 gwei for Base
      10: '100000000', // 0.1 gwei for OP Mainnet
      100: '2000000000', // 2 gwei for Gnosis
      250: '100000000000', // 100 gwei for Fantom
      324: '100000000', // 0.1 gwei for zkSync
      59144: '100000000', // 0.1 gwei for Linea
      534352: '100000000', // 0.1 gwei for Scroll
      42220: '5000000000', // 5 gwei for Celo
      204: '5000000000', // 5 gwei for opBNB
      5000: '100000000', // 0.1 gwei for Mantle
    };

    return staticPrices[chainId] || '20000000000'; // 20 gwei generic default
  }

  async estimateFees(
    chainId: number | string,
  ): Promise<
    | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }
    | { type: 'legacy'; gasPrice: string }
  > {
    const numericChainId =
      typeof chainId === 'string' ? parseInt(chainId) : chainId;
    const ONE_GWEI = 1n * 10n ** 9n; // 1 gwei threshold for detecting fixed-price chains

    // PRIORITY 1: Try NodeReal eth_gasPrice API first (if available and chain supported)
    const canUseNodeReal = this.nodeRealService.canUseNodeReal(numericChainId);
    this.logger.debug(
      `[Gas Price Source] NodeReal availability check for chain ${numericChainId}: ${canUseNodeReal}`,
    );

    if (canUseNodeReal) {
      try {
        this.logger.log(
          `[Gas Price Source] Attempting to fetch gas price from NodeReal API for chain ${numericChainId}`,
        );

        // Fetch gas price from NodeReal
        const nodeRealGasPrice =
          await this.nodeRealService.getGasPrice(numericChainId);

        if (nodeRealGasPrice) {
          // Check if chain supports EIP-1559 by reading latest block
          const provider =
            await this.createPublicClientWithFallback(numericChainId);
          const latestBlock: any = await provider.getBlock({
            blockTag: 'latest' as any,
          });
          const baseFee: bigint | undefined =
            latestBlock?.baseFeePerGas ?? undefined;

          if (baseFee !== undefined && baseFee !== null) {
            // Check if baseFee is very low (indicating fixed-price chain like BSC)
            if (baseFee < ONE_GWEI) {
              this.logger.log(
                `[Gas Price Source] Chain ${numericChainId} has very low baseFee (${baseFee.toString()} wei < 1 gwei), ` +
                  `detected as fixed-price chain. Using NodeReal gas price directly`,
              );

              this.logger.log(
                `[Gas Price Source] Using NodeReal Gas Price (Legacy mode) for chain ${numericChainId}`,
                {
                  gasPrice: nodeRealGasPrice,
                  baseFee: baseFee.toString(),
                  reason: 'Low baseFee detected, using fixed gas price',
                  source: 'nodereal-legacy',
                  priority: '1',
                },
              );

              return {
                type: 'legacy',
                gasPrice: nodeRealGasPrice,
              };
            }

            // EIP-1559 chain with meaningful baseFee: Calculate EIP-1559 fees
            const gasPriceBigInt = BigInt(nodeRealGasPrice);
            const baseFeeBigInt = baseFee;

            this.logger.log(
              `[Gas Price Data] NodeReal raw values for chain ${numericChainId}:`,
              {
                nodeRealGasPrice: nodeRealGasPrice,
                nodeRealGasPriceGwei:
                  (Number(gasPriceBigInt) / 1e9).toFixed(2) + ' gwei',
                baseFee: baseFee.toString(),
                baseFeeGwei: (Number(baseFeeBigInt) / 1e9).toFixed(2) + ' gwei',
                source: 'nodereal',
              },
            );

            // Calculate priority fee: difference between NodeReal gas price and base fee
            // Use the provider-suggested priority fee, but ensure minimum for reliability
            const calculatedPriorityFee =
              gasPriceBigInt > baseFeeBigInt
                ? gasPriceBigInt - baseFeeBigInt
                : BigInt('1000000000'); // 1 gwei default if calculation fails

            // Apply chain-specific minimums only as safety fallback
            // Polygon requires minimum 25 gwei, other chains 1 gwei
            const minPriorityFee =
              numericChainId === 137
                ? BigInt('25000000000') // 25 gwei for Polygon (network requirement)
                : BigInt('1000000000'); // 1 gwei for other chains

            // Use provider's suggestion if it's above minimum, otherwise use minimum
            const maxPriorityFeePerGas =
              calculatedPriorityFee > minPriorityFee
                ? calculatedPriorityFee
                : minPriorityFee;

            this.logger.log(
              `[Gas Price Calculation] NodeReal priority fee analysis for chain ${numericChainId}:`,
              {
                calculatedPriorityFee: calculatedPriorityFee.toString(),
                calculatedPriorityFeeGwei:
                  (Number(calculatedPriorityFee) / 1e9).toFixed(2) + ' gwei',
                minPriorityFee: minPriorityFee.toString(),
                minPriorityFeeGwei:
                  (Number(minPriorityFee) / 1e9).toFixed(2) + ' gwei',
                finalPriorityFee: maxPriorityFeePerGas.toString(),
                finalPriorityFeeGwei:
                  (Number(maxPriorityFeePerGas) / 1e9).toFixed(2) + ' gwei',
                usingProviderValue: calculatedPriorityFee > minPriorityFee,
                reason:
                  calculatedPriorityFee > minPriorityFee
                    ? 'Provider suggestion above minimum'
                    : 'Using minimum (provider value too low)',
              },
            );

            // Max fee per gas: Use higher of (NodeReal price * 1.2) or (base fee * 2.5 + priority fee)
            // This ensures transaction will be included even if base fee increases significantly
            const conservativeMaxFee =
              (gasPriceBigInt * BigInt(120)) / BigInt(100); // 1.2x NodeReal price
            const baseFeeBased =
              (baseFeeBigInt * BigInt(25)) / BigInt(10) + maxPriorityFeePerGas; // 2.5x base + tip
            const maxFeePerGas =
              conservativeMaxFee > baseFeeBased
                ? conservativeMaxFee
                : baseFeeBased;

            this.logger.log(
              `[Gas Price Source] Using NodeReal Gas Price (EIP-1559 mode) for chain ${numericChainId}`,
              {
                maxFeePerGas: maxFeePerGas.toString(),
                maxFeePerGasGwei:
                  (Number(maxFeePerGas) / 1e9).toFixed(2) + ' gwei',
                maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
                maxPriorityFeePerGasGwei:
                  (Number(maxPriorityFeePerGas) / 1e9).toFixed(2) + ' gwei',
                baseFee: baseFee.toString(),
                baseFeeGwei: (Number(baseFee) / 1e9).toFixed(2) + ' gwei',
                nodeRealGasPrice,
                source: 'nodereal-eip1559',
                priority: '1',
              },
            );

            return {
              type: 'eip1559',
              maxFeePerGas: maxFeePerGas.toString(),
              maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
            };
          } else {
            // Legacy chain (no baseFeePerGas): Use NodeReal gas price directly
            this.logger.log(
              `[Gas Price Source] Chain ${numericChainId} does not support EIP-1559, using legacy mode`,
            );

            this.logger.log(
              `[Gas Price Source] Using NodeReal Gas Price (Legacy mode) for chain ${numericChainId}`,
              {
                gasPrice: nodeRealGasPrice,
                reason: 'Chain does not support EIP-1559',
                source: 'nodereal-legacy',
                priority: '1',
              },
            );

            return {
              type: 'legacy',
              gasPrice: nodeRealGasPrice,
            };
          }
        }
      } catch (error) {
        // Log error but continue to Etherscan fallback
        this.logger.warn(
          `[Gas Price Source] NodeReal Gas Price API failed for chain ${numericChainId}, falling back to Etherscan: ${error.message}`,
        );
      }
    } else {
      this.logger.debug(
        `[Gas Price Source] NodeReal not available for chain ${numericChainId} (not supported or API key missing), trying Etherscan`,
      );
    }

    // PRIORITY 2: Try Etherscan Gas Oracle API (if available and chain supported)
    const canUseEtherscan =
      this.etherscanService.canUseEtherscan(numericChainId);
    this.logger.debug(
      `[Gas Price Source] Etherscan availability check for chain ${numericChainId}: ${canUseEtherscan}`,
    );

    if (canUseEtherscan) {
      try {
        this.logger.log(
          `[Gas Price Source] Attempting to fetch gas prices from Etherscan API for chain ${numericChainId}`,
        );

        // Check if chain supports EIP-1559 by reading latest block
        const provider =
          await this.createPublicClientWithFallback(numericChainId);
        const latestBlock: any = await provider.getBlock({
          blockTag: 'latest' as any,
        });
        const baseFee: bigint | undefined =
          latestBlock?.baseFeePerGas ?? undefined;

        if (baseFee !== undefined && baseFee !== null) {
          // Check if baseFee is very low (indicating fixed-price chain like BSC)
          if (baseFee < ONE_GWEI) {
            this.logger.log(
              `[Gas Price Source] Chain ${numericChainId} has very low baseFee (${baseFee.toString()} wei < 1 gwei), ` +
                `detected as fixed-price chain. Falling back to legacy getGasPrice() for accurate pricing`,
            );

            // Use Etherscan's recommended gas price instead of EIP-1559 calculation
            const gasPrice = await this.etherscanService.getRecommendedGasPrice(
              numericChainId,
              'propose',
            );

            if (gasPrice) {
              this.logger.log(
                `[Gas Price Source] Using Etherscan Gas Oracle (Legacy mode) for chain ${numericChainId}`,
                {
                  gasPrice,
                  baseFee: baseFee.toString(),
                  reason: 'Low baseFee detected, using fixed gas price',
                  source: 'etherscan-legacy',
                  priority: '2',
                },
              );

              return {
                type: 'legacy',
                gasPrice,
              };
            }
          }

          // EIP-1559 chain with meaningful baseFee: Use Etherscan's EIP-1559 fee calculation
          const eip1559Fees = await this.etherscanService.getEIP1559Fees(
            numericChainId,
            'propose',
          );

          if (eip1559Fees) {
            this.logger.log(
              `[Gas Price Source] Using Etherscan Gas Oracle (EIP-1559 mode) for chain ${numericChainId}`,
              {
                maxFeePerGas: eip1559Fees.maxFeePerGas,
                maxPriorityFeePerGas: eip1559Fees.maxPriorityFeePerGas,
                baseFee: baseFee.toString(),
                source: 'etherscan-eip1559',
                priority: '2',
              },
            );

            return {
              type: 'eip1559',
              maxFeePerGas: eip1559Fees.maxFeePerGas,
              maxPriorityFeePerGas: eip1559Fees.maxPriorityFeePerGas,
            };
          }
        } else {
          // Legacy chain (no baseFeePerGas): Use Etherscan's recommended gas price
          this.logger.log(
            `[Gas Price Source] Chain ${numericChainId} does not support EIP-1559, using legacy mode`,
          );

          const gasPrice = await this.etherscanService.getRecommendedGasPrice(
            numericChainId,
            'propose',
          );

          if (gasPrice) {
            this.logger.log(
              `[Gas Price Source] Using Etherscan Gas Oracle (Legacy mode) for chain ${numericChainId}`,
              {
                gasPrice,
                reason: 'Chain does not support EIP-1559',
                source: 'etherscan-legacy',
                priority: '2',
              },
            );

            return {
              type: 'legacy',
              gasPrice,
            };
          }
        }
      } catch (error) {
        // Log error but continue to RPC fallback
        this.logger.warn(
          `[Gas Price Source] Etherscan Gas Oracle failed for chain ${numericChainId}, falling back to RPC: ${error.message}`,
        );
      }
    } else {
      this.logger.debug(
        `[Gas Price Source] Etherscan not available for chain ${numericChainId} (not supported or API key missing), using RPC fallback`,
      );
    }

    // PRIORITY 3: RPC-based estimation from latest block
    this.logger.log(
      `[Gas Price Source] Using RPC-based fee estimation from latest block for chain ${numericChainId}`,
    );
    try {
      const provider =
        await this.createPublicClientWithFallback(numericChainId);

      // Try to read baseFeePerGas from latest block to detect EIP-1559 support
      const latestBlock: any = await provider.getBlock({
        blockTag: 'latest' as any,
      });
      const baseFee: bigint | undefined =
        latestBlock?.baseFeePerGas ?? undefined;

      if (baseFee !== undefined && baseFee !== null) {
        // Check if baseFee is very low (indicating fixed-price chain like BSC)
        if (baseFee < ONE_GWEI) {
          this.logger.log(
            `[Gas Price Source] Chain ${numericChainId} has very low baseFee (${baseFee.toString()} wei < 1 gwei), ` +
              `detected as fixed-price chain. Using legacy getGasPrice() for accurate pricing`,
          );

          // Use legacy getGasPrice() for fixed-price chains
          const gasPrice = await provider.getGasPrice();

          this.logger.log(
            `[Gas Price Source] Using RPC-based legacy gas price from latest block for chain ${numericChainId}`,
            {
              gasPrice: gasPrice.toString(),
              baseFee: baseFee.toString(),
              reason: 'Low baseFee detected, using fixed gas price',
              source: 'rpc-legacy-fixed-price',
              priority: '3',
            },
          );

          return {
            type: 'legacy',
            gasPrice: gasPrice.toString(),
          };
        }

        // EIP-1559 chain with meaningful baseFee: Use EIP-1559 calculation
        // Try to fetch maxPriorityFeePerGas from RPC, fall back to chain-specific minimum
        let maxPriorityFeePerGas: bigint;

        this.logger.log(
          `[Gas Price Data] Attempting to fetch priority fee from RPC for chain ${numericChainId}`,
        );

        try {
          // Try to get priority fee from RPC provider
          const priorityFeeFromRpc = await provider.request({
            method: 'eth_maxPriorityFeePerGas',
          });

          if (priorityFeeFromRpc) {
            maxPriorityFeePerGas = BigInt(priorityFeeFromRpc);

            this.logger.log(
              `[Gas Price Data] RPC priority fee retrieved for chain ${numericChainId}:`,
              {
                priorityFee: maxPriorityFeePerGas.toString(),
                priorityFeeGwei:
                  (Number(maxPriorityFeePerGas) / 1e9).toFixed(2) + ' gwei',
                method: 'eth_maxPriorityFeePerGas',
                source: 'rpc',
              },
            );

            // Check if RPC value is above minimum
            const minPriorityFee =
              numericChainId === 137
                ? BigInt('25000000000') // 25 gwei for Polygon
                : BigInt('1000000000'); // 1 gwei for other chains

            if (maxPriorityFeePerGas < minPriorityFee) {
              this.logger.warn(
                `[Gas Price Warning] RPC priority fee (${(Number(maxPriorityFeePerGas) / 1e9).toFixed(2)} gwei) ` +
                  `below minimum (${(Number(minPriorityFee) / 1e9).toFixed(2)} gwei) for chain ${numericChainId}, using minimum`,
              );
              maxPriorityFeePerGas = minPriorityFee;
            }
          } else {
            throw new Error('RPC returned null priority fee');
          }
        } catch (error) {
          // RPC doesn't support eth_maxPriorityFeePerGas, use chain-specific minimum
          const minPriorityFee =
            numericChainId === 137
              ? BigInt('25000000000') // 25 gwei for Polygon (network requirement)
              : BigInt('1000000000'); // 1 gwei for other chains

          this.logger.log(
            `[Gas Price Data] RPC eth_maxPriorityFeePerGas not available for chain ${numericChainId}, using minimum:`,
            {
              error: error.message,
              fallbackPriorityFee: minPriorityFee.toString(),
              fallbackPriorityFeeGwei:
                (Number(minPriorityFee) / 1e9).toFixed(2) + ' gwei',
              reason: 'RPC method not supported',
            },
          );

          maxPriorityFeePerGas = minPriorityFee;
        }

        // Use 2.5x multiplier to handle base fee increases between estimation and submission
        const maxFeePerGas = (baseFee * 25n) / 10n + maxPriorityFeePerGas; // 2.5x base fee + tip

        this.logger.log(
          `[Gas Price Source] Using RPC-based EIP-1559 fee estimation from latest block for chain ${numericChainId}`,
          {
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
            baseFee: baseFee.toString(),
            source: 'rpc-eip1559',
            priority: '3',
          },
        );

        return {
          type: 'eip1559',
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        };
      }

      // Legacy chain (no baseFeePerGas): Use legacy getGasPrice()
      this.logger.log(
        `[Gas Price Source] Chain ${numericChainId} does not support EIP-1559, using legacy mode`,
      );

      const gasPrice = await provider.getGasPrice();

      this.logger.log(
        `[Gas Price Source] Using RPC-based legacy gas price from latest block for chain ${numericChainId}`,
        {
          gasPrice: gasPrice.toString(),
          reason: 'Chain does not support EIP-1559',
          source: 'rpc-legacy',
          priority: '3',
        },
      );

      return {
        type: 'legacy',
        gasPrice: gasPrice.toString(),
      };
    } catch (error) {
      this.logger.warn(
        `[Gas Price Source] RPC-based fee estimation failed for chain ${numericChainId}: ${error.message}`,
      );
    }

    // PRIORITY 4: Static price fallback (final fallback)
    const staticGasPrice = this.getStaticGasPrice(numericChainId);
    this.logger.warn(
      `[Gas Price Source] All dynamic gas price sources failed for chain ${numericChainId}, using static fallback`,
      {
        staticGasPrice,
        chainId: numericChainId,
        source: 'static-fallback',
        priority: '4',
        note: 'This is a fallback value and may not reflect current network conditions',
      },
    );

    return {
      type: 'legacy',
      gasPrice: staticGasPrice,
    };
  }
}
