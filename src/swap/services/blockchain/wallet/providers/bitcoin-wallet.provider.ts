import { Injectable, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import {
  IWalletProvider,
  WalletProviderConfig,
} from '../ports/wallet-provider.interface';
import type { IWalletProviderRegistry } from '../ports/wallet-provider-registry.interface';
import { WalletService } from '../wallet.service';
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { RpcFallbackService } from '@shared/services/rpc-fallback.service';

// Initialize ECC for bitcoinjs-lib
const ECPair = ECPairFactory(ecc);

interface BitcoinEnvConfig {
  bitcoinRpcUrl: string;
}

interface BitcoinUTXO {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

interface BitcoinTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    prevout: {
      scriptpubkey: string;
      scriptpubkey_asm: string;
      scriptpubkey_type: string;
      scriptpubkey_address: string;
      value: number;
    };
    scriptsig: string;
    scriptsig_asm: string;
    sequence: number;
  }>;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_asm: string;
    scriptpubkey_type: string;
    scriptpubkey_address?: string;
    value: number;
  }>;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/**
 * Bitcoin-specific wallet provider
 * Supports Bitcoin mainnet and testnet operations
 * Features:
 * - Bitcoin balance queries using Blockstream API
 * - Address generation from private keys
 * - Transaction creation and broadcasting
 * - UTXO management
 * - P2PKH, P2SH, and P2WPKH address types
 */
@Injectable()
export class BitcoinWalletProvider implements IWalletProvider, OnModuleInit {
  private readonly logger: WinstonLoggerService;
  private rpcUrls: string[] = [];

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(WalletService)
    private readonly registry?: IWalletProviderRegistry,
    private readonly unifiedConfig?: UnifiedConfigurationService,
    private readonly rpcFallback?: RpcFallbackService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(BitcoinWalletProvider.name);
    // Initialize bitcoinjs-lib with ECC
    bitcoin.initEccLib(ecc);
    this.logger.log('Bitcoin wallet provider initialized with ECC library');

    // Initialize RPC URLs from unified configuration
    const chainConfig =
      this.unifiedConfig?.getChainConfiguration('bitcoin-mainnet');
    if (chainConfig?.rpcUrls) {
      this.rpcUrls = chainConfig.rpcUrls;
      this.logger.debug(
        `Initialized with ${this.rpcUrls.length} Bitcoin RPC URLs from unified config`,
      );
    }
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
    return 'bitcoin';
  }

  supportsChain(chainId: number | string): boolean {
    // Bitcoin uses string identifiers like 'bitcoin', 'btc', 'testnet'
    const bitcoinChains = [
      'bitcoin',
      'bitcoin-mainnet',
      'btc',
      'bitcoin-testnet',
      'btc-testnet',
      'testnet',
    ];

    if (typeof chainId === 'string') {
      return bitcoinChains.includes(chainId.toLowerCase());
    }

    // Also support numeric ID convention
    return chainId === 0 || chainId === 1; // 0 for mainnet, 1 for testnet
  }

  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo> {
    try {
      this.validateBitcoinChain(chainId);
      this.validateBitcoinAddress(walletAddress, chainId);

      // Bitcoin doesn't have tokens like ERC-20, only native BTC
      if (tokenAddress && tokenAddress !== 'native') {
        throw new Error(
          'Bitcoin does not support token contracts. Use tokenAddress="native" or omit for BTC balance.',
        );
      }

      return await this.getBitcoinBalance(chainId, walletAddress);
    } catch (error) {
      this.logger.error(
        `Failed to get Bitcoin balance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Bitcoin balance: ${error.message}`);
    }
  }

  async getMultipleBalances(
    chainId: number | string,
    walletAddress: string,
    tokenAddresses: string[],
  ): Promise<BalanceInfo[]> {
    try {
      this.validateBitcoinChain(chainId);
      this.validateBitcoinAddress(walletAddress, chainId);

      // For Bitcoin, we only return BTC balance regardless of token addresses
      const btcBalance = await this.getBitcoinBalance(chainId, walletAddress);
      return [btcBalance];
    } catch (error) {
      this.logger.error(
        `Failed to get multiple Bitcoin balances: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to get multiple Bitcoin balances: ${error.message}`,
      );
    }
  }

  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    throw new Error(
      'Bitcoin does not have native token standards like ERC-20. Use native BTC operations.',
    );
  }

  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    // Bitcoin doesn't have token allowances like ERC-20
    // Always return 0 for compatibility
    this.logger.warn(
      'Bitcoin does not support token allowances. Returning 0 for compatibility.',
    );
    return '0';
  }

  async executeApproval(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<string> {
    // Bitcoin doesn't have token approvals like ERC-20
    throw new Error(
      'Bitcoin does not support token approvals. Bitcoin transactions are direct transfers without approval mechanisms.',
    );
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
      this.validateBitcoinChain(chainId);
      this.validateBitcoinPrivateKey(privateKey);
      this.validateBitcoinAddress(to, chainId);

      // Convert value from wei-like units to satoshis (assuming value is in satoshis)
      const valueInSatoshis = parseInt(value) || 0;

      if (valueInSatoshis <= 0) {
        throw new Error('Invalid transaction value');
      }

      // Bitcoin doesn't use data field like Ethereum, log warning if provided
      if (data && data !== '0x') {
        this.logger.warn(
          'Bitcoin transactions do not support data field, ignoring provided data',
        );
      }

      return await this.createAndBroadcastTransaction(
        chainId,
        privateKey,
        to,
        valueInSatoshis,
      );
    } catch (error) {
      this.logger.error(
        `Failed to execute Bitcoin transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to execute Bitcoin transaction: ${error.message}`,
      );
    }
  }

  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
  ): Promise<any> {
    try {
      this.validateBitcoinChain(chainId);

      const maxAttempts = 60; // 10 minutes with 10-second intervals
      const interval = 10000; // 10 seconds

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const txInfo = await this.getBitcoinTransaction(chainId, txHash);

          if (txInfo.status.confirmed && txInfo.status.block_height) {
            // Get current block height to calculate confirmations
            const currentHeight = await this.getCurrentBlockHeight(chainId);
            const txConfirmations =
              currentHeight - txInfo.status.block_height + 1;

            if (txConfirmations >= confirmations) {
              return {
                transactionHash: txHash,
                blockNumber: txInfo.status.block_height,
                blockHash: txInfo.status.block_hash,
                confirmations: txConfirmations,
                status: 'confirmed',
              };
            }
          }

          // Wait before next attempt
          await new Promise((resolve) => setTimeout(resolve, interval));
        } catch (error) {
          this.logger.warn(
            `Attempt ${attempt + 1} failed while waiting for confirmation: ${error.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      }

      throw new Error(
        `Transaction confirmation timeout after ${maxAttempts} attempts`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to wait for Bitcoin transaction confirmation: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to wait for Bitcoin transaction confirmation: ${error.message}`,
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
      this.validateBitcoinChain(chainId);

      const txInfo = await this.getBitcoinTransaction(chainId, txHash);

      if (txInfo.status.confirmed) {
        return {
          status: 'confirmed',
          receipt: {
            transactionHash: txHash,
            blockNumber: txInfo.status.block_height,
            blockHash: txInfo.status.block_hash,
            confirmations: txInfo.status.block_height
              ? (await this.getCurrentBlockHeight(chainId)) -
                txInfo.status.block_height +
                1
              : 0,
            fee: txInfo.fee,
            size: txInfo.size,
            weight: txInfo.weight,
          },
        };
      }

      return { status: 'pending' };
    } catch (error) {
      this.logger.error(
        `Failed to get Bitcoin transaction status: ${error.message}`,
        error.stack,
      );
      return { status: 'failed' };
    }
  }

  getConfig(): WalletProviderConfig {
    return {
      name: 'Bitcoin Wallet Provider',
      ecosystem: 'bitcoin',
      enabled: true,
      supportedChains: ['bitcoin', 'btc', 'bitcoin-testnet', 'testnet'],
    };
  }

  /**
   * Replace-By-Fee: Create a replacement transaction with higher fee
   * Used to speed up stuck transactions by broadcasting a new tx with same inputs but higher fee
   */
  async replaceTxWithHigherFee(
    chainId: number | string,
    privateKey: string,
    originalTxid: string,
    newFeeRate: number, // sat/vB
  ): Promise<string> {
    try {
      this.validateBitcoinChain(chainId);
      this.validateBitcoinPrivateKey(privateKey);

      // Get original transaction details
      const originalTx = await this.getBitcoinTransaction(
        chainId,
        originalTxid,
      );

      if (!originalTx) {
        throw new Error(`Original transaction ${originalTxid} not found`);
      }

      // Check if transaction is already confirmed
      if (originalTx.status.confirmed) {
        throw new Error('Cannot replace confirmed transaction');
      }

      // Extract recipient and amount from original tx
      // Assuming first output is to recipient (change is last)
      const recipientOutput = originalTx.vout[0];
      if (!recipientOutput.scriptpubkey_address) {
        throw new Error(
          'Cannot determine recipient address from original transaction',
        );
      }

      const toAddress = recipientOutput.scriptpubkey_address;
      const amountSatoshis = recipientOutput.value;

      this.logger.log(
        `Creating replacement transaction for ${originalTxid} with ${newFeeRate} sat/vB`,
      );

      // Create replacement transaction with same inputs (UTXOs) and higher fee
      return await this.createAndBroadcastTransaction(
        chainId,
        privateKey,
        toAddress,
        amountSatoshis,
        { enableRbf: true, replaceTxid: originalTxid, newFeeRate },
      );
    } catch (error) {
      this.logger.error(`Failed to replace transaction: ${error.message}`);
      throw new Error(`RBF failed: ${error.message}`);
    }
  }

  // ==================== BITCOIN SPECIFIC METHODS ====================

  /**
   * Execute API request with automatic fallback across RPC URLs
   */
  private async executeWithFallback<T>(
    operation: (url: string) => Promise<T>,
    operationName: string,
    chainId: number | string,
  ): Promise<T> {
    // Get URLs based on testnet/mainnet
    const urls = this.getAvailableUrls(chainId);

    if (!this.rpcFallback) {
      // Fallback when RpcFallbackService is not available
      return await operation(urls[0]);
    }

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        this.logger.debug(
          `${operationName} - trying URL ${i + 1}/${urls.length}: ${url}`,
        );
        const result = await operation(url);
        this.rpcFallback.setUrlHealth(url, true);
        return result;
      } catch (error) {
        this.logger.warn(`${operationName} failed on ${url}: ${error.message}`);
        this.rpcFallback.setUrlHealth(url, false);

        if (i === urls.length - 1) {
          throw error; // Last URL failed, throw error
        }

        this.logger.debug(`Trying next Bitcoin RPC URL...`);
      }
    }

    throw new Error(`All Bitcoin RPC URLs failed for ${operationName}`);
  }

  /**
   * Get available RPC URLs based on network type
   * NOW USES UNIFIED_CHAINS configuration
   */
  private getAvailableUrls(chainId: number | string): string[] {
    const isTestnet = this.isTestnet(chainId);

    // Get URLs from unified configuration
    const chainKey = isTestnet ? 'bitcoin-testnet' : 'bitcoin-mainnet';
    const chainConfig = this.unifiedConfig?.getChainConfiguration(chainKey);

    if (chainConfig?.rpcUrls && chainConfig.rpcUrls.length > 0) {
      // Ensure URLs have /api suffix for Blockstream compatibility
      return chainConfig.rpcUrls.map((url) => {
        if (url.includes('blockstream.info') && !url.includes('/api')) {
          return `${url}/api`;
        }
        return url;
      });
    }

    // Fallback to default public APIs
    if (isTestnet) {
      return ['https://blockstream.info/testnet/api'];
    }
    return ['https://blockstream.info/api'];
  }

  /**
   * Get recommended fee rates from mempool
   */
  private async getFeeRates(chainId: number | string): Promise<{
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
  }> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await fetch(`${rpcUrl}/fee-estimates`);

          if (!response.ok) {
            // Fallback to default rates if API fails
            this.logger.warn('Failed to fetch fee rates, using defaults');
            return {
              fastestFee: 20, // 20 sat/vB for fastest confirmation
              halfHourFee: 10, // 10 sat/vB for 30min confirmation
              hourFee: 5, // 5 sat/vB for 1hr confirmation
              economyFee: 3, // 3 sat/vB for economy
              minimumFee: 1, // 1 sat/vB minimum
            };
          }

          const feeData = await response.json();

          return {
            fastestFee: Math.ceil(feeData['1'] || 20),
            halfHourFee: Math.ceil(feeData['6'] || 10),
            hourFee: Math.ceil(feeData['12'] || 5),
            economyFee: Math.ceil(feeData['144'] || 3),
            minimumFee: Math.ceil(feeData['1008'] || 1),
          };
        },
        'getFeeRates',
        chainId,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to get fee rates: ${error.message}, using defaults`,
      );
      return {
        fastestFee: 20,
        halfHourFee: 10,
        hourFee: 5,
        economyFee: 3,
        minimumFee: 1,
      };
    }
  }

  /**
   * Estimate transaction size in vBytes
   */
  private estimateTransactionSize(
    inputCount: number,
    outputCount: number,
    addressType: 'p2pkh' | 'p2sh' | 'p2wpkh' = 'p2pkh',
  ): number {
    let inputSize: number;
    const outputSize = 34; // Standard output size

    switch (addressType) {
      case 'p2wpkh': // SegWit
        inputSize = 68; // SegWit input is smaller
        break;
      case 'p2sh': // Pay-to-Script-Hash
        inputSize = 91;
        break;
      case 'p2pkh': // Pay-to-Public-Key-Hash (legacy)
      default:
        inputSize = 148;
        break;
    }

    // Base transaction size (version + locktime + input/output counts)
    const baseSize = 10;
    const totalSize =
      baseSize + inputCount * inputSize + outputCount * outputSize;

    return totalSize;
  }

  /**
   * Calculate optimal fee for transaction
   */
  private async calculateOptimalFee(
    chainId: number | string,
    utxos: BitcoinUTXO[],
    outputCount: number = 2, // recipient + change
    feeRate?: number,
  ): Promise<number> {
    try {
      const feeRates = await this.getFeeRates(chainId);
      const selectedFeeRate = feeRate || feeRates.halfHourFee; // Default to 30-min confirmation

      const estimatedSize = this.estimateTransactionSize(
        utxos.length,
        outputCount,
      );
      const calculatedFee = Math.ceil(estimatedSize * selectedFeeRate);

      // Ensure minimum fee
      return Math.max(calculatedFee, 250); // 250 satoshis minimum
    } catch (error) {
      this.logger.warn(
        `Fee calculation failed: ${error.message}, using fallback`,
      );
      // Fallback calculation
      const fallbackSize = 180 + utxos.length * 148 + outputCount * 34;
      return Math.ceil(fallbackSize * 5); // 5 sat/vB fallback
    }
  }

  /**
   * Get Bitcoin balance using block explorer API (mempool.space, Blockstream)
   */
  private async getBitcoinBalance(
    chainId: number | string,
    address: string,
  ): Promise<BalanceInfo> {
    try {
      const chainSymbol = 'BTC';
      const testnetSymbol = 'tBTC';

      this.logger.debug(`Fetching Bitcoin balance for address: ${address}`);

      // Use executeWithFallback for automatic URL rotation
      return await this.executeWithFallback(
        async (apiUrl) => {
          // Get address statistics from block explorer API with retry logic
          const response = await this.makeApiRequest(
            `${apiUrl}/address/${address}`,
            {
              retries: 3,
              timeout: 10000,
            },
          );

          if (!response.ok) {
            // Handle 404 - address not found (zero balance)
            if (response.status === 404) {
              this.logger.debug(
                `Address ${address} not found (no transactions yet), returning zero balance`,
              );
              return {
                tokenAddress: 'native',
                balance: '0',
                formattedBalance: '0.00000000',
                decimals: 8,
                symbol: this.isTestnet(chainId) ? testnetSymbol : chainSymbol,
              };
            }
            throw new Error(
              `Failed to fetch address info: ${response.status} ${response.statusText}`,
            );
          }

          const addressInfo = await response.json();

          // Validate response structure
          if (
            !addressInfo.chain_stats ||
            typeof addressInfo.chain_stats.funded_txo_sum !== 'number'
          ) {
            throw new Error(`Invalid response format from ${chainSymbol} API`);
          }

          // Balance is in satoshis (smallest unit), convert to main unit for formatted balance
          const balanceSatoshis =
            addressInfo.chain_stats.funded_txo_sum -
            addressInfo.chain_stats.spent_txo_sum;
          const balanceFormatted = balanceSatoshis / 100000000; // Convert to BTC

          this.logger.debug(
            `✅ ${chainSymbol} balance: ${balanceSatoshis} satoshis (${balanceFormatted} ${chainSymbol})`,
          );

          return {
            tokenAddress: 'native',
            balance: balanceSatoshis.toString(),
            formattedBalance: balanceFormatted.toFixed(8), // 8 decimal places
            decimals: 8,
            symbol: this.isTestnet(chainId) ? testnetSymbol : chainSymbol,
          };
        },
        'getBitcoinBalance',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get Bitcoin balance: ${error.message}`);

      // Graceful degradation: return zero balance for network issues
      if (
        error.message.includes('aborted') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      ) {
        const isTestnet = this.isTestnet(chainId);
        this.logger.warn(
          `Bitcoin balance check failed (network issue), returning zero balance for graceful degradation`,
        );
        return {
          tokenAddress: 'native',
          balance: '0',
          formattedBalance: '0.00000000',
          decimals: 8,
          symbol: isTestnet ? 'tBTC' : 'BTC',
        };
      }

      throw error;
    }
  }

  /**
   * Make API request with retry logic and timeout
   * Now used internally by operations, actual URL fallback handled by executeWithFallback
   */
  private async makeApiRequest(
    url: string,
    options: {
      retries?: number;
      timeout?: number;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<Response> {
    const {
      retries = 3,
      timeout = 10000,
      method = 'GET',
      headers = {},
      body,
    } = options;

    // Add default headers including User-Agent to avoid 403 errors
    const defaultHeaders = {
      'User-Agent': 'A-Bot-Microservices/1.0',
      Accept: 'application/json',
      ...headers,
    };

    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          method,
          headers: defaultHeaders,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError = error as Error;

        if (attempt < retries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          this.logger.warn(
            `API request attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `API request failed after ${retries} attempts: ${lastError.message}`,
    );
  }

  /**
   * Create and broadcast a Bitcoin transaction
   * Now supports RBF (Replace-By-Fee) for fee bumping
   */
  private async createAndBroadcastTransaction(
    chainId: number | string,
    privateKey: string,
    toAddress: string,
    amountSatoshis: number,
    options?: {
      enableRbf?: boolean;
      replaceTxid?: string;
      newFeeRate?: number;
    },
  ): Promise<string> {
    try {
      // Get network configuration
      const network = this.getBitcoinNetwork(chainId);

      // Create key pair from private key
      const keyPair = ECPair.fromWIF(privateKey, network);
      const fromAddress = this.getAddressFromKeyPair(keyPair, network, 'p2pkh'); // Default to P2PKH for compatibility

      // Get UTXOs for the from address
      const utxos = await this.getAddressUTXOs(chainId, fromAddress);

      if (utxos.length === 0) {
        throw new Error('No UTXOs available for transaction');
      }

      // Calculate total available amount
      const totalAvailable = utxos.reduce((sum, utxo) => sum + utxo.value, 0);

      // Calculate optimal fee using improved estimation or custom fee rate
      const feeEstimate = options?.newFeeRate
        ? await this.calculateOptimalFee(chainId, utxos, 2, options.newFeeRate)
        : await this.calculateOptimalFee(chainId, utxos, 2); // 2 outputs: recipient + change

      if (totalAvailable < amountSatoshis + feeEstimate) {
        throw new Error(
          `Insufficient funds. Available: ${totalAvailable}, Required: ${amountSatoshis + feeEstimate} (including fee: ${feeEstimate})`,
        );
      }

      // Create transaction
      const psbt = new bitcoin.Psbt({ network });

      // Add inputs with proper type detection and RBF signaling
      for (const utxo of utxos) {
        const input = await this.createPsbtInput(
          chainId,
          utxo,
          fromAddress,
          network,
        );

        // Enable RBF by setting sequence to less than 0xfffffffe
        // BIP 125: sequence < 0xfffffffe signals replaceability
        if (options?.enableRbf || options?.replaceTxid) {
          input.sequence = 0xfffffffd; // RBF-enabled sequence
        }

        psbt.addInput(input);
      }

      // Add output to recipient
      psbt.addOutput({
        address: toAddress,
        value: BigInt(amountSatoshis),
      });

      // Add change output if necessary
      const change = totalAvailable - amountSatoshis - feeEstimate;
      if (change > 546) {
        // Dust limit
        psbt.addOutput({
          address: fromAddress,
          value: BigInt(change),
        });
      }

      // Sign all inputs
      for (let i = 0; i < utxos.length; i++) {
        psbt.signInput(i, keyPair);
      }

      // Finalize and extract transaction
      psbt.finalizeAllInputs();
      const tx = psbt.extractTransaction();
      const txHex = tx.toHex();

      // Log RBF status
      if (options?.enableRbf) {
        this.logger.log(
          `Transaction created with RBF enabled (sequence: 0xfffffffd)`,
        );
      }
      if (options?.replaceTxid) {
        this.logger.log(
          `Replacing transaction ${options.replaceTxid} with higher fee`,
        );
      }

      // Broadcast transaction
      const txid = await this.broadcastTransaction(chainId, txHex);

      this.logger.log(`Bitcoin transaction broadcasted successfully: ${txid}`);
      return txid;
    } catch (error) {
      this.logger.error(
        `Failed to create and broadcast Bitcoin transaction: ${error.message}`,
      );
      throw new Error(`Transaction creation failed: ${error.message}`);
    }
  }

  /**
   * Get UTXOs for a Bitcoin address
   */
  private async getAddressUTXOs(
    chainId: number | string,
    address: string,
  ): Promise<BitcoinUTXO[]> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await this.makeApiRequest(
            `${rpcUrl}/address/${address}/utxo`,
          );

          if (!response.ok) {
            if (response.status === 404) {
              this.logger.warn(`No UTXOs found for address ${address}`);
              return [];
            }
            throw new Error(
              `Failed to fetch UTXOs: ${response.status} ${response.statusText}`,
            );
          }

          const utxos: BitcoinUTXO[] = await response.json();

          // Validate UTXO structure and filter for confirmed UTXOs only
          const validUtxos = utxos.filter((utxo) => {
            if (
              !utxo.txid ||
              typeof utxo.vout !== 'number' ||
              typeof utxo.value !== 'number'
            ) {
              this.logger.warn('Invalid UTXO structure detected, skipping');
              return false;
            }
            return utxo.status.confirmed;
          });

          this.logger.debug(
            `Found ${validUtxos.length} confirmed UTXOs for address ${address}`,
          );
          return validUtxos;
        },
        'getAddressUTXOs',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get UTXOs: ${error.message}`);
      throw new Error(`Failed to fetch UTXOs: ${error.message}`);
    }
  }

  /**
   * Get raw transaction data
   */
  private async getRawTransaction(
    chainId: number | string,
    txid: string,
  ): Promise<Buffer> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await fetch(`${rpcUrl}/tx/${txid}/hex`);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch raw transaction: ${response.statusText}`,
            );
          }

          const txHex = await response.text();
          return Buffer.from(txHex, 'hex');
        },
        'getRawTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get raw transaction: ${error.message}`);
      throw new Error(`Failed to fetch raw transaction: ${error.message}`);
    }
  }

  /**
   * Broadcast a transaction to the Bitcoin network
   */
  private async broadcastTransaction(
    chainId: number | string,
    txHex: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await this.makeApiRequest(`${rpcUrl}/tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
            },
            body: txHex,
            retries: 2, // Fewer retries for broadcasts
            timeout: 15000, // Longer timeout for broadcasts
          });

          if (!response.ok) {
            const errorText = await response.text();

            // Parse common error messages
            if (errorText.includes('insufficient fee')) {
              throw new Error(
                'Transaction rejected: Insufficient fee. Please increase the fee rate.',
              );
            } else if (errorText.includes('dust')) {
              throw new Error(
                'Transaction rejected: Output amount too small (dust limit).',
              );
            } else if (errorText.includes('double-spend')) {
              throw new Error('Transaction rejected: Double spend detected.');
            } else {
              throw new Error(
                `Broadcast failed: ${response.status} ${response.statusText} - ${errorText}`,
              );
            }
          }

          const txid = await response.text();

          // Validate txid format
          if (!/^[a-f0-9]{64}$/i.test(txid.trim())) {
            throw new Error('Invalid transaction ID returned from broadcast');
          }

          return txid.trim();
        },
        'broadcastTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to broadcast transaction: ${error.message}`);
      throw new Error(`Transaction broadcast failed: ${error.message}`);
    }
  }

  /**
   * Get Bitcoin transaction information
   */
  private async getBitcoinTransaction(
    chainId: number | string,
    txHash: string,
  ): Promise<BitcoinTransaction> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await fetch(`${rpcUrl}/tx/${txHash}`);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch transaction: ${response.statusText}`,
            );
          }

          const txInfo: BitcoinTransaction = await response.json();
          return txInfo;
        },
        'getBitcoinTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get Bitcoin transaction: ${error.message}`);
      throw new Error(`Failed to fetch Bitcoin transaction: ${error.message}`);
    }
  }

  /**
   * Get current block height
   */
  private async getCurrentBlockHeight(
    chainId: number | string,
  ): Promise<number> {
    try {
      return await this.executeWithFallback(
        async (rpcUrl) => {
          const response = await fetch(`${rpcUrl}/blocks/tip/height`);

          if (!response.ok) {
            throw new Error(
              `Failed to fetch block height: ${response.statusText}`,
            );
          }

          const height = await response.text();
          return parseInt(height);
        },
        'getCurrentBlockHeight',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get current block height: ${error.message}`);
      throw new Error(`Failed to fetch current block height: ${error.message}`);
    }
  }

  /**
   * Get network configuration for Bitcoin chains
   */
  private getBitcoinNetwork(chainId: number | string): bitcoin.Network {
    // Bitcoin networks
    if (this.isTestnet(chainId)) {
      return bitcoin.networks.testnet;
    }
    return bitcoin.networks.bitcoin;
  }

  /**
   * Generate Bitcoin address from key pair with support for different address types
   */
  private getAddressFromKeyPair(
    keyPair: any,
    network: bitcoin.Network,
    addressType: 'p2pkh' | 'p2sh' | 'p2wpkh' = 'p2pkh',
  ): string {
    let payment: bitcoin.Payment;

    switch (addressType) {
      case 'p2wpkh': // SegWit v0 (bech32)
        payment = bitcoin.payments.p2wpkh({
          pubkey: keyPair.publicKey,
          network,
        });
        break;
      case 'p2sh': // SegWit wrapped in P2SH (3...)
        payment = bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network,
          }),
          network,
        });
        break;
      case 'p2pkh': // Legacy (1...)
      default:
        payment = bitcoin.payments.p2pkh({
          pubkey: keyPair.publicKey,
          network,
        });
        break;
    }

    if (!payment.address) {
      throw new Error(
        `Failed to generate ${addressType} address from key pair`,
      );
    }

    return payment.address;
  }

  /**
   * Detect address type from address string
   */
  private detectAddressType(
    address: string,
    network: bitcoin.Network,
  ): 'p2pkh' | 'p2sh' | 'p2wpkh' | 'unknown' {
    try {
      const decoded = bitcoin.address.fromBase58Check(address);

      if (decoded.version === network.pubKeyHash) {
        return 'p2pkh'; // Legacy address (1...)
      } else if (decoded.version === network.scriptHash) {
        return 'p2sh'; // Script hash address (3...)
      }
    } catch (error) {
      // Not a base58 address, might be bech32
      try {
        bitcoin.address.fromBech32(address);
        return 'p2wpkh'; // SegWit address (bc1...)
      } catch (bech32Error) {
        // Unknown format
      }
    }

    return 'unknown';
  }

  /**
   * Create appropriate input for PSBT based on address type
   */
  private async createPsbtInput(
    chainId: number | string,
    utxo: BitcoinUTXO,
    fromAddress: string,
    network: bitcoin.Network,
  ): Promise<any> {
    const addressType = this.detectAddressType(fromAddress, network);
    const input: any = {
      hash: utxo.txid,
      index: utxo.vout,
    };

    switch (addressType) {
      case 'p2wpkh': // SegWit v0
        // For SegWit, we need witnessUtxo instead of nonWitnessUtxo
        const witnessUtxo = {
          script: bitcoin.address.toOutputScript(fromAddress, network),
          value: BigInt(utxo.value),
        };
        input.witnessUtxo = witnessUtxo;
        break;

      case 'p2sh': // SegWit wrapped in P2SH
        // For P2SH-wrapped SegWit, we need both
        input.witnessUtxo = {
          script: bitcoin.address.toOutputScript(fromAddress, network),
          value: BigInt(utxo.value),
        };
        input.nonWitnessUtxo = await this.getRawTransaction(chainId, utxo.txid);
        break;

      case 'p2pkh': // Legacy
      default:
        // For legacy addresses, use nonWitnessUtxo
        input.nonWitnessUtxo = await this.getRawTransaction(chainId, utxo.txid);
        break;
    }

    return input;
  }

  /**
   * Get address from private key WIF
   */
  private getAddressFromPrivateKey(
    privateKey: string,
    chainId: number | string,
  ): string {
    try {
      const network = this.getBitcoinNetwork(chainId);
      const keyPair = ECPair.fromWIF(privateKey, network);
      return this.getAddressFromKeyPair(keyPair, network);
    } catch (error) {
      this.logger.error(
        `Failed to derive address from private key: ${error.message}`,
      );
      throw new Error(`Invalid private key or network mismatch`);
    }
  }

  /**
   * Check if chain is testnet
   */
  private isTestnet(chainId: number | string): boolean {
    const chainIdStr = chainId.toString().toLowerCase();
    const testnetIdentifiers = [
      'testnet',
      'bitcoin-testnet',
      'btc-testnet',
      '1',
    ];
    return testnetIdentifiers.some((id) => chainIdStr.includes(id));
  }

  /**
   * Get RPC URL for Bitcoin
   * NOW USES UNIFIED_CHAINS configuration instead of environment variables
   */
  private getRpcUrl(chainId: number | string): string {
    const isTestnet = this.isTestnet(chainId);

    // Get URLs from unified configuration
    const chainKey = isTestnet ? 'bitcoin-testnet' : 'bitcoin-mainnet';
    const chainConfig = this.unifiedConfig?.getChainConfiguration(chainKey);

    if (chainConfig?.rpcUrls && chainConfig.rpcUrls.length > 0) {
      const configUrl = chainConfig.rpcUrls[0]; // Use primary URL
      // If config URL is Blockstream format, ensure it has /api
      if (
        configUrl.includes('blockstream.info') &&
        !configUrl.includes('/api')
      ) {
        return `${configUrl}/api`;
      }
      return configUrl;
    }

    // Fallback to public Blockstream API
    if (isTestnet) {
      return 'https://blockstream.info/testnet/api';
    }
    return 'https://blockstream.info/api';
  }

  /**
   * Validate Bitcoin chain ID
   */
  private validateBitcoinChain(chainId: number | string): void {
    if (!this.supportsChain(chainId)) {
      throw new Error(`Unsupported Bitcoin chain: ${chainId}`);
    }
  }

  /**
   * Validate Bitcoin private key format
   */
  private validateBitcoinPrivateKey(privateKey: string): void {
    if (!privateKey || privateKey.length < 50) {
      throw new Error('Invalid Bitcoin private key format');
    }

    try {
      // Try to create ECPair to validate format
      const network = bitcoin.networks.bitcoin; // Default validation
      ECPair.fromWIF(privateKey, network);
    } catch (error) {
      // Try testnet format
      try {
        ECPair.fromWIF(privateKey, bitcoin.networks.testnet);
      } catch (testnetError) {
        throw new Error('Invalid Bitcoin private key WIF format');
      }
    }
  }

  /**
   * Validate address format for Bitcoin-like chains (Bitcoin, Litecoin, etc.)
   * Now accepts chainId to validate against the correct network
   */
  private validateBitcoinAddress(
    address: string,
    chainId?: number | string,
  ): void {
    if (!address) {
      throw new Error('Address is required');
    }

    // If chainId is provided, validate against specific network
    if (chainId) {
      try {
        const network = this.getBitcoinNetwork(chainId);
        bitcoin.address.toOutputScript(address, network);
        return; // Valid for the specific network
      } catch (error) {
        throw new Error(`Invalid Bitcoin address format: ${address}`);
      }
    }

    // Fallback: Try all supported networks if chainId not provided
    const networks = [bitcoin.networks.bitcoin, bitcoin.networks.testnet];

    for (const network of networks) {
      try {
        bitcoin.address.toOutputScript(address, network);
        return; // Valid for at least one network
      } catch (error) {
        // Continue trying other networks
      }
    }

    throw new Error(
      `Invalid Bitcoin address format: ${address}. Not valid for Bitcoin mainnet or testnet.`,
    );
  }
}
