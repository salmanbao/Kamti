import { Injectable } from '@nestjs/common';
import { CustomHttpService } from './http.service';
import { EnvironmentConfigService } from './environment-config.service';
import { WinstonLoggerService } from './winston-logger.service';

type NodeRealEndpointConfig =
  | { type: 'direct'; subdomain: string }
  | { type: 'open'; path: string };

/**
 * NodeReal JSON-RPC Response for eth_gasPrice
 */
interface NodeRealGasPriceResponse {
  jsonrpc: string;
  id: number;
  result?: string; // Hex string (e.g., "0x4a817c800")
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Cached Gas Price Data with timestamp
 */
interface CachedGasPriceData {
  gasPrice: string;
  timestamp: number;
}

/**
 * NodeReal Service
 * Provides gas price fetching via NodeReal's eth_gasPrice JSON-RPC API
 *
 * Features:
 * - Fetches current gas price from NodeReal RPC endpoints
 * - Supports multiple EVM chains (Ethereum, BSC, Polygon, Arbitrum, etc.)
 * - Implements caching (45 second TTL) to reduce API calls
 * - Converts hex gas price to decimal string (wei)
 * - Graceful error handling with fallback support
 */
@Injectable()
export class NodeRealService {
  private readonly logger: WinstonLoggerService;
  private readonly cache = new Map<number, CachedGasPriceData>();
  private readonly cacheTTL = 45000; // 45 seconds (same as Etherscan)

  /**
   * NodeReal endpoint configuration.
   * Some chains expose dedicated subdomains (<chain>.nodereal.io/v1/<API_KEY>),
   * while others must be accessed via the "open-platform" format:
   *   https://open-platform.nodereal.io/<API_KEY>/<path>
   */
  private readonly CHAIN_ENDPOINTS: Record<number, NodeRealEndpointConfig> = {
    // Direct v1 endpoints
    1: { type: 'direct', subdomain: 'eth-mainnet' },
    56: { type: 'direct', subdomain: 'bsc-mainnet' },
    137: { type: 'direct', subdomain: 'polygon-mainnet' },
    10: { type: 'direct', subdomain: 'opt-mainnet' },
    204: { type: 'direct', subdomain: 'opbnb-mainnet' },
    100: { type: 'direct', subdomain: 'gnosis-mainnet' },
    250: { type: 'direct', subdomain: 'fantom-mainnet' },
    324: { type: 'direct', subdomain: 'zksync-mainnet' },
    59144: { type: 'direct', subdomain: 'linea-mainnet' },
    534352: { type: 'direct', subdomain: 'scroll-mainnet' },
    42220: { type: 'direct', subdomain: 'celo-mainnet' },
    5000: { type: 'direct', subdomain: 'mantle-mainnet' },
    11155111: { type: 'direct', subdomain: 'eth-sepolia' },
    97: { type: 'direct', subdomain: 'bsc-testnet' },
    80002: { type: 'direct', subdomain: 'polygon-amoy' },
    43113: { type: 'direct', subdomain: 'avalanche-fuji' },
    84532: { type: 'direct', subdomain: 'base-sepolia' },
    11155420: { type: 'direct', subdomain: 'op-sepolia' },
    59141: { type: 'direct', subdomain: 'linea-sepolia' },
    534351: { type: 'direct', subdomain: 'scroll-sepolia' },

    // Open-platform endpoints (format type 2)
    42161: { type: 'open', path: 'arbitrum-nitro/' },
    43114: { type: 'open', path: 'avalanche-c/ext/bc/C/rpc' },
    8453: { type: 'open', path: 'base' },
    195: { type: 'open', path: 'tron' }, // Tron mainnet
  };

  /**
   * Supported chain IDs (for quick lookup)
   */
  private readonly SUPPORTED_CHAINS: number[] = Object.keys(
    this.CHAIN_ENDPOINTS,
  ).map(Number);

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly envConfig: EnvironmentConfigService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(NodeRealService.name);
    // Log initialization status
    const apiKey = this.envConfig.noderealApiKey;
    if (apiKey) {
      // Log partial key for verification (first 8 chars + ...)
      const maskedKey =
        apiKey.length > 8
          ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`
          : '***';
      this.logger.log(
        `NodeRealService initialized - API key configured (${maskedKey})`,
      );
    } else {
      this.logger.warn(
        'NodeRealService initialized - API key NOT configured (NODEREAL_API_KEY missing from .env)',
      );
    }
  }

  /**
   * Check if a chain is supported by NodeReal API
   */
  isChainSupported(chainId: number): boolean {
    return this.SUPPORTED_CHAINS.includes(chainId);
  }

  /**
   * Check if NodeReal API key is configured
   */
  isApiKeyConfigured(): boolean {
    const apiKey = this.envConfig.noderealApiKey;
    const isConfigured = !!apiKey;

    // Log for debugging (only once to avoid spam)
    if (!isConfigured && !this.hasLoggedApiKeyWarning) {
      this.logger.warn(
        'NodeReal API key not configured - NODEREAL_API_KEY environment variable is missing or empty',
      );
      this.hasLoggedApiKeyWarning = true;
    }

    return isConfigured;
  }

  private hasLoggedApiKeyWarning = false;

  /**
   * Check if NodeReal can be used for a given chain
   */
  canUseNodeReal(chainId: number): boolean {
    const isSupported = this.isChainSupported(chainId);
    const hasApiKey = this.isApiKeyConfigured();
    const canUse = isSupported && hasApiKey;

    // Log the check result for debugging
    if (!canUse) {
      this.logger.debug(
        `NodeReal check for chain ${chainId}: supported=${isSupported}, apiKeyConfigured=${hasApiKey}, canUse=${canUse}`,
      );
    }

    return canUse;
  }

  /**
   * Get gas price from NodeReal API
   * Returns cached data if available and not expired
   *
   * @param chainId - Chain ID to query
   * @returns Gas price in wei (as decimal string) or null if unavailable
   */
  async getGasPrice(chainId: number): Promise<string | null> {
    // Check if chain is supported
    if (!this.isChainSupported(chainId)) {
      this.logger.debug(`Chain ${chainId} is not supported by NodeReal API`);
      return null;
    }

    // Check if API key is configured
    if (!this.isApiKeyConfigured()) {
      this.logger.debug('NodeReal API key not configured, skipping API call');
      return null;
    }

    // Check cache first
    const cached = this.cache.get(chainId);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.logger.debug(`Using cached gas price data for chain ${chainId}`);
      return cached.gasPrice;
    }

    try {
      const apiKey = this.envConfig.noderealApiKey;
      if (!apiKey) {
        this.logger.debug(
          `NodeReal API key not configured for chain ${chainId}`,
        );
        return null;
      }

      const url = this.buildEndpointUrl(chainId, apiKey);
      if (!url) {
        this.logger.debug(
          `No NodeReal endpoint configuration found for chain ${chainId}`,
        );
        return null;
      }

      // Prepare JSON-RPC request
      const requestBody = {
        jsonrpc: '2.0',
        method: 'eth_gasPrice',
        params: [],
        id: 1,
      };

      this.logger.debug(
        `Fetching gas price from NodeReal API for chain ${chainId}`,
        {
          url: url.replace(apiKey, '***'),
          chainId,
        },
      );

      const response = await this.httpService.post<NodeRealGasPriceResponse>(
        url,
        requestBody,
        {
          timeout: 10000, // 10 second timeout
          retries: 2,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      // Validate response structure
      if (!response || typeof response !== 'object') {
        this.logger.warn(
          `NodeReal API returned invalid response structure for chain ${chainId}`,
          {
            response:
              typeof response === 'object'
                ? JSON.stringify(response).substring(0, 200)
                : String(response),
          },
        );
        return null;
      }

      // Handle error responses
      if (response.error) {
        this.logger.warn(`NodeReal API returned error for chain ${chainId}`, {
          error: response.error,
        });
        return null;
      }

      // Validate result exists
      if (!response.result) {
        this.logger.warn(
          `NodeReal API returned no result for chain ${chainId}`,
          { response },
        );
        return null;
      }

      // Convert hex string to decimal string (wei)
      try {
        // Remove '0x' prefix if present and convert to BigInt
        const hexValue = response.result.startsWith('0x')
          ? response.result.slice(2)
          : response.result;
        const gasPriceBigInt = BigInt('0x' + hexValue);
        const gasPrice = gasPriceBigInt.toString();

        // Validate gas price is not zero
        if (gasPrice === '0' || gasPriceBigInt === 0n) {
          this.logger.warn(
            `NodeReal API returned zero gas price for chain ${chainId}, this may indicate an issue`,
            { hexValue: response.result, gasPrice },
          );
          return null;
        }

        // Cache the result
        this.cache.set(chainId, {
          gasPrice,
          timestamp: Date.now(),
        });

        this.logger.log(
          `Successfully fetched gas price from NodeReal for chain ${chainId}`,
          {
            gasPrice,
            hexValue: response.result,
          },
        );

        return gasPrice;
      } catch (parseError) {
        this.logger.error(
          `Failed to parse NodeReal API response for chain ${chainId}`,
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
          `NodeReal API HTTP error for chain ${chainId}`,
          errorDetails,
        );
      } else if (error.request) {
        // Request was made but no response received
        errorDetails.requestUrl = error.config?.url?.replace(/\?.*/, '?***');
        errorDetails.timeout = error.code === 'ECONNABORTED';

        this.logger.warn(
          `NodeReal API request failed (no response) for chain ${chainId}. This may indicate a network issue or timeout.`,
          errorDetails,
        );
      } else {
        // Error in setting up the request
        this.logger.error(
          `NodeReal API request setup error for chain ${chainId}`,
          errorDetails,
        );
      }

      // Don't throw - fail gracefully and let RPC fallback handle it
      return null;
    }
  }

  private buildEndpointUrl(chainId: number, apiKey: string): string | null {
    const endpoint = this.CHAIN_ENDPOINTS[chainId];
    if (!endpoint) {
      return null;
    }

    if (endpoint.type === 'direct') {
      return `https://${endpoint.subdomain}.nodereal.io/v1/${apiKey}`;
    }

    const normalizedPath = endpoint.path.replace(/^\/+/, '');
    return `https://open-platform.nodereal.io/${apiKey}/${normalizedPath}`;
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
      this.logger.debug('Cleared all gas price cache');
    }
  }
}
