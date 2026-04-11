/**
 * Provider Ports (Interfaces) for Swap Aggregation
 *
 * These stable interfaces decouple provider code from business logic
 * and make adding new adapters trivial.
 */

import { ApprovalStrategy, AggregatorType } from './swap-request.model';

/**
 * Base swap quote interface aligned with existing SwapQuote
 */
export interface SwapQuote {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  gas: string;
  gasPrice?: string;
  to: string;
  data: string;
  value: string;
  allowanceTarget?: string;
  aggregator: AggregatorType; // Fixed: Use enum instead of string for consistency
  priceImpact?: string;
  estimatedGas?: string;
  approvalStrategy?: ApprovalStrategy;
  // EIP-1559 gas fields for improved gas handling
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  // Timestamp for quote expiry validation
  timestamp?: number;
  // Provider supplied expiry in milliseconds (if available)
  timeoutMs?: number;
  // Absolute expiry timestamp in ms since epoch
  expiresAt?: number;
  // Liquidity validation fields (0x specific)
  liquidityAvailable?: boolean;
  issues?: any; // Can be array or object format
}

/**
 * Base swap request interface aligned with existing SwapRequest
 */
export interface SwapRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  recipient?: string;
  slippagePercentage?: number;
  deadline?: number;
  aggregator?: AggregatorType; // Fixed: Use enum instead of string for consistency
  approvalStrategy?: ApprovalStrategy;
}

/**
 * Cross-chain route request for meta-aggregators
 */
export interface RouteRequest {
  fromChainId: number;
  toChainId: number;
  fromToken: string; // Token address
  toToken: string; // Token address
  fromTokenSymbol?: string; // Optional: Token symbol for efficient config lookup
  toTokenSymbol?: string; // Optional: Token symbol for efficient config lookup
  amount: string;
  slippageBps: number;
  userAddress?: string;
  recipient?: string;
  referrer?: string;
}

/**
 * Individual step in a cross-chain route
 */
export type Step = {
  kind: 'swap' | 'bridge' | 'native';
  chainId: number | string; // Support both numeric EVM chain IDs and string chain IDs (e.g., 'solana-mainnet', 'bitcoin-mainnet')
  details: any;
  protocol?: string;
  estimatedTime?: number;
};

/**
 * Cross-chain route quote response
 */
export interface RouteQuote {
  steps: Step[];
  totalEstimatedOut: string;
  fees: {
    gas: string;
    provider: string;
    bridge?: string;
    app?: string;
    // Enhanced fee details
    gasCostWei?: string; // Total gas cost in wei (gasLimit × gasPrice)
    gasPrice?: string; // Gas price per unit
    maxFeePerGas?: string; // EIP-1559 max fee per gas
    maxPriorityFeePerGas?: string; // EIP-1559 priority fee
    percentFeePercent?: number; // Percentage fee (if applicable)
    percentFeeToken?: string; // Token for percentage fee
  };
  etaSeconds?: number;
  providerRef?: Record<string, any>;
  routeId?: string;
  quotedAt?: number;
  expiresAt?: number;
  timeoutMs?: number;
  priceImpact?: string;
  confidence?: number;
  minOutputAmount?: string; // Minimum output amount (for slippage protection)
}

/**
 * Transaction build result
 */
export interface TransactionBuild {
  to: string;
  data: string;
  value: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

/**
 * Execution status for cross-chain operations
 */
export type ExecutionStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'PARTIAL';

/**
 * Port for on-chain aggregators (0x, Odos, etc.)
 */
export interface IOnchainAggregator extends IProvider {
  /**
   * Get a swap quote for same-chain swaps
   * @param req - The swap request
   * @param strictValidation - Whether to use strict validation (default: true)
   *                          Set to false for quote comparison to relax validations
   */
  getQuote(req: SwapRequest, strictValidation?: boolean): Promise<SwapQuote>;

  /**
   * Build transaction data for execution
   */
  buildTx(req: SwapRequest): Promise<TransactionBuild>;

  /**
   * Check if provider supports the given chain
   */
  supportsChain(chainId: number): boolean;

  /**
   * Get all supported chains dynamically from the aggregator's API
   */
  getSupportedChains(): Promise<number[]>;
}

/**
 * Port for meta-aggregators (Symbiosis, Rubic, etc.)
 */
export interface IMetaAggregator extends IProvider {
  /**
   * Get available cross-chain routes
   */
  getRoutes(req: RouteRequest): Promise<RouteQuote[]>;

  /**
   * Execute a specific route
   */
  execute(routeId: string, signerCtx: any): Promise<{ txids: string[] }>;

  /**
   * Check execution status
   */
  status(txHash: string): Promise<ExecutionStatus>;

  /**
   * Get supported chain pairs
   */
  getSupportedChains(): { from: number[]; to: number[] };

  /**
   * Check if provider supports a specific chain for on-chain or cross-chain swaps
   * This allows meta-aggregators to be used as primary providers for on-chain EVM swaps
   */
  supportsChain(chainId: number): boolean;
}

/**
 * Solana-specific quote request
 */
export interface SolanaQuoteRequest {
  fromMint: string;
  toMint: string;
  amount: string;
  slippageBps: number;
  userPublicKey?: string;
  platformFeeBps?: number;
}

/**
 * Solana transaction result
 */
export interface SolanaTransactionResult {
  rawTx: string;
  txid?: string;
  instructions?: any[];
}

/**
 * Port for Solana routers (Jupiter, etc.)
 */
export interface ISolanaRouter extends IProvider {
  /**
   * Get swap quote for Solana tokens
   */
  quote(req: SolanaQuoteRequest): Promise<RouteQuote>;

  /**
   * Build and optionally sign transaction
   */
  buildAndSign(
    quoteResponse: any,
    userKeypair?: any,
  ): Promise<SolanaTransactionResult>;

  /**
   * Check if token pair is supported
   */
  supportsTokenPair(fromMint: string, toMint: string): Promise<boolean>;
}

/**
 * Native L1 quote request (Bitcoin, etc.)
 */
export interface NativeQuoteRequest {
  fromChainId?: number | string; // Source chain (numeric for EVM, string for native L1 like "bitcoin-mainnet")
  fromToken?: string; // Source token address
  toChainId: number | string; // Destination chain (numeric for EVM, string for native L1)
  toToken: string; // Destination token address
  amountSats: string; // Amount in smallest unit (satoshis for BTC, wei for ETH, etc.)
  amount?: string; // Alternative amount field for compatibility
  userAddress?: string; // User's address on destination chain
  memo?: string; // Optional memo/note for the transaction
}

/**
 * Port for native L1 routers (THORChain, Maya, etc.)
 */
export interface INativeRouter extends IProvider {
  /**
   * Get quote for Bitcoin to other chains
   */
  quoteBtc(req: NativeQuoteRequest): Promise<RouteQuote>;

  /**
   * Deposit and track cross-chain transaction
   */
  depositAndTrack(depositTx: string, memo: string): Promise<ExecutionStatus>;

  /**
   * Get supported destination chains
   */
  getSupportedDestinations(): number[];
}

/**
 * Generic provider configuration
 */
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  rateLimit?: {
    requests: number;
    perSeconds: number;
  };
  timeout?: number;
  retries?: number;
}

/**
 * Provider health status
 */
export interface ProviderHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheck: Date;
  errorRate?: number;
  // Extended metrics (optional)
  successRate?: number;
  totalRequests?: number;
  successes?: number;
  failures?: number;
  p50Latency?: number;
  p95Latency?: number;
  lastError?: string;
}

/**
 * Universal provider interface for health monitoring
 */
export interface IProvider {
  getProviderName(): string;
  healthCheck(): Promise<ProviderHealth>;
  getConfig(): ProviderConfig;
}
