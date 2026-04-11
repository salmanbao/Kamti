/**
 * Common response interfaces for aggregator services
 * Shared types between 0x Protocol and Odos aggregators
 */

import { AggregatorType, ApprovalStrategy } from './swap-request.model';

// Common error interface for both providers
export interface ApiErrorDetail {
  loc?: (string | number)[];
  msg: string;
  type: string;
}

export interface ApiErrorResponse {
  detail: ApiErrorDetail[];
}

// Base interfaces used by both aggregators
export interface BaseSwapRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  recipient?: string;
  slippagePercentage?: number;
  deadline?: number;
  aggregator?: AggregatorType; // Fixed: Use enum instead of string
  approvalStrategy?: ApprovalStrategy; // Fixed: Use enum instead of string
}

// Common transaction structure
export interface TransactionData {
  to: string;
  data: string;
  value: string;
  gas?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

// EIP-712 structure for permit2 and gasless approvals
export interface EIP712Data {
  types: Record<string, any>;
  domain: Record<string, any>;
  message: Record<string, any>;
  primaryType: string;
}

export interface Permit2Data {
  type: string;
  hash: string;
  eip712: EIP712Data;
}

// Route and fill information (0x specific)
export interface RouteFill {
  source: string;
  proportionBps: number;
}

export interface RouteInfo {
  fills: RouteFill[];
  tokens: string[];
}

// Token interfaces
export interface ZeroXTokenInfo {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

export interface ZeroXTokenListResponse {
  records: ZeroXTokenInfo[];
}
export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
}

// Fee structures
export interface FeeInfo {
  amount: string;
  token: string;
  type: string;
}

export interface FeesStructure {
  integratorFee?: FeeInfo | null;
  zeroExFee?: FeeInfo | null;
  gasFee?: FeeInfo | null;
}

// Issues/validation structure (0x specific)
export interface ValidationIssues {
  allowance?: Record<string, any>;
  balance?: Record<string, any>;
  simulationIncomplete?: boolean;
  invalidSourcesPassed?: string[];
}

// For issues field in 0x response - can be both object and array
export type ZeroXIssues = ValidationIssues | string[];

// Odos-specific response structures
export interface OdosQuoteResponse {
  deprecated?: string;
  traceId?: string;
  inTokens: string[];
  outTokens: string[];
  inAmounts: string[];
  outAmounts: string[];
  gasEstimate: number;
  dataGasEstimate: number;
  gweiPerGas: number;
  gasEstimateValue: number;
  inValues: number[];
  outValues: number[];
  netOutValue: number;
  priceImpact: number;
  percentDiff: number;
  permit2Message?: Record<string, any>;
  permit2Hash?: string;
  partnerFeePercent: number;
  pathId: string;
  pathViz?: Record<string, any>;
  pathVizImage?: string;
  blockNumber: number;
}

export interface OdosAssembleResponse {
  transaction: TransactionData;
  simulation?: {
    gasUsed: number;
    success: boolean;
    error?: string;
  };
}

// 0x-specific response structures
export interface ZeroXQuoteResponse {
  allowanceTarget: string;
  blockNumber: string;
  buyAmount: string;
  buyToken: string;
  sellAmount: string;
  sellToken: string;
  minBuyAmount: string;

  // Transaction data
  transaction: TransactionData;

  // Optional fields
  gas?: string;
  gasPrice?: string;
  estimatedGas?: string;
  priceImpact?: string;
  liquidityAvailable?: boolean;

  // Strategy-specific data
  permit2?: Permit2Data;

  // Additional metadata
  fees?: FeesStructure;
  issues?: ZeroXIssues;
  route?: RouteInfo;
  tokenMetadata?: {
    buyToken: TokenMetadata;
    sellToken: TokenMetadata;
  };
  totalNetworkFee?: string;
  zid?: string;
}

// Generic swap quote response that normalizes both 0x and Odos
export interface GenericSwapQuote {
  // Core swap data (present in both)
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;

  // Transaction execution data
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice?: string;

  // Provider identification
  aggregator: AggregatorType; // Fixed: Use enum instead of string

  // Optional common fields
  allowanceTarget?: string;
  priceImpact?: string;
  estimatedGas?: string;
  blockNumber?: string | number;

  // Strategy-specific data (0x only)
  permit2?: Permit2Data;
  approvalStrategy?: string;

  // Provider-specific raw data for advanced use cases
  rawResponse?: OdosQuoteResponse | ZeroXQuoteResponse;
}

// Union type for raw API responses
export type AggregatorRawResponse = OdosQuoteResponse | ZeroXQuoteResponse;

// Type guards to determine response type
export function isOdosResponse(response: any): response is OdosQuoteResponse {
  return (
    response &&
    typeof response.pathId === 'string' &&
    Array.isArray(response.outAmounts)
  );
}

export function isZeroXResponse(response: any): response is ZeroXQuoteResponse {
  return (
    response &&
    typeof response.allowanceTarget === 'string' &&
    response.transaction
  );
}

// Error type guard
export function isApiErrorResponse(
  response: any,
): response is ApiErrorResponse {
  return (
    response && Array.isArray(response.detail) && response.detail.length > 0
  );
}

// Response transformer utility types
export interface ResponseTransformer<T = AggregatorRawResponse> {
  transformToGeneric(response: T, request: BaseSwapRequest): GenericSwapQuote;
  validateResponse(response: any): response is T;
}

// Common validation result
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Provider health check response
export interface ProviderHealthResponse {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheck: Date;
  errorRate?: number;
  supportedChains?: number[];
}

// Configuration for different providers
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  timeout?: number;
  retries?: number;
  rateLimit?: {
    requests: number;
    perSeconds: number;
  };
}

// Generic price response (for price endpoints without transaction data)
export interface GenericPriceQuote {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  priceImpact?: string;
  aggregator: AggregatorType; // Fixed: Use enum instead of string
  gasEstimate?: string;
  allowanceTarget?: string;
  blockNumber?: string | number;
}

// Response metadata for tracking and debugging
export interface ResponseMetadata {
  provider: string;
  timestamp: Date;
  requestId?: string;
  processingTime?: number;
  cacheHit?: boolean;
}

export { ApprovalStrategy } from '@swap/models/swap-request.model';
