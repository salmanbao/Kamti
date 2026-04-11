/**
 * Models for swap operations
 */

/**
 * Approval strategy types for 0x Protocol v2
 */
export enum ApprovalStrategy {
  ALLOWANCE_HOLDER = 'allowance-holder', // Single signature approval
}

export interface SwapRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  recipient?: string;
  slippagePercentage?: number;
  deadline?: number;
  aggregator?: AggregatorType;
  approvalStrategy?: ApprovalStrategy; // Optional strategy for 0x v2
}

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
  aggregator: AggregatorType;
  priceImpact?: string;
  estimatedGas?: string;
  approvalStrategy?: ApprovalStrategy; // Strategy used for this quote
  // EIP-1559 gas fields for improved gas handling
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  // Timestamp for quote expiry validation
  timestamp?: number;
  // Liquidity validation fields (0x specific)
  liquidityAvailable?: boolean;
  issues?: any; // Can be array or object format
  // Deposit info for CEX-based trades (ChangeNow, SimpleSwap, etc.)
  depositInfo?: {
    depositAddress: string;
    amountToSendDecimal: string;
    amountToSendAtomic: string;
    transferValue: string;
    exchangeId: string;
    extraFields?: any;
    destinationAddress?: string;
    raw?: any;
    providerType?: string;
    sourceBlockchain?: string;
    transferEcosystem?: 'evm' | 'solana' | 'bitcoin' | 'tron';
  };
}

export interface SwapTransaction {
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  gasPrice?: string;
  nonce?: number;
}

export interface SwapResult {
  transactionHash: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  gasUsed: string;
  gasPrice: string;
  aggregator: AggregatorType;
  timestamp: number;
}

export interface ApprovalRequest {
  tokenAddress: string;
  spender: string;
  amount: string;
  owner: string;
}

export interface ApprovalResult {
  transactionHash: string;
  tokenAddress: string;
  spender: string;
  amount: string;
  timestamp: number;
}

/**
 * Supported aggregator types for multi-protocol swapping
 *
 * EVM Aggregators:
 * - ZEROX: 0x Protocol v2 (AllowanceHolder + Permit2 strategies)
 * - ODOS: Odos efficient pathfinding
 *
 * Cross-Protocol:
 * - JUPITER: Jupiter (Solana ecosystem)
 */
export enum AggregatorType {
  // EVM On-chain Aggregators
  ZEROX = '0x', // 0x Protocol
  ODOS = 'odos', // Odos smart order routing

  // Meta Aggregators (Cross-chain capable)
  SOCKET = 'socket', // Socket cross-chain aggregator
  RANGO = 'rango', // Rango cross-chain aggregator
  ROUTER = 'router', // Router Protocol
  RUBIC = 'rubic', // Rubic cross-chain aggregator

  // Native L1 Routers (Bitcoin, Litecoin, etc.)
  THORCHAIN = 'thorchain', // THORChain native router
  MAYA = 'maya', // Maya Protocol native router

  // Solana Routers
  JUPITER = 'jupiter', // Jupiter aggregator for Solana
  ORCA = 'orca', // Orca DEX for Solana
}

export interface AggregatorConfig {
  name: AggregatorType;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  priority: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  isNative: boolean;
}

export interface BalanceInfo {
  tokenAddress: string;
  balance: string;
  formattedBalance: string;
  decimals: number;
  symbol: string;
}

export interface GasEstimate {
  gasLimit: string;
  gasPrice: string;
  estimatedCost: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
