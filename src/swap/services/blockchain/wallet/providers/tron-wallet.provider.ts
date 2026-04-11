import { Injectable, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { BalanceInfo, TokenInfo } from '@swap/models/swap-request.model';
import {
  IWalletProvider,
  WalletProviderConfig,
} from '../ports/wallet-provider.interface';
import type { IWalletProviderRegistry } from '../ports/wallet-provider-registry.interface';
import { WalletService } from '../wallet.service';
import { EnvironmentConfigService } from '@shared/services/environment-config.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import { RpcFallbackService } from '@shared/services/rpc-fallback.service';

// TronWeb imports
import {
  TronWeb,
  utils as TronWebUtils,
} from 'tronweb';

// TRC20 ABI for standard functions
const TRC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'name',
    outputs: [{ name: '', type: 'string' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
  },
];

/**
 * Tron-specific wallet provider
 * FULLY IMPLEMENTED: Complete Tron blockchain functionality
 *
 * Handles:
 * - TRX (native token) balance and transactions
 * - TRC20 token interactions (USDT, USDC)
 * - TRC10 token support
 * - Tron address validation and formatting
 * - Transaction signing and broadcasting
 *
 * Technical Implementation:
 * - Uses TronGrid API for blockchain queries
 * - TronWeb library for transaction signing
 * - Supports mainnet and testnet environments
 * - Base58 address validation
 * - TRC20 smart contract interactions
 * - Energy/Bandwidth gas model
 */
@Injectable()
export class TronWalletProvider implements IWalletProvider, OnModuleInit {
  private readonly logger: WinstonLoggerService;
  private tronWeb: TronWeb | null = null;
  private rpcUrls: string[] = [];

  constructor(
    private readonly envConfig: EnvironmentConfigService,
    private readonly unifiedConfig: UnifiedConfigurationService,
    private readonly rpcFallback: RpcFallbackService,
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject(WalletService)
    private readonly registry?: IWalletProviderRegistry,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(TronWalletProvider.name);
    this.initializeTronWeb();
  }

  /**
   * Initialize TronWeb instance with RPC fallback support
   */
  private async initializeTronWeb(): Promise<void> {
    try {
      const chainConfig =
        this.unifiedConfig.getChainConfiguration('tron-mainnet');
      this.rpcUrls = chainConfig?.rpcUrls || ['https://api.trongrid.io'];

      // Use RPC Fallback Service to get the best URL
      const bestUrl = this.rpcFallback.getBestUrl(this.rpcUrls);

      // Initialize TronWeb with proper configuration
      this.tronWeb = new TronWeb({
        fullHost: bestUrl,
        headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
        privateKey: undefined, // Will be set per operation
      });

      this.logger.debug(`TronWeb initialized successfully with ${bestUrl}`);
    } catch (error) {
      this.logger.warn(
        'TronWeb not available, using HTTP API fallback',
        error.message,
      );
      this.tronWeb = null;
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

  /**
   * Execute operation with automatic RPC fallback
   * Wraps operations to try multiple RPC URLs on failure
   */
  private async executeWithFallback<T>(
    operation: (rpcUrl: string) => Promise<T>,
    operationName: string,
  ): Promise<T> {
    // Get URLs from unified configuration
    let urls = this.rpcUrls;
    if (urls.length === 0) {
      const chainConfig =
        this.unifiedConfig.getChainConfiguration('tron-mainnet');
      urls = chainConfig?.rpcUrls || ['https://api.trongrid.io'];
    }

    // Try each URL with RPC Fallback Service
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        this.logger.debug(`Attempting ${operationName} with RPC URL: ${url}`);
        const result = await operation(url);

        // Mark URL as healthy on success
        this.rpcFallback.setUrlHealth(url, true);

        if (i > 0) {
          this.logger.log(
            `✅ ${operationName} succeeded with fallback URL #${i + 1}: ${url}`,
          );
        }

        return result;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Extract detailed error information for Tron API errors
        let detailedError = errorMsg;
        if (error && typeof error === 'object') {
          const err = error;
          // Tron API errors often come in response.data
          if (err.response?.data) {
            // Decode hex error messages if present
            let decodedData = err.response.data;
            if (typeof decodedData === 'object') {
              // Try to decode any hex-encoded fields
              if (decodedData.message) {
                decodedData.message = this.decodeHexMessage(
                  decodedData.message,
                );
              }
              if (decodedData.error) {
                decodedData.error = this.decodeHexMessage(decodedData.error);
              }
            } else if (typeof decodedData === 'string') {
              decodedData = this.decodeHexMessage(decodedData);
            }

            detailedError =
              typeof decodedData === 'string'
                ? decodedData
                : JSON.stringify(decodedData);
            this.logger.error(`Tron API error response:`, {
              status: err.response?.status,
              statusText: err.response?.statusText,
              data: err.response?.data,
              decodedData,
              url,
            });
          } else if (err.code || err.message) {
            const decodedMessage = this.decodeHexMessage(
              err.message || errorMsg,
            );
            detailedError = `${err.code || ''}: ${decodedMessage}`;
          }
        }

        // Mark URL as unhealthy on failure
        this.rpcFallback.setUrlHealth(url, false);

        this.logger.warn(
          `❌ ${operationName} failed for URL ${url}: ${detailedError}${
            i < urls.length - 1 ? ' (trying next URL)' : ' (no more URLs)'
          }`,
        );

        // If this is the last URL, throw the error with detailed information
        if (i === urls.length - 1) {
          throw new Error(
            `${operationName} failed on all RPC URLs: ${detailedError}`,
          );
        }
      }
    }

    throw new Error(`${operationName} failed: No RPC URLs available`);
  }

  /**
   * Get RPC URL with fallback support
   * Returns the best available URL from the fallback service
   */
  private getRpcUrlWithFallback(chainId: number | string): string {
    if (this.rpcUrls.length === 0) {
      // Load URLs from configuration if not already loaded
      if (typeof chainId === 'string' && chainId.includes('testnet')) {
        this.rpcUrls = [
          'https://api.shasta.trongrid.io',
          'https://api.nileex.io',
        ]; // Testnet fallbacks
      } else {
        const chainConfig =
          this.unifiedConfig.getChainConfiguration('tron-mainnet');
        this.rpcUrls = chainConfig?.rpcUrls || ['https://api.trongrid.io'];
      }
    }

    // Get the best URL from RPC Fallback Service
    return this.rpcFallback.getBestUrl(this.rpcUrls);
  }

  getEcosystem(): string {
    return 'tron';
  }

  supportsChain(chainId: number | string): boolean {
    // Tron uses string identifiers like 'tron-mainnet', 'tron-testnet'
    // But also supports numeric chainId 195 for compatibility with aggregators
    const tronChains = [
      'tron-mainnet',
      'tron-testnet',
      'tron',
      'shasta-testnet', // Shasta testnet
      'nile-testnet', // Nile testnet
    ];

    if (typeof chainId === 'string') {
      return tronChains.includes(chainId.toLowerCase());
    }

    // Support numeric chainId 195 for Tron mainnet (used by aggregators like Rubic)
    if (typeof chainId === 'number' && chainId === 195) {
      return true;
    }

    return false;
  }

  async getBalance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress?: string,
  ): Promise<BalanceInfo> {
    try {
      this.validateTronChain(chainId);
      this.validateTronAddress(walletAddress);

      if (!tokenAddress || this.isNativeTronToken(tokenAddress)) {
        return this.getTrxBalance(chainId, walletAddress);
      }

      if (this.isTrc20Token(tokenAddress)) {
        return this.getTrc20Balance(chainId, walletAddress, tokenAddress);
      }

      if (this.isTrc10Token(tokenAddress)) {
        return this.getTrc10Balance(chainId, walletAddress, tokenAddress);
      }

      throw new Error(`Unsupported token type for address: ${tokenAddress}`);
    } catch (error) {
      this.logger.error(
        `Failed to get Tron balance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Tron balance: ${error.message}`);
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
   * Estimate fees for Tron transactions
   *
   * Tron uses bandwidth/energy model, not EVM gas model:
   * - Bandwidth: ~140 SUN for typical transaction (if no free bandwidth)
   * - Energy: Only for smart contracts, not for TRX transfers
   *
   * For compatibility with EVM-style fee estimation, we return a conservative
   * fixed value in legacy format (Tron doesn't support EIP-1559).
   *
   * The returned gasPrice represents bandwidth cost per unit in SUN.
   */
  async estimateFees(
    chainId: number | string,
  ): Promise<{ type: 'legacy'; gasPrice: string }> {
    this.validateTronChain(chainId);

    // Return conservative bandwidth cost estimate
    // gasPrice in SUN: 140 SUN (typical bandwidth cost for native transfer)
    // This is NOT wei - it's already in SUN (Tron's atomic unit, 6 decimals)
    return {
      type: 'legacy',
      gasPrice: '140', // 140 SUN = 0.00014 TRX
    };
  }

  async getTokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      this.validateTronChain(chainId);

      if (this.isNativeTronToken(tokenAddress)) {
        return {
          address: tokenAddress,
          symbol: 'TRX',
          name: 'Tron',
          decimals: 6,
          chainId: chainId as any, // Tron uses string chain IDs
          isNative: true,
        };
      }

      if (this.isTrc20Token(tokenAddress)) {
        return this.getTrc20TokenInfo(chainId, tokenAddress);
      }

      if (this.isTrc10Token(tokenAddress)) {
        return this.getTrc10TokenInfo(chainId, tokenAddress);
      }

      throw new Error(`Unsupported token type for address: ${tokenAddress}`);
    } catch (error) {
      this.logger.error(
        `Failed to get Tron token info: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Tron token info: ${error.message}`);
    }
  }

  async getAllowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    try {
      this.validateTronChain(chainId);
      this.validateTronAddress(owner);
      this.validateTronAddress(spender);

      if (this.isNativeTronToken(tokenAddress)) {
        return '0'; // Native TRX doesn't need allowance
      }

      if (this.isTrc20Token(tokenAddress)) {
        return this.getTrc20Allowance(chainId, tokenAddress, owner, spender);
      }

      throw new Error('TRC10 tokens do not support allowance mechanism');
    } catch (error) {
      this.logger.error(
        `Failed to get Tron allowance: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get Tron allowance: ${error.message}`);
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
      this.validateTronChain(chainId);
      this.validateTronAddress(spender);
      this.validateTronPrivateKey(privateKey);

      if (this.isNativeTronToken(tokenAddress)) {
        throw new Error('Cannot approve native TRX token');
      }

      if (this.isTrc20Token(tokenAddress)) {
        return this.executeTrc20Approval(
          chainId,
          privateKey,
          tokenAddress,
          spender,
          amount,
        );
      }

      throw new Error('TRC10 tokens do not support approval mechanism');
    } catch (error) {
      this.logger.error(
        `Failed to execute Tron approval: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute Tron approval: ${error.message}`);
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
      this.validateTronChain(chainId);
      this.validateTronPrivateKey(privateKey);
      this.validateTronAddress(to);

      // Pre-check account resources (energy/bandwidth) before transaction
      const ownerAddress = this.getAddressFromPrivateKey(privateKey);
      const resourceCheck = await this.checkAccountResources(
        chainId,
        ownerAddress,
        data !== '0x' && data !== '',
      );

      if (!resourceCheck.sufficient) {
        this.logger.warn('Insufficient Tron resources detected', resourceCheck);
        // Log warning but continue - transaction will pay in TRX if needed
      } else {
        this.logger.debug('Tron resource check passed', resourceCheck);
      }

      // Parse function selector and feeLimit from gasLimit metadata if provided
      let providedFunctionSelector: string | undefined;
      let providedFeeLimit: string | undefined;
      let trc20TransferInfo: { recipient: string; amount: string } | undefined;
      try {
        if (gasLimit) {
          const metadata = JSON.parse(gasLimit);
          providedFunctionSelector = metadata.functionSelector;
          providedFeeLimit = metadata.feeLimit;
          trc20TransferInfo = metadata.trc20Transfer; // For CEX deposit TRC20 transfers
          this.logger.debug('Parsed metadata from gasLimit', {
            providedFunctionSelector,
            providedFeeLimit,
            trc20TransferInfo: !!trc20TransferInfo,
            metadataKeys: Object.keys(metadata),
          });
        }
      } catch (error) {
        this.logger.debug('No metadata found in gasLimit', {
          gasLimit,
          parseError: error.message,
        });
      }

      // Check if this is a TRC20 transfer request (CEX deposit)
      if (data === 'TRC20_TRANSFER' && trc20TransferInfo) {
        this.logger.debug('Executing TRC20 transfer to CEX deposit address', {
          tokenContract: to,
          recipient: trc20TransferInfo.recipient,
          amount: trc20TransferInfo.amount,
        });

        // Execute TRC20 transfer using the contract's transfer function
        // The 'to' parameter is the token contract address
        // The recipient and amount are in trc20TransferInfo
        return await this.executeTrc20Transfer(
          chainId,
          privateKey,
          to, // Token contract address
          trc20TransferInfo.recipient, // CEX deposit address
          trc20TransferInfo.amount, // Amount in atomic units
        );
      }

      if (this.tronWeb) {
        return this.executeTronWebTransaction(
          privateKey,
          to,
          data,
          value,
          providedFunctionSelector,
          providedFeeLimit,
        );
      } else {
        return this.executeHttpTransaction(
          chainId,
          privateKey,
          to,
          data,
          value,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to execute Tron transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to execute Tron transaction: ${error.message}`);
    }
  }

  async waitForTransactionConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number = 1,
  ): Promise<any> {
    try {
      this.validateTronChain(chainId);

      return this.waitForTronConfirmation(chainId, txHash, confirmations);
    } catch (error) {
      this.logger.error(
        `Failed to wait for Tron transaction: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to wait for Tron transaction: ${error.message}`);
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
      this.validateTronChain(chainId);

      return this.getTronTransactionStatus(chainId, txHash);
    } catch (error) {
      this.logger.error(
        `Failed to get Tron transaction status: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to get Tron transaction status: ${error.message}`,
      );
    }
  }

  getConfig(): WalletProviderConfig {
    return {
      name: 'Tron Wallet Provider',
      ecosystem: 'tron',
      enabled: true, // Now fully implemented
      supportedChains: [
        'tron-mainnet',
        'tron-testnet',
        'shasta-testnet',
        'nile-testnet',
      ],
    };
  }

  // ==================== PRIVATE HELPER METHODS ====================

  /**
   * Decode hex-encoded error messages from Tron API
   * Tron API often returns error messages in hex format that need to be decoded
   */
  private decodeHexMessage(message: any): string {
    if (!message) return '';

    const msgStr =
      typeof message === 'string' ? message : JSON.stringify(message);

    // Check if message looks like hex (starts with common hex patterns or is all hex chars)
    if (/^(0x)?[0-9a-fA-F]+$/.test(msgStr) && msgStr.length > 10) {
      try {
        // Remove 0x prefix if present
        const hex = msgStr.replace(/^0x/, '');

        // Convert hex to bytes
        const bytes: number[] = [];
        for (let i = 0; i < hex.length; i += 2) {
          bytes.push(parseInt(hex.substr(i, 2), 16));
        }

        // Convert bytes to string
        const decoded = String.fromCharCode(...bytes);

        // Only return decoded if it contains readable text
        if (/[a-zA-Z]/.test(decoded)) {
          this.logger.debug('Decoded hex message', {
            original: msgStr,
            decoded,
          });
          return decoded;
        }
      } catch (error) {
        this.logger.debug('Failed to decode hex message', {
          message: msgStr,
          error: error.message,
        });
      }
    }

    return msgStr;
  }

  private validateTronChain(chainId: number | string): void {
    if (!this.supportsChain(chainId)) {
      throw new Error(`Unsupported Tron chain: ${chainId}`);
    }
  }

  private validateTronPrivateKey(privateKey: string): void {
    // Basic validation - should be 64 character hex string
    if (
      !privateKey ||
      privateKey.length !== 64 ||
      !/^[0-9a-fA-F]+$/.test(privateKey)
    ) {
      throw new Error('Invalid Tron private key format');
    }
  }

  private isNativeTronToken(tokenAddress: string): boolean {
    return (
      !tokenAddress ||
      tokenAddress.toLowerCase() === 'native' ||
      tokenAddress.toLowerCase() === 'trx' ||
      tokenAddress === '0x0000000000000000000000000000000000000000' || // EVM-style native address
      tokenAddress === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    ); // Alternative EVM native marker
  }

  private isTrc20Token(tokenAddress: string): boolean {
    // TRC20 contracts have Tron addresses starting with 'T'
    return Boolean(
      tokenAddress &&
      tokenAddress.startsWith('T') &&
      tokenAddress.length === 34,
    );
  }

  private isTrc10Token(tokenAddress: string): boolean {
    // TRC10 tokens are identified by numeric IDs
    return Boolean(tokenAddress && /^\d+$/.test(tokenAddress));
  }

  /**
   * Check account energy and bandwidth resources before transaction
   * Returns resource availability to warn user or adjust fee limits
   */
  private async checkAccountResources(
    chainId: number | string,
    address: string,
    isSmartContract: boolean,
    simulatedEnergy?: number, // Optional simulated energy from contract simulation
  ): Promise<{
    sufficient: boolean;
    energy: { available: number; required: number };
    bandwidth: { available: number; required: number };
    willPayFee: boolean;
    estimatedFeeTrx: number;
  }> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        // Fetch account resource info
        const response = await fetch(`${rpcUrl}/wallet/getaccountresource`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, visible: true }),
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch account resources: ${response.statusText}`,
          );
        }

        const resources = await response.json();

        // Parse energy and bandwidth
        const energyLimit = resources.EnergyLimit || 0;
        const energyUsed = resources.EnergyUsed || 0;
        const energyAvailable = energyLimit - energyUsed;

        const freeNetLimit = resources.freeNetLimit || 5000; // Daily free bandwidth
        const freeNetUsed = resources.freeNetUsed || 0;
        const netLimit = resources.NetLimit || 0;
        const netUsed = resources.NetUsed || 0;
        const bandwidthAvailable =
          freeNetLimit - freeNetUsed + (netLimit - netUsed);

        // Estimate requirements
        // Use simulated energy if provided, otherwise use conservative estimate
        // Note: Complex TRC20 tokens like USDT can use 120k-140k energy
        const requiredEnergy =
          simulatedEnergy || (isSmartContract ? 150000 : 0);
        const requiredBandwidth = isSmartContract ? 400 : 270; // Bytes for tx (TRC20 transfers typically use ~345 bytes)

        const energySufficient =
          !isSmartContract || energyAvailable >= requiredEnergy;
        const bandwidthSufficient = bandwidthAvailable >= requiredBandwidth;
        const sufficient = energySufficient && bandwidthSufficient;

        // Estimate fee if resources insufficient
        let estimatedFeeTrx = 0;
        if (!energySufficient) {
          const energyDeficit = requiredEnergy - energyAvailable;
          estimatedFeeTrx += (energyDeficit * 420) / 1_000_000; // ~420 sun per energy unit
        }
        if (!bandwidthSufficient) {
          const bandwidthDeficit = requiredBandwidth - bandwidthAvailable;
          estimatedFeeTrx += (bandwidthDeficit * 1000) / 1_000_000; // ~1000 sun per byte
        }

        return {
          sufficient,
          energy: { available: energyAvailable, required: requiredEnergy },
          bandwidth: {
            available: bandwidthAvailable,
            required: requiredBandwidth,
          },
          willPayFee: !sufficient,
          estimatedFeeTrx,
        };
      }, 'checkAccountResources');
    } catch (error) {
      this.logger.warn(`Failed to check Tron resources: ${error.message}`);
      // Return conservative estimate on error (using higher estimate for complex TRC20 like USDT)
      return {
        sufficient: false,
        energy: { available: 0, required: isSmartContract ? 150000 : 0 },
        bandwidth: { available: 0, required: isSmartContract ? 400 : 270 },
        willPayFee: true,
        estimatedFeeTrx: isSmartContract ? 30 : 0.3, // Conservative estimate (150k energy * 420 sun / 1M = ~63 TRX, using 30 as minimum)
      };
    }
  }

  /**
   * Fetch current energy price from Tron network
   * Returns energy cost in SUN per energy unit
   * Falls back to 420 SUN if API call fails
   */
  private async getEnergyPrice(rpcUrl: string): Promise<number> {
    try {
      const response = await fetch(`${rpcUrl}/wallet/getenergyprices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Failed to fetch energy prices: ${response.status} ${response.statusText}`,
        );
        return 420; // Fallback to conservative estimate
      }

      const result = await response.json();

      // The API returns prices in format: { prices: "timestamp:price,timestamp:price,..." }
      // Example: "0:100,1575871200000:10,1614238080000:140,1751253480000:210"
      // We need to find the most recent price based on current timestamp
      const pricesStr = result.prices || result.price || '420';

      if (typeof pricesStr !== 'string') {
        this.logger.warn('Unexpected prices format from API, using fallback');
        return 420;
      }

      // Parse timestamp:price pairs
      const pricePairs = pricesStr.split(',').map((pair) => {
        const [timestamp, price] = pair.split(':');
        return {
          timestamp: parseInt(timestamp, 10),
          price: parseInt(price, 10),
        };
      });

      // Filter out invalid pairs
      const validPairs = pricePairs.filter(
        (pair) =>
          !isNaN(pair.timestamp) && !isNaN(pair.price) && pair.price > 0,
      );

      if (validPairs.length === 0) {
        this.logger.warn('No valid price pairs found, using fallback');
        return 420;
      }

      // Find the current price: the price from the most recent timestamp that's <= now
      const currentTimestamp = Date.now();
      const applicablePairs = validPairs.filter(
        (pair) => pair.timestamp <= currentTimestamp,
      );

      // If no applicable pairs (all timestamps in future), use the first one
      const currentPair =
        applicablePairs.length > 0
          ? applicablePairs[applicablePairs.length - 1] // Most recent applicable
          : validPairs[0]; // Fallback to first if all are in future

      const energyPrice = currentPair.price;

      this.logger.debug('Fetched current energy price from Tron network', {
        energyPrice,
        priceTimestamp: new Date(currentPair.timestamp).toISOString(),
        totalPricePoints: validPairs.length,
        pricesRaw: pricesStr,
      });

      return energyPrice;
    } catch (error) {
      this.logger.warn(
        `Failed to get energy prices: ${error.message}, using fallback 420 SUN`,
      );
      return 420; // Fallback to conservative estimate
    }
  }

  // ==================== TRX NATIVE TOKEN METHODS ====================

  private async getTrxBalance(
    chainId: number | string,
    walletAddress: string,
  ): Promise<BalanceInfo> {
    try {
      if (this.tronWeb && TronWebUtils.address.isAddress(walletAddress)) {
        // Use TronWeb if available - try with fallback
        return await this.executeWithFallback(async (rpcUrl) => {
          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          const balanceSun =
            await tronWebInstance.trx.getBalance(walletAddress);
          const balanceTrx = TronWeb.fromSun(balanceSun);

          return {
            tokenAddress: 'native',
            balance: balanceSun.toString(),
            formattedBalance: balanceTrx.toString(),
            decimals: 6,
            symbol: 'TRX',
          };
        }, 'getTrxBalance (TronWeb)');
      } else {
        // Fallback to HTTP API
        return this.getTrxBalanceHttp(chainId, walletAddress);
      }
    } catch (error) {
      this.logger.error(`Failed to get TRX balance: ${error.message}`);
      throw new Error(`Failed to get TRX balance: ${error.message}`);
    }
  }

  private async getTrxBalanceHttp(
    chainId: number | string,
    walletAddress: string,
  ): Promise<BalanceInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const response = await fetch(`${rpcUrl}/v1/accounts/${walletAddress}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const accountData = await response.json();
        const balanceSun = accountData.data?.[0]?.balance || 0;
        const balanceTrx = (balanceSun / 1_000_000).toString(); // Convert from Sun to TRX

        return {
          tokenAddress: 'native',
          balance: balanceSun.toString(),
          formattedBalance: balanceTrx,
          decimals: 6,
          symbol: 'TRX',
        };
      }, 'getTrxBalanceHttp');
    } catch (error) {
      this.logger.error(`Failed to get TRX balance via HTTP: ${error.message}`);
      throw new Error(`Failed to get TRX balance: ${error.message}`);
    }
  }

  // ==================== TRC20 TOKEN METHODS ====================

  private async getTrc20Balance(
    chainId: number | string,
    walletAddress: string,
    tokenAddress: string,
  ): Promise<BalanceInfo> {
    try {
      if (this.tronWeb) {
        return this.getTrc20BalanceTronWeb(walletAddress, tokenAddress);
      } else {
        return this.getTrc20BalanceHttp(chainId, walletAddress, tokenAddress);
      }
    } catch (error) {
      this.logger.error(`Failed to get TRC20 balance: ${error.message}`);
      throw new Error(`Failed to get TRC20 balance: ${error.message}`);
    }
  }

  private async getTrc20BalanceTronWeb(
    walletAddress: string,
    tokenAddress: string,
  ): Promise<BalanceInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const tronWebInstance = new TronWeb({
          fullHost: rpcUrl,
          headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
        });

        tronWebInstance.setAddress(walletAddress);
        const contract = tronWebInstance.contract(TRC20_ABI, tokenAddress);

        // Call contract methods properly with TronWeb
        const [balance, decimals, symbol] = await Promise.all([
          contract.balanceOf(walletAddress).call(),
          contract.decimals().call(),
          contract.symbol().call(),
        ]);

        const decimalsNumber = Number(decimals);
        const formattedBalance = (
          Number(balance.toString()) / Math.pow(10, decimalsNumber)
        ).toString();

        return {
          tokenAddress,
          balance: balance.toString(),
          formattedBalance,
          decimals: decimalsNumber,
          symbol: symbol.toString(),
        };
      }, 'getTrc20BalanceTronWeb');
    } catch (error) {
      this.logger.error(
        `Failed to get TRC20 balance via TronWeb: ${error.message}`,
      );
      throw new Error(`Failed to get TRC20 balance: ${error.message}`);
    }
  }

  private async getTrc20BalanceHttp(
    chainId: number | string,
    walletAddress: string,
    tokenAddress: string,
  ): Promise<BalanceInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        // Use triggerSmartContract to call balanceOf
        const parameter = [{ type: 'address', value: walletAddress }];

        const balanceCall = {
          owner_address: walletAddress,
          contract_address: tokenAddress,
          function_selector: 'balanceOf(address)',
          parameter: JSON.stringify(parameter),
          visible: true,
        };

        const response = await fetch(
          `${rpcUrl}/wallet/triggerconstantcontract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(balanceCall),
          },
        );

        const result = await response.json();

        if (!response.ok || result.result?.result === false) {
          throw new Error(
            `Failed to get balance: ${result.message || 'Contract call failed'}`,
          );
        }

        const balance = result.constant_result?.[0]
          ? parseInt(result.constant_result[0], 16).toString()
          : '0';

        // Get token info for decimals and symbol
        const tokenInfo = await this.getTrc20TokenInfoHttp(
          chainId,
          tokenAddress,
        );
        const formattedBalance = (
          Number(balance) / Math.pow(10, tokenInfo.decimals)
        ).toString();

        return {
          tokenAddress,
          balance,
          formattedBalance,
          decimals: tokenInfo.decimals,
          symbol: tokenInfo.symbol,
        };
      }, 'getTrc20BalanceHttp');
    } catch (error) {
      this.logger.error(
        `Failed to get TRC20 balance via HTTP: ${error.message}`,
      );
      throw new Error(`Failed to get TRC20 balance: ${error.message}`);
    }
  }

  private async getTrc20TokenInfo(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      if (this.tronWeb) {
        return await this.executeWithFallback(async (rpcUrl) => {
          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          const contract = tronWebInstance.contract(TRC20_ABI, tokenAddress);

          const [name, symbol, decimals] = await Promise.all([
            contract.name().call(),
            contract.symbol().call(),
            contract.decimals().call(),
          ]);

          return {
            address: tokenAddress,
            symbol: symbol.toString(),
            name: name.toString(),
            decimals: Number(decimals),
            chainId: chainId as any,
            isNative: false,
          };
        }, 'getTrc20TokenInfo');
      } else {
        return this.getTrc20TokenInfoHttp(chainId, tokenAddress);
      }
    } catch (error) {
      this.logger.error(`Failed to get TRC20 token info: ${error.message}`);
      throw new Error(`Failed to get TRC20 token info: ${error.message}`);
    }
  }

  private async getTrc20TokenInfoHttp(
    chainId: number | string,
    tokenAddress: string,
  ): Promise<TokenInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const response = await fetch(`${rpcUrl}/v1/contracts/${tokenAddress}`);
        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            `Failed to get token info: ${result.message || 'Unknown error'}`,
          );
        }

        const tokenData = result.data?.[0];
        if (!tokenData) {
          throw new Error('Token contract not found');
        }

        return {
          address: tokenAddress,
          symbol: tokenData.symbol || 'UNKNOWN',
          name: tokenData.name || 'Unknown Token',
          decimals: tokenData.decimals || 6,
          chainId: chainId as any,
          isNative: false,
        };
      }, 'getTrc20TokenInfoHttp');
    } catch (error) {
      this.logger.error(
        `Failed to get TRC20 token info via HTTP: ${error.message}`,
      );
      throw new Error(`Failed to get TRC20 token info: ${error.message}`);
    }
  }

  private async getTrc20Allowance(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    try {
      if (this.tronWeb) {
        return await this.executeWithFallback(async (rpcUrl) => {
          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          const contract = tronWebInstance.contract(TRC20_ABI, tokenAddress);
          const allowance = await contract.allowance(owner, spender).call();
          return allowance.toString();
        }, 'getTrc20Allowance');
      } else {
        return this.getTrc20AllowanceHttp(
          chainId,
          tokenAddress,
          owner,
          spender,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to get TRC20 allowance: ${error.message}`);
      throw new Error(`Failed to get TRC20 allowance: ${error.message}`);
    }
  }

  private async getTrc20AllowanceHttp(
    chainId: number | string,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const parameter = [
          { type: 'address', value: owner },
          { type: 'address', value: spender },
        ];

        const allowanceCall = {
          owner_address: owner,
          contract_address: tokenAddress,
          function_selector: 'allowance(address,address)',
          parameter: JSON.stringify(parameter),
          visible: true,
        };

        const response = await fetch(
          `${rpcUrl}/wallet/triggerconstantcontract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allowanceCall),
          },
        );

        const result = await response.json();

        if (!response.ok || result.result?.result === false) {
          throw new Error(
            `Failed to get allowance: ${result.message || 'Contract call failed'}`,
          );
        }

        const allowance = result.constant_result?.[0]
          ? parseInt(result.constant_result[0], 16).toString()
          : '0';

        return allowance;
      }, 'getTrc20AllowanceHttp');
    } catch (error) {
      this.logger.error(
        `Failed to get TRC20 allowance via HTTP: ${error.message}`,
      );
      throw new Error(`Failed to get TRC20 allowance: ${error.message}`);
    }
  }

  private async executeTrc20Approval(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<string> {
    try {
      if (this.tronWeb) {
        return await this.executeWithFallback(async (rpcUrl) => {
          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          // Set private key for signing
          tronWebInstance.setPrivateKey(privateKey);

          const contract = tronWebInstance.contract(TRC20_ABI, tokenAddress);
          const transaction = await contract.approve(spender, amount).send({
            feeLimit: 100_000_000, // 100 TRX
          });

          return (
            transaction.txid || transaction.transaction?.txID || transaction
          );
        }, 'executeTrc20Approval');
      } else {
        return this.executeTrc20ApprovalHttp(
          chainId,
          privateKey,
          tokenAddress,
          spender,
          amount,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to execute TRC20 approval: ${error.message}`);
      throw new Error(`Failed to execute TRC20 approval: ${error.message}`);
    }
  }

  private async executeTrc20ApprovalHttp(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const ownerAddress = this.getAddressFromPrivateKey(privateKey);

        // Use triggerSmartContract for approve function
        const parameter = [
          { type: 'address', value: spender },
          { type: 'uint256', value: amount },
        ];

        const transaction = {
          owner_address: ownerAddress,
          contract_address: tokenAddress,
          function_selector: 'approve(address,uint256)',
          parameter: JSON.stringify(parameter),
          fee_limit: 100_000_000, // 100 TRX fee limit
          visible: true,
        };

        const createResponse = await fetch(
          `${rpcUrl}/wallet/triggersmartcontract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(transaction),
          },
        );

        const createResult = await createResponse.json();

        if (!createResponse.ok || createResult.result?.result === false) {
          throw new Error(
            `Failed to create transaction: ${createResult.message || 'Transaction creation failed'}`,
          );
        }

        // Sign transaction
        const signedTx = await this.signTransaction(
          createResult.transaction,
          privateKey,
        );

        // Broadcast transaction
        const broadcastResponse = await fetch(
          `${rpcUrl}/wallet/broadcasttransaction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedTx),
          },
        );

        const broadcastResult = await broadcastResponse.json();

        if (!broadcastResponse.ok || broadcastResult.result !== true) {
          throw new Error(
            `Failed to broadcast transaction: ${broadcastResult.message || 'Broadcast failed'}`,
          );
        }

        return broadcastResult.txid;
      }, 'executeTrc20ApprovalHttp');
    } catch (error) {
      this.logger.error(
        `Failed to execute TRC20 approval via HTTP: ${error.message}`,
      );
      throw new Error(`Failed to execute TRC20 approval: ${error.message}`);
    }
  }

  /**
   * Execute TRC20 token transfer (for CEX deposits and direct transfers)
   */
  private async executeTrc20Transfer(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    recipient: string,
    amount: string,
  ): Promise<string> {
    this.logger.debug('🔍 executeTrc20Transfer called', {
      tokenAddress,
      recipient,
      amount,
    });

    try {
      if (this.tronWeb) {
        return await this.executeWithFallback(async (rpcUrl) => {
          this.logger.debug('📡 Executing TRC20 transfer via TronWeb', {
            rpcUrl,
            tokenAddress,
            recipient,
            amount,
          });

          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          // Set private key for signing
          tronWebInstance.setPrivateKey(privateKey);
          const ownerAddress = this.getAddressFromPrivateKey(privateKey);

          this.logger.debug('Simulating TRC20 transfer to estimate resources', {
            tokenAddress,
            recipient,
            amount,
          });

          // Step 1: Simulate the transaction to get accurate energy/bandwidth requirements
          const simulationTransaction = {
            owner_address: ownerAddress,
            contract_address: tokenAddress,
            function_selector: 'transfer(address,uint256)',
            parameter: JSON.stringify([
              { type: 'address', value: recipient },
              { type: 'uint256', value: amount },
            ]),
            call_value: 0,
            visible: true,
          };

          const simulationResponse = await fetch(
            `${rpcUrl}/wallet/triggerconstantcontract`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
              },
              body: JSON.stringify(simulationTransaction),
            },
          );

          const simulationResult = await simulationResponse.json();

          if (
            !simulationResponse.ok ||
            simulationResult.result?.result === false
          ) {
            this.logger.error('TRC20 transfer simulation failed', {
              error:
                simulationResult.result?.message ||
                simulationResult.message ||
                'Unknown simulation error',
              simulationResult,
              tokenAddress,
              recipient,
              amount,
            });
            throw new Error(
              `TRC20 transfer simulation failed: ${simulationResult.result?.message || simulationResult.message || 'Unknown error'}`,
            );
          }

          // Extract actual energy requirements from simulation
          const estimatedEnergy = simulationResult.energy_used || 0;
          const energyPenalty = simulationResult.energy_penalty || 0;
          const totalEnergyNeeded = estimatedEnergy + energyPenalty;

          this.logger.debug('TRC20 transfer simulation completed', {
            estimatedEnergy,
            energyPenalty,
            totalEnergyNeeded,
            simulationSuccess: simulationResult.result?.result,
          });

          // Step 2: Check if wallet has sufficient resources
          const resourceCheck = await this.checkAccountResources(
            chainId,
            ownerAddress,
            true, // isSmartContract
            totalEnergyNeeded, // Pass simulated energy requirement
          );

          if (!resourceCheck.sufficient) {
            this.logger.warn('Insufficient resources for TRC20 transfer', {
              ...resourceCheck,
              tokenAddress,
              recipient,
              amount,
            });
            // Continue anyway - transaction will pay in TRX
          } else {
            this.logger.debug(
              'Sufficient resources available for TRC20 transfer',
              resourceCheck,
            );
          }

          // Step 3: Calculate optimal fee limit based on simulation
          const energyPricePerUnit = await this.getEnergyPrice(rpcUrl);
          const energyCostSun = totalEnergyNeeded * energyPricePerUnit;
          const safetyMargin = energyCostSun * 0.1; // 10% extra for safety
          const calculatedFeeLimit = Math.ceil(energyCostSun + safetyMargin);
          const finalFeeLimit = Math.max(calculatedFeeLimit, 50_000_000); // Minimum 50 TRX

          this.logger.debug('Calculated fee limit from simulation', {
            totalEnergyNeeded,
            energyPricePerUnit,
            energyCostSun,
            safetyMargin,
            calculatedFeeLimit,
            finalFeeLimit,
            finalFeeLimitTrx: finalFeeLimit / 1_000_000,
          });

          this.logger.debug('� Building TRC20 transfer transaction', {
            tokenAddress,
            recipient,
            amount,
          });

          // Use triggerSmartContract for explicit control (Method 2 from TronWeb docs)
          const { transaction, result } =
            await tronWebInstance.transactionBuilder.triggerSmartContract(
              tokenAddress,
              'transfer(address,uint256)',
              {
                feeLimit: finalFeeLimit, // Use simulation-calculated fee limit
                callValue: 0, // TRC20 transfers don't send TRX
              },
              [
                { type: 'address', value: recipient },
                { type: 'uint256', value: amount },
              ],
            );

          if (!result.result) {
            this.logger.error('❌ TRC20 transfer transaction build failed', {
              result,
              tokenAddress,
              recipient,
              amount,
            });
            throw new Error(
              `TRC20 transfer build failed: ${JSON.stringify(result)}`,
            );
          }

          this.logger.debug('📝 Signing TRC20 transfer transaction', {
            transaction: !!transaction,
          });

          // Sign the transaction
          const signedTxn = await tronWebInstance.trx.sign(transaction);

          this.logger.debug('📡 Broadcasting TRC20 transfer transaction');

          // Broadcast the transaction
          const broadcast =
            await tronWebInstance.trx.sendRawTransaction(signedTxn);

          if (!broadcast.result) {
            const errorMsg = broadcast.message
              ? Buffer.from(broadcast.message, 'hex').toString()
              : 'Unknown error';
            this.logger.error('❌ TRC20 transfer broadcast failed', {
              error: errorMsg,
              broadcast,
            });
            throw new Error(`TRC20 transfer broadcast failed: ${errorMsg}`);
          }

          const txId = broadcast.txid || signedTxn.txID;

          this.logger.debug('✅ TRC20 transfer transaction sent', {
            txId,
            tokenAddress,
            recipient,
            amount,
          });

          return txId;
        }, 'executeTrc20Transfer');
      } else {
        return this.executeTrc20TransferHttp(
          chainId,
          privateKey,
          tokenAddress,
          recipient,
          amount,
        );
      }
    } catch (error) {
      this.logger.error('❌ Failed to execute TRC20 transfer', {
        tokenAddress,
        recipient,
        amount,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Failed to execute TRC20 transfer: ${error.message}`);
    }
  }

  private async executeTrc20TransferHttp(
    chainId: number | string,
    privateKey: string,
    tokenAddress: string,
    recipient: string,
    amount: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const ownerAddress = this.getAddressFromPrivateKey(privateKey);

        // Use triggerSmartContract for transfer function
        const parameter = [
          { type: 'address', value: recipient },
          { type: 'uint256', value: amount },
        ];

        const transaction = {
          owner_address: ownerAddress,
          contract_address: tokenAddress,
          function_selector: 'transfer(address,uint256)',
          parameter: JSON.stringify(parameter),
          fee_limit: 100_000_000, // 100 TRX fee limit
          visible: true,
        };

        const createResponse = await fetch(
          `${rpcUrl}/wallet/triggersmartcontract`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(transaction),
          },
        );

        const createResult = await createResponse.json();

        if (!createResponse.ok || createResult.result?.result === false) {
          throw new Error(
            `Failed to create transfer transaction: ${createResult.message || 'Transaction creation failed'}`,
          );
        }

        // Sign transaction
        const signedTx = await this.signTransaction(
          createResult.transaction,
          privateKey,
        );

        // Broadcast transaction
        const broadcastResponse = await fetch(
          `${rpcUrl}/wallet/broadcasttransaction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedTx),
          },
        );

        const broadcastResult = await broadcastResponse.json();

        if (!broadcastResponse.ok || broadcastResult.result !== true) {
          throw new Error(
            `Failed to broadcast transfer transaction: ${broadcastResult.message || 'Broadcast failed'}`,
          );
        }

        return broadcastResult.txid;
      }, 'executeTrc20TransferHttp');
    } catch (error) {
      this.logger.error(
        `Failed to execute TRC20 transfer via HTTP: ${error.message}`,
      );
      throw new Error(`Failed to execute TRC20 transfer: ${error.message}`);
    }
  }

  // ==================== TRC10 TOKEN METHODS ====================

  private async getTrc10Balance(
    chainId: number | string,
    walletAddress: string,
    tokenId: string,
  ): Promise<BalanceInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const response = await fetch(`${rpcUrl}/v1/accounts/${walletAddress}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const accountData = await response.json();
        const assetV2 = accountData.data?.[0]?.assetV2;

        if (!assetV2 || !assetV2[tokenId]) {
          return {
            tokenAddress: tokenId,
            balance: '0',
            formattedBalance: '0',
            decimals: 6, // Default for TRC10
            symbol: `TRC10_${tokenId}`,
          };
        }

        const balance = assetV2[tokenId].toString();
        const formattedBalance = (Number(balance) / 1_000_000).toString(); // Most TRC10 have 6 decimals

        return {
          tokenAddress: tokenId,
          balance,
          formattedBalance,
          decimals: 6,
          symbol: `TRC10_${tokenId}`,
        };
      }, 'getTrc10Balance');
    } catch (error) {
      this.logger.error(`Failed to get TRC10 balance: ${error.message}`);
      throw new Error(`Failed to get TRC10 balance: ${error.message}`);
    }
  }

  private async getTrc10TokenInfo(
    chainId: number | string,
    tokenId: string,
  ): Promise<TokenInfo> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const response = await fetch(`${rpcUrl}/v1/assets/${tokenId}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const tokenData = await response.json();
        const data = tokenData.data?.[0];

        if (!data) {
          throw new Error('TRC10 token not found');
        }

        return {
          address: tokenId,
          symbol: data.abbr || `TRC10_${tokenId}`,
          name: data.name || `TRC10 Token ${tokenId}`,
          decimals: data.precision || 6,
          chainId: chainId as any,
          isNative: false,
        };
      }, 'getTrc10TokenInfo');
    } catch (error) {
      this.logger.error(`Failed to get TRC10 token info: ${error.message}`);
      throw new Error(`Failed to get TRC10 token info: ${error.message}`);
    }
  }

  private async executeSmartContractCall(
    privateKey: string,
    to: string,
    data: string,
    value: string,
    rpcUrl: string,
    providedFunctionSelector?: string,
    providedFeeLimit?: string,
  ): Promise<string> {
    try {
      const ownerAddress = this.getAddressFromPrivateKey(privateKey);

      // Convert hex data to parameter string that Tron accepts
      // Remove '0x' prefix if present
      const cleanData = data.startsWith('0x') ? data.slice(2) : data;

      const valueInSun = Math.floor(Number(value) || 0);

      this.logger.debug('Preparing smart contract transaction', {
        from: ownerAddress,
        to,
        valueInSun,
        dataLength: cleanData.length,
        providedFunctionSelector,
      });

      let functionSelector: string;
      let parameters: string;

      // Check if function selector is provided separately by Symbiosis
      if (providedFunctionSelector) {
        this.logger.debug('Using function selector provided by Symbiosis', {
          providedFunctionSelector,
          dataLength: cleanData.length,
        });

        // If function selector is provided separately, the data field contains only parameters
        functionSelector = providedFunctionSelector;
        parameters = cleanData;
      } else {
        // Fallback: Parse function selector from data field (old approach)
        if (cleanData.length < 8) {
          throw new Error(
            'Invalid transaction data: too short for function selector',
          );
        }

        const functionSelectorHash = cleanData.slice(0, 8); // First 4 bytes (8 hex chars)
        parameters = cleanData.slice(8); // Remaining bytes are parameters

        // Map function selector hash to human-readable function signature
        const functionSignatureMap: Record<string, string> = {
          '21c69a19': 'onswap(address,uint256,address,address,bytes)', // Symbiosis onswap function
          a9059cbb: 'transfer(address,uint256)', // Standard ERC20 transfer
          '095ea7b3': 'approve(address,uint256)', // Standard ERC20 approve
          // Add more mappings as needed
        };

        functionSelector =
          functionSignatureMap[functionSelectorHash.toLowerCase()];

        if (!functionSelector) {
          this.logger.error(
            `Unknown function selector hash: ${functionSelectorHash}. Known functions:`,
            functionSignatureMap,
          );
          throw new Error(
            `Unknown function selector: 0x${functionSelectorHash}`,
          );
        }

        this.logger.debug('Parsed function selector from data field', {
          functionSelectorHash: `0x${functionSelectorHash}`,
          functionSelector,
          parametersLength: parameters.length,
        });
      }

      // Verify we have a valid function selector
      if (!functionSelector) {
        throw new Error(
          'No function selector available - neither provided separately nor parseable from data',
        );
      }

      this.logger.debug('Final transaction parameters', {
        functionSelector,
        contract: to,
        value: valueInSun,
        parametersLength: parameters.length,
        parametersPreview: parameters.slice(0, 20) + '...',
        providedFeeLimit,
      });

      // Step 1: Simulate transaction to estimate energy and validate execution
      this.logger.debug(
        'Simulating transaction with triggerconstantcontract API',
      );
      const simulationTransaction = {
        owner_address: ownerAddress,
        contract_address: to,
        function_selector: functionSelector,
        parameter: parameters,
        call_value: valueInSun,
        visible: true,
      };

      const simulationResponse = await fetch(
        `${rpcUrl}/wallet/triggerconstantcontract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
          },
          body: JSON.stringify(simulationTransaction),
        },
      );

      const simulationResult = await simulationResponse.json();

      if (!simulationResponse.ok || simulationResult.result?.result === false) {
        this.logger.error('Transaction simulation failed', {
          error: simulationResult.result?.message || 'Unknown simulation error',
          simulationResult,
        });
        throw new Error(
          `Transaction simulation failed: ${simulationResult.result?.message || 'Unknown error'}`,
        );
      }

      // Extract energy estimate from simulation
      const estimatedEnergy = simulationResult.energy_used || 0;
      const energyPenalty = simulationResult.energy_penalty || 0;
      const totalEnergyNeeded = estimatedEnergy + energyPenalty;

      this.logger.debug('Transaction simulation completed successfully', {
        estimatedEnergy,
        energyPenalty,
        totalEnergyNeeded,
        simulationSuccess: simulationResult.result?.result,
        constantResult: simulationResult.constant_result?.[0],
      });

      // Step 2: Calculate optimal fee limit based on simulation
      let calculatedFeeLimit: number;

      if (totalEnergyNeeded > 0) {
        // Calculate fee based on actual energy requirements
        // Fetch current energy price from Tron network (dynamic pricing)
        const energyPricePerUnit = await this.getEnergyPrice(rpcUrl);
        const energyCostSun = totalEnergyNeeded * energyPricePerUnit;
        const safetyMargin = energyCostSun * 0.02; // 2% extra for safety
        const simulationBasedLimit = Math.ceil(energyCostSun + safetyMargin);

        // Use the higher of: simulation-based limit, provided limit, or minimum safe limit
        const minimumSafeLimit = 50_000_000; // 50 TRX minimum
        const providedLimit = providedFeeLimit
          ? parseInt(providedFeeLimit, 10)
          : 0;

        calculatedFeeLimit = Math.max(
          simulationBasedLimit,
          providedLimit,
          minimumSafeLimit,
        );

        this.logger.debug('Calculated fee limit based on simulation', {
          estimatedEnergy,
          totalEnergyNeeded,
          energyPricePerUnit,
          energyCostSun,
          safetyMargin,
          safetyMarginPercent: '2%',
          simulationBasedLimit,
          providedLimit,
          minimumSafeLimit,
          calculatedFeeLimit,
          calculatedFeeTrx: calculatedFeeLimit / 1_000_000,
        });
      } else {
        // Fallback to previous logic if simulation doesn't provide energy estimate
        if (providedFeeLimit) {
          const symbiosisLimit = parseInt(providedFeeLimit, 10);
          const minimumSafeLimit = 200_000_000; // 200 TRX
          calculatedFeeLimit = Math.max(symbiosisLimit, minimumSafeLimit);

          this.logger.debug(
            'Using enhanced fee limit (simulation had no energy estimate)',
            {
              providedFeeLimit,
              symbiosisLimit,
              minimumSafeLimit,
              calculatedFeeLimit,
            },
          );
        } else {
          calculatedFeeLimit = 300_000_000; // 300 TRX default
          this.logger.debug(
            'Using default fee limit (no simulation data or provided limit)',
          );
        }
      }

      // Step 3: Check account balance before executing transaction
      this.logger.debug(
        'Checking account balance before transaction execution',
      );

      try {
        const balanceResponse = await fetch(
          `${rpcUrl}/v1/accounts/${ownerAddress}`,
        );
        if (balanceResponse.ok) {
          const balanceData = await balanceResponse.json();
          const accountBalance = balanceData.data?.[0]?.balance || 0; // Balance in SUN
          const requiredTotal = valueInSun + calculatedFeeLimit; // Value + Fee in SUN

          this.logger.debug('Account balance verification', {
            accountBalance,
            accountBalanceTrx: accountBalance / 1_000_000,
            valueInSun,
            valueTrx: valueInSun / 1_000_000,
            calculatedFeeLimit,
            calculatedFeeLimitTrx: calculatedFeeLimit / 1_000_000,
            requiredTotal,
            requiredTotalTrx: requiredTotal / 1_000_000,
            sufficient: accountBalance >= requiredTotal,
          });

          if (accountBalance < requiredTotal) {
            const shortfall = requiredTotal - accountBalance;
            throw new Error(
              `Insufficient TRX balance for swap execution. ` +
                `Required: ${(requiredTotal / 1_000_000).toFixed(6)} TRX ` +
                `(${(valueInSun / 1_000_000).toFixed(6)} TRX for transaction + ${(calculatedFeeLimit / 1_000_000).toFixed(6)} TRX for fees), ` +
                `Available: ${(accountBalance / 1_000_000).toFixed(6)} TRX, ` +
                `Shortfall: ${(shortfall / 1_000_000).toFixed(6)} TRX. ` +
                `Please add more TRX to your account and try again.`,
            );
          }
        } else {
          this.logger.warn(
            'Could not fetch account balance for verification, proceeding with transaction',
          );
        }
      } catch (error) {
        // If balance check fails, log warning but don't prevent transaction
        // The error might be from balance API, not actual insufficient funds
        if (error.message.includes('Insufficient TRX balance')) {
          // Re-throw balance insufficiency errors
          throw error;
        } else {
          this.logger.warn(
            'Balance verification failed, proceeding with transaction',
            {
              error: error.message,
            },
          );
        }
      }

      // Step 4: Execute the actual transaction with calculated fee limit
      this.logger.debug(
        'Executing actual transaction with optimized fee limit',
        {
          finalFeeLimit: calculatedFeeLimit,
          finalFeeLimitTrx: calculatedFeeLimit / 1_000_000,
        },
      );

      // Build transaction using Tron's expected format with simulation-optimized fee limit
      const transaction = {
        owner_address: ownerAddress,
        contract_address: to,
        function_selector: functionSelector, // Human-readable function signature
        parameter: parameters, // Just the parameters, without function selector hash
        call_value: valueInSun,
        fee_limit: calculatedFeeLimit, // Use simulation-calculated fee limit
        visible: true,
      };

      // Create transaction using triggersmartcontract API
      const createResponse = await fetch(
        `${rpcUrl}/wallet/triggersmartcontract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
          },
          body: JSON.stringify(transaction),
        },
      );

      const createResult = await createResponse.json();

      if (!createResponse.ok || createResult.result?.result === false) {
        const errorMsg =
          createResult.message ||
          createResult.error ||
          'Smart contract transaction creation failed';
        throw new Error(
          `Failed to create smart contract transaction: ${errorMsg}`,
        );
      }

      if (!createResult.transaction) {
        throw new Error('No transaction returned from smart contract creation');
      }

      this.logger.debug('Smart contract transaction created successfully', {
        functionSelector: functionSelector,
        transactionKeys: Object.keys(createResult.transaction),
      });

      // Sign transaction using existing method
      const signedTx = await this.signTransaction(
        createResult.transaction,
        privateKey,
      );

      // Broadcast transaction
      const broadcastResponse = await fetch(
        `${rpcUrl}/wallet/broadcasttransaction`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
          },
          body: JSON.stringify(signedTx),
        },
      );

      const broadcastResult = await broadcastResponse.json();

      if (!broadcastResponse.ok || broadcastResult.result !== true) {
        const errorMsg =
          broadcastResult.message ||
          broadcastResult.error ||
          'Smart contract transaction broadcast failed';
        throw new Error(
          `Failed to broadcast smart contract transaction: ${errorMsg}`,
        );
      }

      const txid = broadcastResult.txid;
      if (!txid) {
        throw new Error(
          'No transaction ID returned from smart contract broadcast',
        );
      }

      this.logger.log('Smart contract transaction executed successfully', {
        txid,
        to,
        valueInSun,
      });

      return txid;
    } catch (error) {
      this.logger.error('Smart contract execution error', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  // ==================== TRANSACTION EXECUTION METHODS ====================

  private async executeTronWebTransaction(
    privateKey: string,
    to: string,
    data: string,
    value: string,
    providedFunctionSelector?: string,
    providedFeeLimit?: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const tronWebInstance = new TronWeb({
          fullHost: rpcUrl,
          headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
        });

        tronWebInstance.setPrivateKey(privateKey);

        if (data && data !== '0x' && data !== '') {
          // Smart contract interaction - use triggerSmartContract
          this.logger.log('Executing smart contract call', {
            to,
            value: value,
            dataLength: data.length,
            hasData: !!data,
          });

          return await this.executeSmartContractCall(
            privateKey,
            to,
            data,
            value,
            rpcUrl,
            providedFunctionSelector, // Pass function selector from metadata
            providedFeeLimit, // Pass fee limit from metadata
          );
        }

        // ========================================================================
        // TRON TRANSACTION EXECUTION (Simple TRX Transfer)
        // ========================================================================
        //
        // For simple TRX transfers, TronWeb's sendTransaction() method:
        // 1. Only accepts 2 parameters: to (address) and amount (in SUN)
        // 2. Does NOT support feeLimit parameter (only for smart contracts)
        // 3. Automatically calculates bandwidth consumption based on tx size
        // 4. Burns TRX from sender's balance if free bandwidth is insufficient
        //
        // Bandwidth fee calculation:
        // - Transaction size: ~250-350 bytes (typical)
        // - Cost: 1,000 SUN per byte if no free bandwidth
        // - Free bandwidth: 600 units per day per account
        // - Burned from balance: 250,000-350,000 SUN (0.25-0.35 TRX) if needed
        //
        // IMPORTANT: Fee is deducted DURING broadcast, not specified upfront.
        // The amount adjustment logic reserves 5 TRX from balance to ensure
        // sufficient TRX remains for bandwidth fees + potential energy costs
        // for bridge contract interactions.
        // ========================================================================

        const valueInSun = Math.floor(Number(value) || 0);

        const fromAddressResult =
          tronWebInstance.address.fromPrivateKey(privateKey);
        if (!fromAddressResult || typeof fromAddressResult !== 'string') {
          throw new Error('Failed to derive Tron address from private key');
        }
        const fromAddress = fromAddressResult;

        this.logger.debug(
          'Executing Tron native transfer (bandwidth-based fees)',
          {
            from: fromAddress,
            to,
            valueInSun,
            valueRaw: value,
            rpcUrl,
            hasApiKey: !!this.envConfig.tronApiKey,
            note: 'Bandwidth fees (0.25-0.5 TRX) will be burned from balance during broadcast if free bandwidth depleted',
          },
        );

        // IMPORTANT: Use proper TronGrid HTTP API flow instead of convenience method
        // TronWeb's trx.sendTransaction() can fail with 404 on some RPC endpoints
        //
        // Proper flow:
        // 1. Create unsigned transaction via /wallet/createtransaction
        // 2. Sign transaction locally with private key
        // 3. Broadcast signed transaction via /wallet/broadcasttransaction

        // Step 1: Create unsigned transaction
        this.logger.debug(
          'Step 1: Creating unsigned transaction with transactionBuilder.sendTrx',
          {
            from: fromAddress,
            to,
            valueInSun,
            note: 'Creating TRX transfer',
          },
        );

        // Create transaction (sendTrx only accepts 3 params: to, amount, from)
        const unsignedTx = await tronWebInstance.transactionBuilder.sendTrx(
          to,
          valueInSun,
          fromAddress,
        );

        this.logger.debug('Unsigned transaction created', {
          hasTransaction: !!unsignedTx,
        });

        // Step 2: Sign transaction
        this.logger.debug('Step 2: Signing transaction');
        const signedTx = await tronWebInstance.trx.sign(unsignedTx, privateKey);
        this.logger.debug('Transaction signed', { hasSigned: !!signedTx });

        // Step 3: Broadcast signed transaction
        this.logger.debug(
          'Step 3: Broadcasting transaction with sendRawTransaction',
        );
        const transaction =
          await tronWebInstance.trx.sendRawTransaction(signedTx);

        // Log the full transaction response for debugging
        this.logger.debug('Tron transaction response:', {
          transaction,
          hasTxid: !!transaction?.txid,
          hasTransactionTxID: !!transaction?.transaction?.txID,
          result: transaction?.result,
          code: transaction?.code,
          message: transaction?.message,
        });

        // Check if transaction was successfully broadcast
        // TronWeb returns a result object with txid, but broadcast might fail
        if (
          !transaction ||
          (!transaction.txid && !transaction.transaction?.txID)
        ) {
          this.logger.error(
            'Transaction broadcast failed - no transaction ID returned',
            {
              transaction,
              transactionKeys: transaction ? Object.keys(transaction) : [],
            },
          );
          throw new Error(
            'Transaction broadcast failed - no transaction ID returned',
          );
        }

        // Check for explicit broadcast failure
        if (transaction.result === false || transaction.code) {
          // Decode hex error messages
          const decodedMessage = this.decodeHexMessage(transaction.message);
          const decodedCode = this.decodeHexMessage(transaction.code);
          const errorMessage = decodedMessage || decodedCode || 'Unknown error';

          this.logger.error('Tron transaction broadcast failed', {
            result: transaction.result,
            code: transaction.code,
            decodedCode,
            message: transaction.message,
            decodedMessage,
            error: errorMessage,
          });

          // Check for insufficient balance error
          const errorStr = String(errorMessage).toLowerCase();
          if (
            errorStr.includes('insufficient') ||
            errorStr.includes('balance') ||
            errorStr.includes('not enough')
          ) {
            throw new Error(
              `Insufficient TRX balance for transaction + fees. Please ensure you have enough TRX for both the transfer amount and network fees (typically 1-5 TRX).`,
            );
          }

          throw new Error(`Transaction broadcast failed: ${errorMessage}`);
        }

        return (
          transaction.txid ||
          transaction.transaction?.txID ||
          transaction
        ).toString();
      }, 'executeTronWebTransaction');
    } catch (error) {
      this.logger.error(
        `Failed to execute TronWeb transaction: ${error.message}`,
      );
      throw new Error(`Failed to execute transaction: ${error.message}`);
    }
  }

  private async executeHttpTransaction(
    chainId: number | string,
    privateKey: string,
    to: string,
    data: string,
    value: string,
  ): Promise<string> {
    try {
      return await this.executeWithFallback(async (rpcUrl) => {
        const fromAddress = this.getAddressFromPrivateKey(privateKey);
        const valueInSun = Math.floor(Number(value)); // Value is already in SUN (atomic units)

        this.logger.debug(
          'Creating Tron native transfer via HTTP (bandwidth-based fees)',
          {
            from: fromAddress,
            to,
            valueInSun,
            valueRaw: value,
            note: 'Bandwidth fees will be burned from balance during broadcast',
          },
        );

        // Create transaction using transactionBuilder style
        const transaction = {
          to_address: to,
          owner_address: fromAddress,
          amount: valueInSun,
          visible: true,
        };

        const createResponse = await fetch(
          `${rpcUrl}/wallet/createtransaction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(transaction),
          },
        );

        const createResult = await createResponse.json();

        if (!createResponse.ok) {
          throw new Error(
            `Failed to create transaction: ${createResult.message || 'Unknown error'}`,
          );
        }

        // Sign transaction
        const signedTx = await this.signTransaction(createResult, privateKey);

        // Broadcast transaction
        const broadcastResponse = await fetch(
          `${rpcUrl}/wallet/broadcasttransaction`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedTx),
          },
        );

        const broadcastResult = await broadcastResponse.json();

        this.logger.debug('Tron transaction broadcast result (HTTP)', {
          ok: broadcastResponse.ok,
          result: broadcastResult.result,
          txid: broadcastResult.txid,
          message: broadcastResult.message,
          code: broadcastResult.code,
        });

        if (!broadcastResponse.ok || broadcastResult.result !== true) {
          // Decode hex error messages
          const decodedMessage = this.decodeHexMessage(broadcastResult.message);
          const decodedCode = this.decodeHexMessage(broadcastResult.code);
          const errorMessage =
            decodedMessage || decodedCode || 'Broadcast failed';

          this.logger.error('HTTP transaction broadcast failed', {
            ok: broadcastResponse.ok,
            result: broadcastResult.result,
            code: broadcastResult.code,
            decodedCode,
            message: broadcastResult.message,
            decodedMessage,
          });

          // Check for insufficient balance/energy/bandwidth errors
          const errorStr = String(errorMessage).toLowerCase();
          if (
            errorStr.includes('insufficient') ||
            errorStr.includes('balance') ||
            errorStr.includes('energy') ||
            errorStr.includes('bandwidth') ||
            errorStr.includes('not enough')
          ) {
            throw new Error(
              `Insufficient TRX resources: ${errorMessage}. Please ensure you have enough TRX for both the transfer amount and network fees (energy/bandwidth costs, typically 1-5 TRX).`,
            );
          }

          throw new Error(`Failed to broadcast transaction: ${errorMessage}`);
        }

        if (!broadcastResult.txid) {
          throw new Error(
            'Transaction broadcast succeeded but no txid returned',
          );
        }

        return broadcastResult.txid;
      }, 'executeHttpTransaction');
    } catch (error) {
      this.logger.error(`Failed to execute HTTP transaction: ${error.message}`);
      throw new Error(`Failed to execute transaction: ${error.message}`);
    }
  }

  private async waitForTronConfirmation(
    chainId: number | string,
    txHash: string,
    confirmations: number,
  ): Promise<any> {
    // Tron block time is ~3 seconds
    // For 20 confirmations, we need to wait ~60 seconds after transaction is mined
    // Total timeout: 3 minutes for initial mining + 2 minutes for confirmations = 5 minutes
    const maxAttempts = 100; // 100 attempts with 3-second intervals = 5 minutes
    let attempts = 0;
    let txBlockNumber: number | undefined;
    let txInfo: any;

    this.logger.log(`Waiting for Tron transaction confirmation`, {
      txHash,
      requiredConfirmations: confirmations,
      estimatedTime: `${confirmations * 3}s`,
    });

    while (attempts < maxAttempts) {
      try {
        if (this.tronWeb) {
          // Use TronWeb for transaction info with fallback
          txInfo = await this.executeWithFallback(async (rpcUrl) => {
            const tronWebInstance = new TronWeb({
              fullHost: rpcUrl,
              headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
            });

            return await tronWebInstance.trx.getTransactionInfo(txHash);
          }, 'waitForTronConfirmation (TronWeb)');

          if (txInfo && txInfo.blockNumber && txInfo.blockNumber > 0) {
            // Transaction is in a block - now check confirmations
            if (!txBlockNumber) {
              txBlockNumber = txInfo.blockNumber;
              this.logger.log(
                `Tron transaction mined in block ${txBlockNumber}, waiting for ${confirmations} confirmations...`,
              );
            }

            // Get current block number to calculate confirmations
            const currentBlockInfo = await this.executeWithFallback(
              async (rpcUrl) => {
                const tronWebInstance = new TronWeb({
                  fullHost: rpcUrl,
                  headers: {
                    'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '',
                  },
                });
                return await tronWebInstance.trx.getCurrentBlock();
              },
              'getCurrentBlock (TronWeb)',
            );

            const currentBlockNumber =
              currentBlockInfo?.block_header?.raw_data?.number;
            if (currentBlockNumber && txBlockNumber) {
              const blocksConfirmed = currentBlockNumber - txBlockNumber;

              this.logger.debug(
                `Tron confirmation progress: ${blocksConfirmed}/${confirmations} blocks`,
              );

              if (blocksConfirmed >= confirmations) {
                // Check transaction status
                this.logger.debug(
                  `TronWeb receipt status check for tx ${txHash}`,
                  {
                    hasReceipt: !!txInfo.receipt,
                    receiptResult: txInfo.receipt?.result,
                    receiptKeys: txInfo.receipt
                      ? Object.keys(txInfo.receipt)
                      : [],
                    txInfoKeys: Object.keys(txInfo),
                  },
                );

                const hasError =
                  txInfo.receipt?.result && txInfo.receipt.result !== 'SUCCESS';

                if (hasError) {
                  this.logger.warn(
                    `Transaction ${txHash} reverted with smart contract error: ${txInfo.receipt.result}`,
                  );
                  // For Symbiosis swaps, a REVERT means the transaction executed correctly but swap failed
                  // This is different from OUT_OF_ENERGY which is a technical failure
                  if (txInfo.receipt.result === 'REVERT') {
                    this.logger.log(
                      `Transaction ${txHash} executed successfully but swap was reverted by contract logic`,
                    );
                  }
                }
                this.logger.log(
                  `✅ Tron transaction confirmed with ${blocksConfirmed} confirmations`,
                );
                return {
                  blockNumber: txInfo.blockNumber,
                  blockHash: txInfo.id || '',
                  transactionHash: txHash,
                  status: hasError ? 'failed' : 'success',
                  gasUsed: txInfo.fee || 0,
                  confirmations: blocksConfirmed,
                };
              }
            }
          }
        } else {
          // Fallback to HTTP API with fallback
          const result = await this.executeWithFallback(async (rpcUrl) => {
            const response = await fetch(`${rpcUrl}/v1/transactions/${txHash}`);
            return await response.json();
          }, 'waitForTronConfirmation (HTTP)');

          if (result.data?.[0]) {
            const tx = result.data[0];

            if (tx.blockNumber && tx.blockNumber > 0) {
              if (!txBlockNumber) {
                txBlockNumber = tx.blockNumber;
                this.logger.log(
                  `Tron transaction mined in block ${txBlockNumber}, waiting for ${confirmations} confirmations...`,
                );
              }

              // Get current block for HTTP API
              const currentBlockResult = await this.executeWithFallback(
                async (rpcUrl) => {
                  const response = await fetch(`${rpcUrl}/wallet/getnowblock`, {
                    method: 'POST',
                  });
                  return await response.json();
                },
                'getCurrentBlock (HTTP)',
              );

              const currentBlockNumber =
                currentBlockResult?.block_header?.raw_data?.number;
              if (currentBlockNumber && txBlockNumber) {
                const blocksConfirmed = currentBlockNumber - txBlockNumber;

                this.logger.debug(
                  `Tron confirmation progress: ${blocksConfirmed}/${confirmations} blocks`,
                );

                if (blocksConfirmed >= confirmations) {
                  this.logger.log(
                    `✅ Tron transaction confirmed with ${blocksConfirmed} confirmations`,
                  );
                  return {
                    blockNumber: tx.blockNumber,
                    blockHash: tx.blockHash,
                    transactionHash: txHash,
                    status: tx.contractRet === 'SUCCESS' ? 'success' : 'failed',
                    gasUsed: tx.fee || 0,
                    confirmations: blocksConfirmed,
                  };
                }
              }
            }
          }
        }

        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
      } catch (error) {
        this.logger.warn(
          `Error checking transaction ${txHash}: ${error.message}`,
        );
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    throw new Error(
      `Transaction ${txHash} confirmation timeout after ${maxAttempts * 3} seconds`,
    );
  }

  private async getTronTransactionStatus(
    chainId: number | string,
    txHash: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }> {
    try {
      if (this.tronWeb) {
        // Use TronWeb for transaction info with fallback
        const txInfo = await this.executeWithFallback(async (rpcUrl) => {
          const tronWebInstance = new TronWeb({
            fullHost: rpcUrl,
            headers: { 'TRON-PRO-API-KEY': this.envConfig.tronApiKey || '' },
          });

          return await tronWebInstance.trx.getTransactionInfo(txHash);
        }, 'getTronTransactionStatus (TronWeb)');

        if (txInfo && txInfo.blockNumber && txInfo.blockNumber > 0) {
          // Tron transaction status:
          // - receipt.result is ONLY present for smart contract errors (OUT_OF_ENERGY, REVERT, etc.)
          // - For successful simple transfers, receipt.result is undefined
          // - If blockNumber exists and no error in receipt.result, transaction succeeded
          const hasError =
            txInfo.receipt?.result && txInfo.receipt.result !== 'SUCCESS';
          const status = hasError ? 'failed' : 'confirmed';
          return {
            status: status,
            receipt: {
              blockNumber: txInfo.blockNumber,
              blockHash: txInfo.id || '',
              transactionHash: txHash,
              status,
              gasUsed: txInfo.fee || 0,
            },
          };
        }

        return { status: 'pending' };
      } else {
        // Fallback to HTTP API with fallback
        const result = await this.executeWithFallback(async (rpcUrl) => {
          const response = await fetch(`${rpcUrl}/v1/transactions/${txHash}`);

          if (!response.ok) {
            return null;
          }

          return await response.json();
        }, 'getTronTransactionStatus (HTTP)');

        if (!result) {
          return { status: 'pending' };
        }

        const tx = result.data?.[0];
        if (!tx) {
          return { status: 'pending' };
        }

        if (tx.blockNumber && tx.blockNumber > 0) {
          const status = tx.contractRet === 'SUCCESS' ? 'confirmed' : 'failed';
          return {
            status: status,
            receipt: {
              blockNumber: tx.blockNumber,
              blockHash: tx.blockHash,
              transactionHash: txHash,
              status,
              gasUsed: tx.fee || 0,
            },
          };
        }

        return { status: 'pending' };
      }
    } catch (error) {
      this.logger.error(`Failed to get transaction status: ${error.message}`);
      return { status: 'pending' };
    }
  }

  // ==================== UTILITY HELPER METHODS ====================

  /**
   * Get address from private key using TronWeb
   */
  private getAddressFromPrivateKey(privateKey: string): string {
    if (this.tronWeb) {
      // Set the private key temporarily to get the address
      const bestUrl = this.getRpcUrlWithFallback('tron-mainnet');
      const tempTronWeb = new TronWeb({
        fullHost: bestUrl,
        privateKey: privateKey,
      });
      const address = tempTronWeb.defaultAddress.base58;
      if (!address) {
        throw new Error('Failed to derive address from private key');
      }
      return address;
    }

    // Fallback - requires proper private key to address conversion
    throw new Error(
      'Address derivation from private key requires TronWeb library',
    );
  }

  /**
   * Sign transaction using TronWeb
   */
  private async signTransaction(
    transaction: any,
    privateKey: string,
  ): Promise<any> {
    if (this.tronWeb) {
      return await this.tronWeb.trx.sign(transaction, privateKey);
    }

    // Fallback - requires proper transaction signing implementation
    throw new Error(
      'Transaction signing requires TronWeb library or custom implementation',
    );
  }

  /**
   * Enhanced address validation with TronWeb
   */
  private validateTronAddress(address: string): void {
    // Basic validation
    if (!address || !address.startsWith('T') || address.length !== 34) {
      throw new Error(`Invalid Tron address format: ${address}`);
    }

    // Additional validation with TronWeb if available
    if (this.tronWeb && TronWebUtils.address) {
      if (!TronWebUtils.address.isAddress(address)) {
        throw new Error(`Invalid Tron address: ${address}`);
      }
    }

    // Basic base58 character check
    const base58Regex =
      /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    if (!base58Regex.test(address)) {
      throw new Error(`Invalid base58 characters in address: ${address}`);
    }
  }
}
