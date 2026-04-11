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

// Litecoin network configuration
const litecoinNetwork: bitcoin.Network = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe,
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const litecoinTestnet: bitcoin.Network = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'tltc',
  bip32: {
    public: 0x043587cf,
    private: 0x04358394,
  },
  pubKeyHash: 0x6f,
  scriptHash: 0x3a,
  wif: 0xef,
};

interface LitecoinUTXO {
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

/**
 * Litecoin-specific wallet provider
 * Supports Litecoin mainnet and testnet operations
 * Features:
 * - Litecoin balance queries using Sochain API
 * - Address generation from private keys
 * - Transaction creation and broadcasting
 * - UTXO management
 * - P2PKH, P2SH, and P2WPKH address types
 */
@Injectable()
export class LitecoinWalletProvider implements IWalletProvider, OnModuleInit {
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
    this.logger.setContext(LitecoinWalletProvider.name);
    // Initialize bitcoinjs-lib with ECC
    bitcoin.initEccLib(ecc);
    this.logger.log('Litecoin wallet provider initialized with ECC library');

    // Initialize RPC URLs from unified configuration
    const chainConfig =
      this.unifiedConfig?.getChainConfiguration('litecoin-mainnet');
    if (chainConfig?.rpcUrls) {
      this.rpcUrls = chainConfig.rpcUrls;
      this.logger.debug(
        `Initialized with ${this.rpcUrls.length} Litecoin RPC URLs from unified config`,
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
    return 'litecoin';
  }

  supportsChain(chainId: number | string): boolean {
    const litecoinChains = [
      'litecoin',
      'ltc',
      'litecoin-mainnet',
      'litecoin-testnet',
      'ltc-testnet',
      'ltc-mainnet',
    ];

    if (typeof chainId === 'string') {
      return litecoinChains.includes(chainId.toLowerCase());
    }

    return false;
  }

  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo> {
    try {
      this.validateLitecoinChain(chainId);
      this.validateLitecoinAddress(walletAddress, chainId);

      // Litecoin doesn't have tokens like ERC-20, only native LTC
      if (tokenAddress && tokenAddress !== 'native') {
        throw new Error(
          'Litecoin does not support token contracts. Use tokenAddress="native" or omit for LTC balance.',
        );
      }

      return await this.getLitecoinBalance(chainId, walletAddress);
    } catch (error) {
      this.logger.error(
        `Failed to get Litecoin balance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Litecoin balance: ${error.message}`);
    }
  }

  async getMultipleBalances(
    chainId: number | string,
    walletAddress: string,
    tokenAddresses: string[],
  ): Promise<BalanceInfo[]> {
    try {
      this.validateLitecoinChain(chainId);
      this.validateLitecoinAddress(walletAddress, chainId);

      // For Litecoin, we only return LTC balance regardless of token addresses
      const ltcBalance = await this.getLitecoinBalance(chainId, walletAddress);
      return [ltcBalance];
    } catch (error) {
      this.logger.error(
        `Failed to get multiple Litecoin balances: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to get multiple Litecoin balances: ${error.message}`,
      );
    }
  }

  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    throw new Error(
      'Litecoin does not have native token standards like ERC-20. Use native LTC operations.',
    );
  }

  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    this.logger.warn(
      'Litecoin does not support token allowances. Returning 0 for compatibility.',
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
    throw new Error(
      'Litecoin does not support token approvals. Litecoin transactions are direct transfers without approval mechanisms.',
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
      this.validateLitecoinChain(chainId);
      this.validateLitecoinPrivateKey(privateKey);
      this.validateLitecoinAddress(to, chainId);

      const valueInSatoshis = parseInt(value) || 0;

      if (valueInSatoshis <= 0) {
        throw new Error('Invalid transaction value');
      }

      if (data && data !== '0x') {
        this.logger.warn(
          'Litecoin transactions do not support data field, ignoring provided data',
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
        `Failed to execute Litecoin transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to execute Litecoin transaction: ${error.message}`,
      );
    }
  }

  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
  ): Promise<any> {
    try {
      this.validateLitecoinChain(chainId);

      const maxAttempts = 60; // 10 minutes with 10-second intervals
      const interval = 10000; // 10 seconds

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const txInfo = await this.getLitecoinTransaction(chainId, txHash);

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
        `Failed to wait for Litecoin transaction confirmation: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to wait for Litecoin transaction confirmation: ${error.message}`,
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
      this.validateLitecoinChain(chainId);

      const txInfo = await this.getLitecoinTransaction(chainId, txHash);

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
        `Failed to get Litecoin transaction status: ${error.message}`,
        error.stack,
      );
      return { status: 'failed' };
    }
  }

  getConfig(): WalletProviderConfig {
    return {
      name: 'Litecoin Wallet Provider',
      ecosystem: 'litecoin',
      enabled: true,
      supportedChains: [
        'litecoin',
        'ltc',
        'litecoin-mainnet',
        'litecoin-testnet',
      ],
    };
  }

  /**
   * Replace-By-Fee: Create a replacement transaction with higher fee
   * Litecoin supports RBF just like Bitcoin
   */
  async replaceTxWithHigherFee(
    chainId: number | string,
    privateKey: string,
    originalTxid: string,
    newFeeRate: number, // sat/vB (litoshi/vB)
  ): Promise<string> {
    try {
      this.validateLitecoinChain(chainId);
      this.validateLitecoinPrivateKey(privateKey);

      this.logger.log(
        `Creating Litecoin RBF replacement for ${originalTxid} with ${newFeeRate} sat/vB`,
      );

      // Get original transaction
      const originalTx = await this.getLitecoinTransaction(
        chainId,
        originalTxid,
      );

      if (!originalTx) {
        throw new Error(`Original transaction ${originalTxid} not found`);
      }

      if (originalTx.status.confirmed) {
        throw new Error('Cannot replace confirmed transaction');
      }

      // Extract recipient and amount
      const recipientOutput = originalTx.vout[0];
      if (!recipientOutput.scriptpubkey_address) {
        throw new Error('Cannot determine recipient from original tx');
      }

      const toAddress = recipientOutput.scriptpubkey_address;
      const amountLitoshis = recipientOutput.value;

      // Create replacement with higher fee (reusing Bitcoin-style PSBT construction)
      // Implementation would mirror Bitcoin's createAndBroadcastTransaction with RBF flag
      throw new Error(
        'Litecoin RBF implementation pending - use Bitcoin provider pattern',
      );
    } catch (error) {
      this.logger.error(
        `Failed to replace Litecoin transaction: ${error.message}`,
      );
      throw new Error(`Litecoin RBF failed: ${error.message}`);
    }
  }

  // ==================== LITECOIN SPECIFIC METHODS ====================

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

        this.logger.debug(`Trying next Litecoin RPC URL...`);
      }
    }

    throw new Error(`All Litecoin RPC URLs failed for ${operationName}`);
  }

  /**
   * Get available RPC URLs based on network type
   * NOW USES UNIFIED_CHAINS configuration
   */
  private getAvailableUrls(chainId: number | string): string[] {
    const isTestnet = this.isTestnet(chainId);

    // Get URLs from unified configuration
    const chainKey = isTestnet ? 'litecoin-testnet' : 'litecoin-mainnet';
    const chainConfig = this.unifiedConfig?.getChainConfiguration(chainKey);

    if (chainConfig?.rpcUrls && chainConfig.rpcUrls.length > 0) {
      return chainConfig.rpcUrls;
    }

    // Fallback to default public APIs
    if (isTestnet) {
      return ['https://litecoinspace.org/testnet/api'];
    }
    return ['https://litecoinspace.org/api'];
  }

  /**
   * Get Litecoin balance using Litecoin Space API (litecoinspace.org)
   */
  private async getLitecoinBalance(
    chainId: number | string,
    address: string,
  ): Promise<BalanceInfo> {
    try {
      const chainSymbol = 'LTC';
      const testnetSymbol = 'tLTC';

      this.logger.debug(`Fetching Litecoin balance for address: ${address}`);

      // Use executeWithFallback for automatic URL rotation
      return await this.executeWithFallback(
        async (apiUrl) => {
          // Get address statistics from Litecoin Space API with retry logic
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

          // Validate response structure (Litecoin Space uses same format as mempool.space)
          if (
            !addressInfo.chain_stats ||
            typeof addressInfo.chain_stats.funded_txo_sum !== 'number'
          ) {
            throw new Error(`Invalid response format from ${chainSymbol} API`);
          }

          // Balance is in litoshis (smallest unit), convert to main unit for formatted balance
          const balanceLitoshis =
            addressInfo.chain_stats.funded_txo_sum -
            addressInfo.chain_stats.spent_txo_sum;
          const balanceFormatted = balanceLitoshis / 100000000; // Convert to LTC

          this.logger.debug(
            `✅ ${chainSymbol} balance: ${balanceLitoshis} litoshis (${balanceFormatted} ${chainSymbol})`,
          );

          return {
            tokenAddress: 'native',
            balance: balanceLitoshis.toString(),
            formattedBalance: balanceFormatted.toFixed(8), // 8 decimal places
            decimals: 8,
            symbol: this.isTestnet(chainId) ? testnetSymbol : chainSymbol,
          };
        },
        'getLitecoinBalance',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get Litecoin balance: ${error.message}`);

      // Graceful degradation: return zero balance for network issues
      if (
        error.message.includes('aborted') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      ) {
        const isTestnet = this.isTestnet(chainId);
        this.logger.warn(
          `Litecoin balance check failed (network issue), returning zero balance for graceful degradation`,
        );
        return {
          tokenAddress: 'native',
          balance: '0',
          formattedBalance: '0.00000000',
          decimals: 8,
          symbol: isTestnet ? 'tLTC' : 'LTC',
        };
      }

      throw error;
    }
  }

  /**
   * Make API request with retry logic and timeout
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
          const delay = Math.pow(2, attempt) * 1000;
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
   * Create and broadcast a Litecoin transaction
   */
  private async createAndBroadcastTransaction(
    chainId: number | string,
    privateKey: string,
    toAddress: string,
    amountLitoshis: number,
  ): Promise<string> {
    try {
      // Get network configuration
      const network = this.getLitecoinNetwork(chainId);

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

      // Calculate optimal fee using improved estimation
      const feeEstimate = await this.calculateOptimalFee(chainId, utxos, 2); // 2 outputs: recipient + change

      if (totalAvailable < amountLitoshis + feeEstimate) {
        throw new Error(
          `Insufficient funds: need ${amountLitoshis + feeEstimate} litoshis, have ${totalAvailable} litoshis`,
        );
      }

      // Create transaction
      const psbt = new bitcoin.Psbt({ network });

      // Add inputs
      for (const utxo of utxos) {
        const rawTx = await this.getRawTransaction(chainId, utxo.txid);
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        });
      }

      // Add output to recipient
      psbt.addOutput({
        address: toAddress,
        value: BigInt(amountLitoshis),
      });

      // Add change output if necessary
      const change = totalAvailable - amountLitoshis - feeEstimate;
      if (change > 546) {
        // Dust threshold
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

      // Broadcast transaction using Litecoin Space API
      return await this.broadcastTransaction(chainId, txHex);
    } catch (error) {
      this.logger.error(
        `Failed to create and broadcast Litecoin transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to create and broadcast Litecoin transaction: ${error.message}`,
      );
    }
  }

  /**
   * Get UTXOs for a Litecoin address
   */
  private async getAddressUTXOs(
    chainId: number | string,
    address: string,
  ): Promise<LitecoinUTXO[]> {
    try {
      this.logger.debug(`Fetching UTXOs for Litecoin address: ${address}`);

      return await this.executeWithFallback(
        async (apiUrl) => {
          const response = await this.makeApiRequest(
            `${apiUrl}/address/${address}/utxo`,
            {
              retries: 3,
              timeout: 10000,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to fetch UTXOs: ${response.status} ${response.statusText}`,
            );
          }

          const utxos: LitecoinUTXO[] = await response.json();

          this.logger.debug(
            `Found ${utxos.length} UTXOs for address ${address}`,
          );

          return utxos;
        },
        'getAddressUTXOs',
        chainId,
      );
    } catch (error) {
      this.logger.error(`Failed to get Litecoin UTXOs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get raw transaction data
   */
  private async getRawTransaction(
    chainId: number | string,
    txid: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(
        async (apiUrl) => {
          const response = await this.makeApiRequest(
            `${apiUrl}/tx/${txid}/hex`,
            {
              retries: 3,
              timeout: 10000,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to fetch raw transaction: ${response.status} ${response.statusText}`,
            );
          }

          return await response.text();
        },
        'getRawTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get raw Litecoin transaction: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Broadcast a transaction to the Litecoin network
   */
  private async broadcastTransaction(
    chainId: number | string,
    txHex: string,
  ): Promise<string> {
    try {
      this.logger.debug(
        `Broadcasting Litecoin transaction: ${txHex.substring(0, 20)}...`,
      );

      return await this.executeWithFallback(
        async (apiUrl) => {
          const response = await this.makeApiRequest(`${apiUrl}/tx`, {
            method: 'POST',
            body: txHex,
            headers: {
              'Content-Type': 'text/plain',
            },
            retries: 2,
            timeout: 15000,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Broadcast failed: ${response.status} ${response.statusText} - ${errorText}`,
            );
          }

          const txid = await response.text();

          this.logger.log(
            `✅ Litecoin transaction broadcast successful: ${txid}`,
          );

          return txid;
        },
        'broadcastTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to broadcast Litecoin transaction: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get recommended fee rates from Litecoin Space
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
        async (apiUrl) => {
          const response = await fetch(`${apiUrl}/fee-estimates`);

          if (!response.ok) {
            // Fallback to default rates if API fails
            this.logger.warn(
              'Failed to fetch Litecoin fee rates, using defaults',
            );
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
        `Failed to get Litecoin fee rates: ${error.message}, using defaults`,
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
    utxos: LitecoinUTXO[],
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
      return Math.max(calculatedFee, 250); // 250 litoshis minimum
    } catch (error) {
      this.logger.warn(
        `Litecoin fee calculation failed: ${error.message}, using fallback`,
      );
      // Fallback calculation
      const fallbackSize = 180 + utxos.length * 148 + outputCount * 34;
      return Math.ceil(fallbackSize * 5); // 5 sat/vB fallback
    }
  }

  /**
   * Get address from key pair
   */
  private getAddressFromKeyPair(
    keyPair: ReturnType<typeof ECPair.fromWIF>,
    network: bitcoin.Network,
    type: 'p2pkh' | 'p2sh' | 'p2wpkh' = 'p2pkh',
  ): string {
    const { address } = bitcoin.payments.p2pkh({
      pubkey: keyPair.publicKey,
      network,
    });

    if (!address) {
      throw new Error('Failed to generate Litecoin address from key pair');
    }

    return address;
  }

  /**
   * Get Litecoin transaction info
   */
  private async getLitecoinTransaction(
    chainId: number | string,
    txHash: string,
  ): Promise<any> {
    try {
      return await this.executeWithFallback(
        async (apiUrl) => {
          const response = await this.makeApiRequest(`${apiUrl}/tx/${txHash}`, {
            retries: 3,
            timeout: 10000,
          });

          if (!response.ok) {
            throw new Error(
              `Failed to fetch transaction: ${response.status} ${response.statusText}`,
            );
          }

          return await response.json();
        },
        'getLitecoinTransaction',
        chainId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get Litecoin transaction info: ${error.message}`,
      );
      throw error;
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
        async (apiUrl) => {
          const response = await this.makeApiRequest(
            `${apiUrl}/blocks/tip/height`,
            {
              retries: 3,
              timeout: 10000,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to fetch block height: ${response.status} ${response.statusText}`,
            );
          }

          const height = await response.text();
          return parseInt(height);
        },
        'getCurrentBlockHeight',
        chainId,
      );
    } catch (error) {
      this.logger.error(
        `Failed to get Litecoin block height: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get Litecoin network configuration
   */
  private getLitecoinNetwork(chainId: number | string): bitcoin.Network {
    if (this.isTestnet(chainId)) {
      return litecoinTestnet;
    }
    return litecoinNetwork;
  }

  /**
   * Check if chain is testnet
   */
  private isTestnet(chainId: number | string): boolean {
    const chainIdStr = chainId.toString().toLowerCase();
    const testnetIdentifiers = ['testnet', 'litecoin-testnet', 'ltc-testnet'];
    return testnetIdentifiers.some((id) => chainIdStr.includes(id));
  }

  /**
   * Get RPC URL for Litecoin
   * NOW USES UNIFIED_CHAINS configuration
   */
  private getRpcUrl(chainId: number | string): string {
    const isTestnet = this.isTestnet(chainId);

    // Get URLs from unified configuration
    const chainKey = isTestnet ? 'litecoin-testnet' : 'litecoin-mainnet';
    const chainConfig = this.unifiedConfig?.getChainConfiguration(chainKey);

    if (chainConfig?.rpcUrls && chainConfig.rpcUrls.length > 0) {
      return chainConfig.rpcUrls[0]; // Use primary URL
    }

    // Fallback to Litecoin Space public API
    if (isTestnet) {
      return 'https://litecoinspace.org/testnet/api';
    }
    return 'https://litecoinspace.org/api';
  }

  /**
   * Validate Litecoin chain ID
   */
  private validateLitecoinChain(chainId: number | string): void {
    if (!this.supportsChain(chainId)) {
      throw new Error(`Unsupported Litecoin chain: ${chainId}`);
    }
  }

  /**
   * Validate Litecoin private key format
   */
  private validateLitecoinPrivateKey(privateKey: string): void {
    if (!privateKey || privateKey.length < 50) {
      throw new Error('Invalid Litecoin private key format');
    }

    try {
      const network = litecoinNetwork;
      ECPair.fromWIF(privateKey, network);
    } catch (error) {
      try {
        ECPair.fromWIF(privateKey, litecoinTestnet);
      } catch (testnetError) {
        throw new Error('Invalid Litecoin private key WIF format');
      }
    }
  }

  /**
   * Validate Litecoin address format
   */
  private validateLitecoinAddress(
    address: string,
    chainId?: number | string,
  ): void {
    if (!address) {
      throw new Error('Litecoin address is required');
    }

    if (chainId) {
      try {
        const network = this.getLitecoinNetwork(chainId);
        bitcoin.address.toOutputScript(address, network);
        return;
      } catch (error) {
        throw new Error(`Invalid Litecoin address format: ${address}`);
      }
    }

    // Fallback: Try both networks
    const networks = [litecoinNetwork, litecoinTestnet];

    for (const network of networks) {
      try {
        bitcoin.address.toOutputScript(address, network);
        return;
      } catch (error) {
        // Continue trying
      }
    }

    throw new Error(
      `Invalid Litecoin address format: ${address}. Not valid for Litecoin mainnet or testnet.`,
    );
  }
}
