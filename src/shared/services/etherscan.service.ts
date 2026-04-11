import { Injectable } from '@nestjs/common';
import { formatUnits, parseUnits } from 'viem';
import { CustomHttpService } from './http.service';
import { EnvironmentConfigService } from './environment-config.service';
import { WinstonLoggerService } from './winston-logger.service';

/**
 * Etherscan Gas Oracle API Response
 */
interface EtherscanGasOracleResponse {
  status: string;
  message: string;
  result: {
    LastBlock: string;
    SafeGasPrice: string;
    ProposeGasPrice: string;
    FastGasPrice: string;
    suggestBaseFee: string;
    gasUsedRatio: string;
  };
}

/**
 * Gas Oracle Data (all values in wei)
 */
export interface GasOracleData {
  safeGasPrice: string;
  proposeGasPrice: string;
  fastGasPrice: string;
  suggestBaseFee: string;
  lastBlock: string;
}

/**
 * Cached Gas Oracle Data with timestamp
 */
interface CachedGasOracleData {
  data: GasOracleData;
  timestamp: number;
}

/**
 * Etherscan Service
 * Provides gas price recommendations via Etherscan Gas Oracle API
 *
 * Features:
 * - Fetches gas price recommendations from Etherscan API
 * - Supports multiple EVM chains (Ethereum, BSC, Polygon, Arbitrum, etc.)
 * - Implements caching (30-60 second TTL) to reduce API calls
 * - Converts Gwei to wei for consistency
 * - Graceful error handling with fallback support
 */
@Injectable()
export class EtherscanService {
  private readonly logger: WinstonLoggerService;
  private readonly cache = new Map<number, CachedGasOracleData>();
  private readonly cacheTTL = 45000; // 45 seconds (between 30-60 seconds)

  /**
   * Etherscan-supported chain IDs
   * Based on: https://docs.etherscan.io/supported-chains
   */
  private readonly SUPPORTED_ETHERSCAN_CHAINS: number[] = [
    // Mainnets
    1, // Ethereum Mainnet
    56, // BNB Smart Chain Mainnet
    137, // Polygon Mainnet
    42161, // Arbitrum One Mainnet
    43114, // Avalanche C-Chain
    8453, // Base Mainnet
    10, // OP Mainnet
    100, // Gnosis
    250, // Fantom
    324, // zkSync Mainnet
    59144, // Linea Mainnet
    534352, // Scroll Mainnet
    42220, // Celo Mainnet
    204, // opBNB Mainnet
    5000, // Mantle Mainnet
    1329, // Sei Mainnet
    146, // Sonic Mainnet
    1923, // Swellchain Mainnet
    167000, // Taiko Mainnet
    130, // Unichain Mainnet
    480, // World Mainnet
    50, // XDC Mainnet
    // Testnets
    11155111, // Sepolia Testnet
    97, // BNB Smart Chain Testnet
    80002, // Polygon Amoy Testnet
    421614, // Arbitrum Sepolia Testnet
    43113, // Avalanche Fuji Testnet
    84532, // Base Sepolia Testnet
    11155420, // OP Sepolia Testnet
    59141, // Linea Sepolia Testnet
    534351, // Scroll Sepolia Testnet
    11142220, // Celo Sepolia Testnet
    5611, // opBNB Testnet
    5003, // Mantle Sepolia Testnet
    1328, // Sei Testnet
    14601, // Sonic Testnet
    1924, // Swellchain Testnet
    1301, // Unichain Sepolia Testnet
    4801, // World Sepolia Testnet
    51, // XDC Apothem Testnet
    17000, // Holesky Testnet
    560048, // Hoodi Testnet
  ];

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly envConfig: EnvironmentConfigService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(EtherscanService.name);
    // Log initialization status
    const apiKey = this.envConfig.etherscanApiKey;
    if (apiKey) {
      // Log partial key for verification (first 8 chars + ...)
      const maskedKey =
        apiKey.length > 8
          ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`
          : '***';
      this.logger.log(
        `EtherscanService initialized - API key configured (${maskedKey})`,
      );
    } else {
      this.logger.warn(
        'EtherscanService initialized - API key NOT configured (ETHERSCAN_API_KEY missing from .env)',
      );
    }
  }

  /**
   * Check if a chain is supported by Etherscan API
   */
  isChainSupported(chainId: number): boolean {
    return this.SUPPORTED_ETHERSCAN_CHAINS.includes(chainId);
  }

  /**
   * Check if Etherscan API key is configured
   */
  isApiKeyConfigured(): boolean {
    const apiKey = this.envConfig.etherscanApiKey;
    const isConfigured = !!apiKey;

    // Log for debugging (only once to avoid spam)
    if (!isConfigured && !this.hasLoggedApiKeyWarning) {
      this.logger.warn(
        'Etherscan API key not configured - ETHERSCAN_API_KEY environment variable is missing or empty',
      );
      this.hasLoggedApiKeyWarning = true;
    }

    return isConfigured;
  }

  private hasLoggedApiKeyWarning = false;

  /**
   * Check if Etherscan can be used for a given chain
   */
  canUseEtherscan(chainId: number): boolean {
    const isSupported = this.isChainSupported(chainId);
    const hasApiKey = this.isApiKeyConfigured();
    const canUse = isSupported && hasApiKey;

    // Log the check result for debugging
    if (!canUse) {
      this.logger.debug(
        `Etherscan check for chain ${chainId}: supported=${isSupported}, apiKeyConfigured=${hasApiKey}, canUse=${canUse}`,
      );
    }

    return canUse;
  }

  /**
   * Get gas oracle data from Etherscan API
   * Returns cached data if available and not expired
   *
   * @param chainId - Chain ID to query
   * @returns Gas oracle data (all values in wei) or null if unavailable
   */
  async getGasOracle(chainId: number): Promise<GasOracleData | null> {
    // Check if chain is supported
    if (!this.isChainSupported(chainId)) {
      this.logger.debug(`Chain ${chainId} is not supported by Etherscan API`);
      return null;
    }

    // Check if API key is configured
    if (!this.isApiKeyConfigured()) {
      this.logger.debug('Etherscan API key not configured, skipping API call');
      return null;
    }

    // Check cache first
    const cached = this.cache.get(chainId);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.logger.debug(`Using cached gas oracle data for chain ${chainId}`);
      return cached.data;
    }

    try {
      const apiKey = this.envConfig.etherscanApiKey;
      if (!apiKey) {
        this.logger.debug(
          `Etherscan API key not configured for chain ${chainId}`,
        );
        return null;
      }

      // Construct API v2 endpoint according to Etherscan documentation
      // Format: https://api.etherscan.io/v2/api?chainid={chainId}&module={module}&action={action}&apikey={apiKey}
      const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=gastracker&action=gasoracle&apikey=${apiKey}`;

      this.logger.debug(
        `Fetching gas oracle data from Etherscan API v2 for chain ${chainId}`,
        {
          url: url.replace(apiKey, '***'),
          chainId,
        },
      );

      const response = await this.httpService.get<EtherscanGasOracleResponse>(
        url,
        {
          timeout: 10000, // 10 second timeout
          retries: 2,
        },
      );

      // Validate response structure
      if (!response || typeof response !== 'object') {
        this.logger.warn(
          `Etherscan API returned invalid response structure for chain ${chainId}`,
          {
            response:
              typeof response === 'object'
                ? JSON.stringify(response).substring(0, 200)
                : String(response),
          },
        );
        return null;
      }

      // Handle error responses from Etherscan API
      if (response.status !== '1') {
        const errorMessage =
          (response as any).result || response.message || 'Unknown error';

        // Log specific error types
        if (
          errorMessage.includes('Max rate limit reached') ||
          errorMessage.includes('rate limit')
        ) {
          this.logger.warn(
            `Etherscan API rate limit exceeded for chain ${chainId}. Consider upgrading API plan or implementing rate limiting.`,
            {
              status: response.status,
              message: response.message,
              result: errorMessage,
            },
          );
        } else if (
          errorMessage.includes('Invalid API Key') ||
          errorMessage.includes('API Key')
        ) {
          this.logger.error(
            `Etherscan API key is invalid or not activated for chain ${chainId}. Please verify your API key.`,
            {
              status: response.status,
              message: response.message,
              result: errorMessage,
            },
          );
        } else {
          this.logger.warn(
            `Etherscan API returned error for chain ${chainId}`,
            {
              status: response.status,
              message: response.message,
              result: errorMessage,
            },
          );
        }
        return null;
      }

      // Validate message field
      if (
        response.message !== 'OK' &&
        response.message !==
          'OK-Missing/Invalid API Key, however you can try again without one'
      ) {
        this.logger.warn(
          `Etherscan API returned non-OK message for chain ${chainId}`,
          { status: response.status, message: response.message },
        );
        // Still try to parse if status is '1' and result exists
        if (!response.result) {
          return null;
        }
      }

      // Validate result structure
      if (!response.result || typeof response.result !== 'object') {
        this.logger.warn(
          `Etherscan API returned invalid result structure for chain ${chainId}`,
          { status: response.status, message: response.message },
        );
        return null;
      }

      // Validate required fields in result
      const requiredFields = [
        'SafeGasPrice',
        'ProposeGasPrice',
        'FastGasPrice',
        'suggestBaseFee',
        'LastBlock',
      ];
      const missingFields = requiredFields.filter(
        (field) => !response.result[field],
      );

      if (missingFields.length > 0) {
        this.logger.warn(
          `Etherscan API response missing required fields for chain ${chainId}`,
          { missingFields, availableFields: Object.keys(response.result) },
        );
        return null;
      }

      // Convert Gwei to wei using ethers parseUnits
      // Etherscan API returns gas prices in Gwei, we need to convert to wei
      try {
        const gasOracleData: GasOracleData = {
          safeGasPrice: parseUnits(
            response.result.SafeGasPrice,
            9, // 'gwei'
          ).toString(),
          proposeGasPrice: parseUnits(
            response.result.ProposeGasPrice,
            9, // 'gwei'
          ).toString(),
          fastGasPrice: parseUnits(
            response.result.FastGasPrice,
            9, // 'gwei'
          ).toString(),
          suggestBaseFee: parseUnits(
            response.result.suggestBaseFee,
            9, // 'gwei'
          ).toString(),
          lastBlock: response.result.LastBlock,
        };

        // Validate converted values are valid numbers
        if (
          gasOracleData.safeGasPrice === '0' ||
          gasOracleData.proposeGasPrice === '0' ||
          gasOracleData.fastGasPrice === '0'
        ) {
          this.logger.warn(
            `Etherscan API returned zero gas prices for chain ${chainId}, this may indicate an issue`,
            { gasOracleData },
          );
        }

        // Cache the result
        this.cache.set(chainId, {
          data: gasOracleData,
          timestamp: Date.now(),
        });

        this.logger.log(
          `Successfully fetched gas oracle data from Etherscan for chain ${chainId}`,
          {
            safeGasPrice: gasOracleData.safeGasPrice,
            proposeGasPrice: gasOracleData.proposeGasPrice,
            fastGasPrice: gasOracleData.fastGasPrice,
            suggestBaseFee: gasOracleData.suggestBaseFee,
          },
        );

        return gasOracleData;
      } catch (parseError) {
        this.logger.error(
          `Failed to parse Etherscan API response for chain ${chainId}`,
          { error: parseError.message, result: response.result },
        );
        return null;
      }
    } catch (error) {
      // Enhanced error handling with detailed logging
      const errorDetails: any = {
        chainId,
        errorMessage: error.message,
        errorName: error.name,
      };

      // Check for specific error types
      if (error.response) {
        // HTTP error response
        errorDetails.statusCode = error.response.status;
        errorDetails.statusText = error.response.statusText;
        errorDetails.responseData = error.response.data;

        this.logger.error(
          `Etherscan API HTTP error for chain ${chainId}`,
          errorDetails,
        );
      } else if (error.request) {
        // Request was made but no response received
        errorDetails.requestUrl = error.config?.url?.replace(/\?.*/, '?***');
        errorDetails.timeout = error.code === 'ECONNABORTED';

        this.logger.warn(
          `Etherscan API request failed (no response) for chain ${chainId}. This may indicate a network issue or timeout.`,
          errorDetails,
        );
      } else {
        // Error in setting up the request
        this.logger.error(
          `Etherscan API request setup error for chain ${chainId}`,
          errorDetails,
        );
      }

      // Don't throw - fail gracefully and let RPC fallback handle it
      return null;
    }
  }

  /**
   * Get recommended gas price based on priority tier
   *
   * @param chainId - Chain ID to query
   * @param priority - Gas price priority tier (default: 'propose')
   * @returns Recommended gas price in wei, or null if unavailable
   */
  async getRecommendedGasPrice(
    chainId: number,
    priority: 'safe' | 'propose' | 'fast' = 'propose',
  ): Promise<string | null> {
    const gasOracleData = await this.getGasOracle(chainId);

    if (!gasOracleData) {
      return null;
    }

    switch (priority) {
      case 'safe':
        return gasOracleData.safeGasPrice;
      case 'propose':
        return gasOracleData.proposeGasPrice;
      case 'fast':
        return gasOracleData.fastGasPrice;
      default:
        return gasOracleData.proposeGasPrice;
    }
  }

  /**
   * Get EIP-1559 fee data from Etherscan gas oracle
   * Calculates maxFeePerGas and maxPriorityFeePerGas from base fee and selected gas price tier
   *
   * @param chainId - Chain ID to query
   * @param priority - Gas price priority tier (default: 'propose')
   * @returns EIP-1559 fee data or null if unavailable
   */
  async getEIP1559Fees(
    chainId: number,
    priority: 'safe' | 'propose' | 'fast' = 'propose',
  ): Promise<{ maxFeePerGas: string; maxPriorityFeePerGas: string } | null> {
    const gasOracleData = await this.getGasOracle(chainId);

    if (!gasOracleData) {
      return null;
    }

    // Get selected gas price tier
    const selectedGasPrice = await this.getRecommendedGasPrice(
      chainId,
      priority,
    );
    if (!selectedGasPrice) {
      return null;
    }

    const baseFee = BigInt(gasOracleData.suggestBaseFee);
    const gasPrice = BigInt(selectedGasPrice);

    // Log raw Etherscan oracle data
    this.logger.log(
      `[Gas Price Data] Etherscan Gas Oracle raw values for chain ${chainId}:`,
      {
        safeGasPrice: gasOracleData.safeGasPrice,
        safeGasPriceGwei:
          formatUnits(BigInt(gasOracleData.safeGasPrice), 9) + ' gwei',
        proposeGasPrice: gasOracleData.proposeGasPrice,
        proposeGasPriceGwei:
          formatUnits(BigInt(gasOracleData.proposeGasPrice), 9) + ' gwei',
        fastGasPrice: gasOracleData.fastGasPrice,
        fastGasPriceGwei:
          formatUnits(BigInt(gasOracleData.fastGasPrice), 9) + ' gwei',
        suggestBaseFee: gasOracleData.suggestBaseFee,
        suggestBaseFeeGwei: formatUnits(baseFee, 9) + ' gwei',
        selectedTier: priority,
        selectedGasPrice: selectedGasPrice,
        selectedGasPriceGwei: formatUnits(gasPrice, 9) + ' gwei',
        source: 'etherscan',
      },
    );

    // Calculate priority fee: difference between selected gas price and base fee
    // This is Etherscan's suggested priority fee based on recent transactions
    const calculatedPriorityFee =
      gasPrice > baseFee ? gasPrice - baseFee : BigInt('1000000000'); // 1 gwei default

    // Apply chain-specific minimums only as safety fallback
    // Polygon requires minimum 25 gwei, other chains 1 gwei
    const minPriorityFee =
      chainId === 137
        ? BigInt('25000000000') // 25 gwei for Polygon (network requirement)
        : BigInt('1000000000'); // 1 gwei for other chains

    // Use Etherscan's suggestion if it's above minimum, otherwise use minimum
    const maxPriorityFeePerGas =
      calculatedPriorityFee > minPriorityFee
        ? calculatedPriorityFee
        : minPriorityFee;

    this.logger.log(
      `[Gas Price Calculation] Etherscan priority fee analysis for chain ${chainId}:`,
      {
        calculatedPriorityFee: calculatedPriorityFee.toString(),
        calculatedPriorityFeeGwei:
          formatUnits(calculatedPriorityFee, 9) + ' gwei',
        minPriorityFee: minPriorityFee.toString(),
        minPriorityFeeGwei: formatUnits(minPriorityFee, 9) + ' gwei',
        finalPriorityFee: maxPriorityFeePerGas.toString(),
        finalPriorityFeeGwei: formatUnits(maxPriorityFeePerGas, 9) + ' gwei',
        usingProviderValue: calculatedPriorityFee > minPriorityFee,
        reason:
          calculatedPriorityFee > minPriorityFee
            ? 'Etherscan suggestion above minimum'
            : 'Using minimum (Etherscan value too low)',
      },
    );

    // Max fee per gas: base fee * 2 + priority fee (conservative approach)
    // This ensures transaction will be included even if base fee increases
    const maxFeePerGas = baseFee * BigInt(2) + maxPriorityFeePerGas;

    return {
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }

  /**
   * Clear cache for a specific chain or all chains
   */
  clearCache(chainId?: number): void {
    if (chainId !== undefined) {
      this.cache.delete(chainId);
      this.logger.debug(`Cleared cache for chain ${chainId}`);
    } else {
      this.cache.clear();
      this.logger.debug('Cleared all gas oracle cache');
    }
  }
}
