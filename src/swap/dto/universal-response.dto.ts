import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SwapType, BlockchainEcosystem } from './universal-swap-request.dto';

/**
 * Response metadata with swap-specific information
 */
export class ResponseMetadata {
  @ApiProperty({
    description: 'Detected swap type',
    enum: SwapType,
    example: SwapType.ON_CHAIN,
  })
  swapType: SwapType;

  @ApiProperty({
    description: 'Provider category used',
    enum: ['evm-aggregators', 'meta', 'solana'],
    example: 'evm-aggregators',
  })
  providerCategory: string;

  @ApiProperty({
    description: 'Estimated completion time in seconds',
    example: 30,
  })
  estimatedTime: number;

  @ApiProperty({
    description: 'Operation complexity level',
    enum: ['simple', 'moderate', 'complex'],
    example: 'simple',
  })
  complexity: string;

  @ApiProperty({
    description: 'Request timestamp',
    format: 'date-time',
  })
  timestamp: string;

  @ApiPropertyOptional({
    description:
      'Execution ID for tracking (present for execute/status operations)',
    example: 'exec_1234567890',
  })
  executionId?: string;
}

/**
 * Universal Response Wrapper - Generic response format for all endpoints
 */
export class UniversalResponse<T> {
  @ApiProperty({
    description: 'Success status',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Response data',
  })
  data: T;

  @ApiProperty({
    description: 'Operation metadata',
  })
  metadata: ResponseMetadata;

  @ApiProperty({
    description: 'Warnings or important notes',
    type: 'array',
    items: { type: 'string' },
    required: false,
  })
  warnings?: string[];

  @ApiProperty({
    description: 'Error details (only present if success = false)',
    required: false,
  })
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Chain support status details
 */
export class ChainSupportStatus {
  @ApiProperty({ description: 'Source chain supported', example: true })
  sourceChainSupported: boolean;

  @ApiProperty({ description: 'Destination chain supported', example: true })
  destinationChainSupported: boolean;

  @ApiProperty({ description: 'Cross-chain route available', example: true })
  crossChainSupported: boolean;

  @ApiProperty({ description: 'Source chain details' })
  sourceChain: {
    chainId: number;
    ecosystem: BlockchainEcosystem;
    name: string;
    supported: boolean;
  };

  @ApiProperty({ description: 'Destination chain details' })
  destinationChain: {
    chainId: number;
    ecosystem: BlockchainEcosystem;
    name: string;
    supported: boolean;
  };
}

/**
 * Token support status details
 */
export class TokenSupportStatus {
  @ApiProperty({ description: 'Input token validation result' })
  inputToken: {
    symbol: string;
    supported: boolean;
    isApprovedInput: boolean;
    reason?: string;
  };

  @ApiProperty({ description: 'Output token validation result' })
  outputToken: {
    symbol: string;
    supported: boolean;
    availableOnChain: boolean;
    reason?: string;
  };

  @ApiProperty({ description: 'Token pair liquidity status' })
  liquidityStatus: {
    available: boolean;
    estimatedLiquidity?: string;
    providers?: string[];
  };
}

/**
 * Provider recommendation details
 */
export class ProviderRecommendation {
  @ApiProperty({ description: 'Recommended provider name', example: '0x' })
  provider: string;

  @ApiProperty({ description: 'Recommendation score (0-100)', example: 95 })
  score: number;

  @ApiProperty({
    description: 'Reason for recommendation',
    example: 'Best liquidity and lowest gas cost',
  })
  reason: string;

  @ApiProperty({ description: 'Alternative providers' })
  alternatives: Array<{
    provider: string;
    score: number;
    reason: string;
  }>;
}

/**
 * Capability Check Response
 */
export class CapabilityCheckData {
  @ApiProperty({
    description: 'Chain support status',
  })
  chainSupport: ChainSupportStatus;

  @ApiProperty({
    description: 'Token support status',
  })
  tokenSupport: TokenSupportStatus;

  @ApiProperty({
    description: 'Available providers for this request',
    type: 'array',
    items: { type: 'string' },
  })
  availableProviders: string[];

  @ApiProperty({
    description: 'Recommended provider with reasoning',
  })
  recommendedProvider: ProviderRecommendation;
}

/**
 * Enhanced route information
 */
export class EnhancedRouteInfo {
  @ApiProperty({ description: 'Provider name', example: '0x' })
  provider: string;

  @ApiProperty({ description: 'Expected output amount', example: '999500000' })
  outputAmount: string;

  @ApiProperty({ description: 'Minimum output amount', example: '995000000' })
  minOutputAmount: string;

  @ApiProperty({ description: 'Price impact percentage', example: '0.12' })
  priceImpact: string;

  @ApiProperty({ description: 'Estimated gas cost', example: '0.0045' })
  estimatedGas: string;

  @ApiProperty({ description: 'Route quality score (0-100)', example: 95 })
  qualityScore: number;

  @ApiProperty({ description: 'Execution steps for complex routes' })
  steps: Array<{
    action: 'swap' | 'bridge' | 'wrap' | 'unwrap';
    provider: string;
    fromToken: string;
    toToken: string;
    fromChain: string;
    toChain: string;
    estimatedTime: number;
  }>;

  @ApiProperty({ description: 'Total estimated execution time in seconds' })
  estimatedTime: number;

  @ApiProperty({ description: 'Transaction data for execution' })
  transactionData: {
    to: string;
    data: string;
    value: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };

  @ApiProperty({ description: 'Route ID for execution reference' })
  routeId: string;
}

/**
 * Route comparison analysis
 */
export class RouteComparison {
  @ApiProperty({ description: 'Best price route' })
  bestPrice: {
    provider: string;
    outputAmount: string;
    advantage: string;
  };

  @ApiProperty({ description: 'Fastest route' })
  fastestRoute: {
    provider: string;
    estimatedTime: number;
    advantage: string;
  };

  @ApiProperty({ description: 'Most reliable route' })
  mostReliable: {
    provider: string;
    reliabilityScore: number;
    advantage: string;
  };

  @ApiProperty({ description: 'Overall recommendation summary' })
  summary: string;
}

/**
 * Enhanced Quote Response Data
 */
export class EnhancedQuoteData {
  @ApiProperty({ description: 'Available routes' })
  routes: EnhancedRouteInfo[];

  @ApiProperty({ description: 'Recommended route (highest score)' })
  recommendedRoute: EnhancedRouteInfo;

  @ApiProperty({ description: 'Route comparison analysis' })
  comparison: RouteComparison;
}

/**
 * Execution step status details
 */
export class ExecutionStepStatus {
  @ApiProperty({
    description: 'Overall status',
    enum: [
      'PENDING',
      'IN_PROGRESS',
      'SUCCESS',
      'FAILED',
      'PARTIAL',
      'REVERTED',
    ],
    example: 'IN_PROGRESS',
  })
  overall:
    | 'PENDING'
    | 'IN_PROGRESS'
    | 'SUCCESS'
    | 'FAILED'
    | 'PARTIAL'
    | 'REVERTED';

  @ApiProperty({ description: 'Current step number', example: 2 })
  currentStep: number;

  @ApiProperty({ description: 'Total steps', example: 3 })
  totalSteps: number;

  @ApiProperty({ description: 'Progress percentage', example: 66 })
  progressPercentage: number;
}

/**
 * Individual execution step details
 */
export class ExecutionStep {
  @ApiProperty({ description: 'Step number', example: 1 })
  step: number;

  @ApiProperty({ description: 'Step action', example: 'Swap on source chain' })
  action: string;

  @ApiProperty({
    description: 'Step status',
    enum: ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED'],
    example: 'SUCCESS',
  })
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';

  @ApiProperty({
    description: 'Transaction hash for this step',
    required: false,
  })
  txHash?: string;

  @ApiProperty({
    description: 'Chain ID for this step (numeric for EVM, string for others)',
    oneOf: [
      { type: 'number', example: 1 },
      { type: 'string', example: 'solana-mainnet' },
    ],
  })
  chainId: number | string;

  @ApiProperty({ description: 'Provider handling this step' })
  provider: string;

  @ApiProperty({ description: 'Estimated time for this step (seconds)' })
  estimatedTime: number;

  @ApiProperty({
    description: 'Actual completion time (seconds)',
    required: false,
  })
  actualTime?: number;

  @ApiProperty({ description: 'Error details if step failed', required: false })
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

/**
 * Round-trip swap details (for ETH→USDT→ETH type swaps)
 */
export class RoundTripDetails {
  @ApiProperty({ description: 'First swap (leg 1) details' })
  swap1: {
    txHash: string;
    status: 'SUCCESS' | 'FAILED';
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    outputAmount: string;
    actualReceivedAmount: string; // Actual amount after confirmation (requirement #6)
    chainId: number | string;
    confirmations: number;
    completedAt: string;
    gasUsed?: string;
  };

  @ApiProperty({ description: 'Second swap (leg 2) details' })
  swap2: {
    txHash?: string; // May be undefined if second swap failed before execution
    status: 'PENDING' | 'SUCCESS' | 'FAILED';
    inputToken: string;
    outputToken: string;
    inputAmount: string; // Uses actualReceivedAmount from swap1
    outputAmount?: string;
    actualReceivedAmount?: string;
    chainId: number | string;
    confirmations?: number;
    completedAt?: string;
    gasUsed?: string;
    error?: {
      code: string;
      message: string;
      recoverable: boolean;
      recoverySuggestion: string; // e.g., "Retry second swap manually via executionId {id}"
    };
  };

  @ApiProperty({ description: 'Round-trip profitability analysis' })
  profitability: {
    initialAmount: string; // Original sellAmount
    finalAmount: string; // Final amount after both swaps
    profitLoss: string; // Positive = profit, negative = loss
    profitLossBps: number; // In basis points
    totalGasCost: string;
    netProfit: string; // After deducting gas costs
    isProfitable: boolean;
  };

  @ApiProperty({ description: 'Round-trip timing details' })
  timing: {
    swap1StartedAt: string;
    swap1CompletedAt: string;
    swap1DurationSeconds: number;
    waitBetweenSwaps: number; // Confirmation wait time
    swap2StartedAt?: string;
    swap2CompletedAt?: string;
    swap2DurationSeconds?: number;
    totalDurationSeconds: number;
  };
}

/**
 * Execution Response Data
 */
export class ExecutionData {
  @ApiProperty({
    description: 'Execution ID for tracking',
    example: 'exec_1234567890',
  })
  executionId: string;

  // New detailed fields
  @ApiProperty({
    description: 'Swap direction with chain information',
    required: false,
  })
  swapDirection?: {
    from: {
      token: string;
      address: string;
      chainId: number | string;
      chainName: string;
      ecosystem: string;
    };
    to: {
      token: string;
      address: string;
      chainId: number | string;
      chainName: string;
      ecosystem: string;
    };
    isCrossChain: boolean;
  };

  @ApiProperty({
    description: 'Swap type',
    required: false,
    example: 'cross-chain',
  })
  swapType?: string;

  @ApiProperty({
    description: 'Provider category',
    required: false,
    example: 'meta',
  })
  providerCategory?: string;

  @ApiProperty({
    description: 'Aggregator name',
    required: false,
    example: 'Rubic',
  })
  aggregator?: string;

  @ApiProperty({
    description: 'Currency details',
    required: false,
  })
  currencies?: {
    sell: any;
    buy: any;
  };

  @ApiProperty({
    description: 'Sender and receiver addresses',
    required: false,
  })
  addresses?: {
    sender: string;
    recipient: string;
    finalReceiver: string;
  };

  @ApiProperty({
    description:
      'Route details including route ID, estimated gas, fees, and amounts',
    required: false,
  })
  route?: {
    routeId: string;
    provider: string;
    estimatedGas: string;
    estimatedOutputAmount: any;
    minimumOutputAmount?: {
      raw: string;
      formatted: string;
      symbol: string;
    };
    priceImpact?: string;
    slippage?: number | string;
    etaSeconds?: number;
    gasDetails?: {
      gasLimit: string;
      gasCostWei: string;
      gasPrice: string;
      maxFeePerGas?: string;
      maxPriorityFeePerGas?: string;
    };
    feeDetails?: {
      providerFee: string;
      providerFeeUsd?: number | string;
      bridgeFee?: string;
      percentFeePercent?: number;
      percentFeeToken?: string;
    };
  };

  @ApiProperty({
    description: 'Transaction execution details (blockchain-specific)',
    required: false,
  })
  transaction?: any;

  @ApiProperty({
    description:
      'Amount adjustment details when swap amount was adjusted for gas fees',
    required: false,
  })
  amountAdjustment?: {
    originalAmount: string;
    adjustedAmount: string;
    gasCost: string;
    reason: string;
    originalOutputAmount?: string;
    adjustedOutputAmount?: string;
  };

  @ApiProperty({
    description:
      'Round-trip swap details (only present for round-trip swaps with finalOutputToken)',
    required: false,
  })
  roundTripDetails?: RoundTripDetails;

  // Legacy fields for backward compatibility
  @ApiProperty({
    description: 'Transaction hashes',
    type: 'array',
    items: { type: 'string' },
  })
  transactionHashes: string[];

  @ApiProperty({ description: 'Current execution status' })
  status: ExecutionStepStatus;

  @ApiProperty({ description: 'Execution steps with progress' })
  steps: ExecutionStep[];

  @ApiProperty({ description: 'Estimated completion time' })
  estimatedCompletion: string;

  @ApiProperty({ description: 'Real-time tracking URLs' })
  trackingUrls: Array<{
    chain: string;
    url: string;
    description: string;
  }>;
}

/**
 * Status Response Data
 */
export class StatusData {
  @ApiProperty({ description: 'Execution ID', example: 'exec_1234567890' })
  executionId: string;

  @ApiProperty({ description: 'Current status' })
  status: ExecutionStepStatus;

  @ApiProperty({ description: 'Detailed steps progress' })
  steps: ExecutionStep[];

  @ApiProperty({
    description: 'Transaction details',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        hash: { type: 'string' },
        chainId: { oneOf: [{ type: 'number' }, { type: 'string' }] },
        status: { type: 'string', enum: ['pending', 'confirmed', 'failed'] },
        confirmations: { type: 'number' },
        explorerUrl: { type: 'string' },
      },
    },
  })
  transactions: Array<{
    hash: string;
    chainId: number | string;
    status: 'pending' | 'confirmed' | 'failed';
    confirmations: number;
    explorerUrl: string;
  }>;

  @ApiProperty({ description: 'Final result (if completed)' })
  result?: {
    inputAmount: string;
    outputAmount: string;
    actualPriceImpact: string;
    totalGasUsed: string;
    totalTimeSeconds: number;
    completedAt: string;
  };

  @ApiProperty({ description: 'Next recommended action (if failed/partial)' })
  nextAction?: {
    action: 'retry' | 'claim' | 'refund' | 'wait';
    description: string;
    instructions?: string[];
  };
}
