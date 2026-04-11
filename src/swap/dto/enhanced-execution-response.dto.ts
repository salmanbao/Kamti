import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Enhanced Transaction Details
 * Provides comprehensive information about blockchain transactions
 */
export class EnhancedTransactionDetails {
  @ApiProperty({ description: 'Transaction hash', example: '0x1234...' })
  hash: string;

  @ApiProperty({
    description: 'Chain ID',
    oneOf: [
      { type: 'number', example: 1 },
      { type: 'string', example: 'solana-mainnet' },
    ],
  })
  chainId: number | string;

  @ApiProperty({ description: 'Chain name', example: 'Ethereum Mainnet' })
  chainName: string;

  @ApiProperty({
    description: 'Blockchain ecosystem',
    enum: ['evm', 'solana', 'cosmos', 'bitcoin'],
    example: 'evm',
  })
  ecosystem: 'evm' | 'solana' | 'cosmos' | 'bitcoin';

  @ApiPropertyOptional({ description: 'Block number', example: 18500000 })
  blockNumber?: number;

  @ApiPropertyOptional({ description: 'Block hash', example: '0xabc...' })
  blockHash?: string;

  @ApiPropertyOptional({
    description: 'Block timestamp',
    example: '2024-11-10T12:00:00.000Z',
  })
  blockTimestamp?: string;

  @ApiProperty({ description: 'Number of confirmations received', example: 12 })
  confirmations: number;

  @ApiProperty({ description: 'Number of confirmations required', example: 12 })
  requiredConfirmations: number;

  @ApiProperty({
    description: 'Confirmation progress percentage',
    example: 100,
  })
  confirmationProgress: number;

  @ApiPropertyOptional({
    description: 'Transaction type (EVM)',
    enum: ['legacy', 'eip-2930', 'eip-1559'],
    example: 'eip-1559',
  })
  type?: 'legacy' | 'eip-2930' | 'eip-1559';

  @ApiPropertyOptional({ description: 'Transaction nonce', example: 42 })
  nonce?: number;

  @ApiProperty({ description: 'Sender address', example: '0xsender...' })
  from: string;

  @ApiProperty({ description: 'Recipient address', example: '0xrecipient...' })
  to: string;

  @ApiProperty({
    description: 'Transaction status',
    enum: ['pending', 'confirmed', 'failed', 'dropped'],
    example: 'confirmed',
  })
  status: 'pending' | 'confirmed' | 'failed' | 'dropped';

  @ApiPropertyOptional({
    description: 'Status reason',
    example: 'Transaction confirmed successfully',
  })
  statusReason?: string;
}

/**
 * Gas and Fee Details
 * Comprehensive breakdown of transaction costs
 */
export class GasAndFeeDetails {
  @ApiPropertyOptional({ description: 'EVM-specific gas details' })
  evm?: {
    gasLimit: string;
    gasUsed: string;
    gasUtilization: number; // percentage

    // EIP-1559 Details
    baseFeePerGas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    effectiveGasPrice: string;

    // Costs
    totalGasCost: {
      wei: string;
      ether: string;
      usd?: string;
    };

    // Savings
    estimatedGasCost?: string;
    actualGasCost?: string;
    gasSavings?: {
      amount: string;
      percentage: number;
    };
  };

  @ApiPropertyOptional({ description: 'Solana-specific compute details' })
  solana?: {
    computeUnitsUsed: number;
    computeUnitsLimit: number;
    computeUnitPrice: number;

    priorityFee: {
      lamports: string;
      sol: string;
      usd?: string;
    };

    totalFee: {
      lamports: string;
      sol: string;
      usd?: string;
    };
  };

  @ApiPropertyOptional({ description: 'Protocol fees breakdown' })
  protocolFees?: {
    integratorFee?: {
      amount: string;
      token: string;
      usd?: string;
    };
    providerFee?: {
      amount: string;
      token: string;
      usd?: string;
    };
    bridgeFee?: {
      amount: string;
      token: string;
      usd?: string;
    };
  };

  @ApiProperty({ description: 'Total cost summary' })
  totalCost: {
    native: string;
    usd?: string;
    breakdown: string[];
  };
}

/**
 * Token Details
 */
export class TokenDetails {
  @ApiProperty({ description: 'Token contract address' })
  address: string;

  @ApiProperty({ description: 'Token symbol', example: 'ETH' })
  symbol: string;

  @ApiProperty({ description: 'Token decimals', example: 18 })
  decimals: number;

  @ApiPropertyOptional({ description: 'Token logo URL' })
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Token name', example: 'Ethereum' })
  name?: string;
}

/**
 * Amount Details
 */
export class AmountDetails {
  @ApiProperty({
    description: 'Raw amount (wei/lamports)',
    example: '1000000000000000000',
  })
  raw: string;

  @ApiProperty({ description: 'Formatted amount', example: '1.0' })
  formatted: string;

  @ApiPropertyOptional({ description: 'USD value', example: '2500.00' })
  usd?: string;
}

/**
 * Swap Outcome Details
 * Information about the swap execution results
 */
export class SwapOutcomeDetails {
  @ApiProperty({ description: 'Input token and amount' })
  input: {
    token: TokenDetails;
    amount: AmountDetails;
  };

  @ApiProperty({ description: 'Output token and amounts' })
  output: {
    token: TokenDetails;
    expectedAmount: AmountDetails;
    minAmount: AmountDetails;
    actualAmount?: AmountDetails;
  };

  @ApiProperty({ description: 'Exchange rate information' })
  exchangeRate: {
    rate: string; // e.g., "1 ETH = 2500 USDT"
    inverseRate: string; // e.g., "1 USDT = 0.0004 ETH"
    marketRate?: string;
    marketComparison?: {
      difference: string;
      percentage: number;
    };
  };

  @ApiProperty({ description: 'Price impact details' })
  priceImpact: {
    estimated: string; // "0.12%"
    actual?: string; // "0.15%"
    severity: 'low' | 'medium' | 'high';
  };

  @ApiProperty({ description: 'Slippage information' })
  slippage: {
    tolerance: string; // "0.5%"
    incurred?: string; // "0.3%"
    utilizationPercentage?: number;
  };

  @ApiPropertyOptional({ description: 'Value transfer summary' })
  valueTransfer?: {
    usdInput?: string;
    usdOutput?: string;
    profit?: string;
    profitPercentage?: number;
  };
}

/**
 * DEX Source Details
 */
export class DEXSourceDetails {
  @ApiProperty({ description: 'DEX name', example: 'Uniswap V3' })
  dex: string;

  @ApiProperty({
    description: 'Percentage of trade routed through this DEX',
    example: 70,
  })
  percentage: number;

  @ApiProperty({ description: 'Input amount to this DEX', example: '0.7 ETH' })
  inputAmount: string;

  @ApiProperty({
    description: 'Output amount from this DEX',
    example: '1748.81 USDT',
  })
  outputAmount: string;
}

/**
 * Route Provider Details
 * Information about the swap route and provider
 */
export class RouteProviderDetails {
  @ApiProperty({ description: 'Aggregator name', example: 'Rubic' })
  aggregator: string;

  @ApiProperty({
    description: 'Provider type',
    enum: ['meta', 'evm-aggregator', 'solana', 'native-l1'],
    example: 'meta',
  })
  providerType: 'meta' | 'evm-aggregator' | 'solana' | 'native-l1';

  @ApiPropertyOptional({ description: 'Provider version', example: 'v2.1.0' })
  version?: string;

  @ApiProperty({ description: 'Route details' })
  route: {
    type: 'direct' | 'multi-hop' | 'cross-chain';
    complexity: 'simple' | 'moderate' | 'complex';
    hops: number;

    sources?: DEXSourceDetails[];

    path: string[]; // ["ETH", "USDT"]
    pathDescription: string; // "ETH → USDT via Uniswap V3 (100%)"
  };

  @ApiProperty({ description: 'Performance metrics' })
  performance: {
    estimatedTime: number; // seconds
    actualTime?: number; // seconds
    speed?: 'faster' | 'average' | 'slower';
  };

  @ApiPropertyOptional({ description: 'Quality metrics' })
  quality?: {
    overallScore: number; // 0-100
    priceScore: number;
    speedScore: number;
    reliabilityScore: number;

    ranking?: {
      position: number;
      totalRoutes: number;
      betterAlternatives?: number;
    };
  };
}

/**
 * Cross-Chain Details
 * Information specific to cross-chain swaps
 */
export class CrossChainDetails {
  @ApiProperty({ description: 'Source chain transaction details' })
  sourceChain: {
    chainId: number | string;
    chainName: string;
    transaction: EnhancedTransactionDetails;
    explorerUrl: string;
  };

  @ApiProperty({ description: 'Destination chain transaction details' })
  destinationChain: {
    chainId: number | string;
    chainName: string;
    transaction?: EnhancedTransactionDetails;
    explorerUrl?: string;
    estimatedArrival?: string;
  };

  @ApiPropertyOptional({ description: 'Bridge information' })
  bridge?: {
    protocol: string; // "Stargate", "Axelar", "Wormhole"
    status:
      | 'initiated'
      | 'pending'
      | 'in_progress'
      | 'completed'
      | 'failed'
      | 'reverted';
    statusUrl?: string;

    fees: {
      bridgeFee: string;
      relayerFee?: string;
      total: string;
    };

    timing: {
      estimatedSeconds: number;
      actualSeconds?: number;
      currentPhase: string;
    };

    security: {
      confirmationsRequired: number;
      confirmationsReceived: number;
      securityLevel: 'fast' | 'standard' | 'secure';
    };
  };

  @ApiPropertyOptional({ description: 'Intermediate transactions' })
  intermediateTransactions?: Array<{
    chainId: number | string;
    hash: string;
    purpose: string;
    status: string;
    explorerUrl: string;
  }>;
}

/**
 * Execution Timeline
 * Chronological record of execution events
 */
export class ExecutionTimeline {
  @ApiProperty({ description: 'Timeline events' })
  events: Array<{
    timestamp: string;
    event: string;
    status: 'success' | 'failed' | 'pending';
    description: string;
    details?: any;
  }>;

  @ApiProperty({ description: 'Execution milestones' })
  milestones: {
    requestReceived: string;
    validationCompleted?: string;
    approvalGranted?: string;
    transactionSubmitted?: string;
    transactionConfirmed?: string;
    bridgeInitiated?: string;
    bridgeCompleted?: string;
    finalConfirmation?: string;
  };

  @ApiProperty({ description: 'Duration breakdown in seconds' })
  duration: {
    total: number;
    validation?: number;
    approval?: number;
    execution?: number;
    confirmation?: number;
    bridge?: number;
  };
}

/**
 * Enhanced Error Details
 * Comprehensive error information with recovery guidance
 */
export class EnhancedErrorDetails {
  @ApiProperty({ description: 'Error code', example: 'INSUFFICIENT_LIQUIDITY' })
  code: string;

  @ApiProperty({
    description: 'Error category',
    enum: [
      'network',
      'validation',
      'execution',
      'confirmation',
      'bridge',
      'user',
    ],
    example: 'execution',
  })
  category:
    | 'network'
    | 'validation'
    | 'execution'
    | 'confirmation'
    | 'bridge'
    | 'user';

  @ApiProperty({
    description: 'Error severity',
    enum: ['critical', 'high', 'medium', 'low'],
    example: 'high',
  })
  severity: 'critical' | 'high' | 'medium' | 'low';

  @ApiProperty({ description: 'Whether error is recoverable', example: true })
  recoverable: boolean;

  @ApiProperty({
    description: 'Error message',
    example: 'Transaction failed due to insufficient liquidity',
  })
  message: string;

  @ApiPropertyOptional({ description: 'Technical details' })
  technicalDetails?: string;

  @ApiProperty({
    description: 'User-friendly message',
    example:
      "Your swap couldn't complete because there wasn't enough liquidity available.",
  })
  userFriendlyMessage: string;

  @ApiProperty({ description: 'Root cause analysis' })
  rootCause: {
    component: string;
    reason: string;
    possibleCauses: string[];
  };

  @ApiPropertyOptional({ description: 'Partial execution details' })
  partialExecution?: {
    completedSteps: number;
    totalSteps: number;
    assetsLocked?: Array<{
      token: string;
      amount: string;
      location: string;
    }>;
    recoveryPossible: boolean;
  };

  @ApiProperty({ description: 'Suggested recovery actions' })
  suggestedActions: {
    immediate: string[];
    followUp?: string[];
    automated?: {
      available: boolean;
      action: 'retry' | 'refund' | 'claim';
      endpoint?: string;
    };
  };

  @ApiPropertyOptional({ description: 'Support information' })
  supportInfo?: {
    executionId: string;
    contactEmail?: string;
    documentationUrl?: string;
  };
}

/**
 * Enhanced Execution Step
 * Detailed information about each execution step
 */
export class EnhancedExecutionStep {
  @ApiProperty({ description: 'Step number', example: 1 })
  stepNumber: number;

  @ApiProperty({
    description: 'Step type',
    enum: ['approval', 'swap', 'bridge', 'wrap', 'unwrap'],
    example: 'swap',
  })
  type: 'approval' | 'swap' | 'bridge' | 'wrap' | 'unwrap';

  @ApiProperty({
    description: 'Step status',
    enum: ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED'],
    example: 'SUCCESS',
  })
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';

  @ApiProperty({
    description: 'Step description',
    example: 'Swap ETH for USDT on Ethereum',
  })
  description: string;

  @ApiProperty({
    description: 'Chain ID',
    oneOf: [
      { type: 'number', example: 1 },
      { type: 'string', example: 'solana-mainnet' },
    ],
  })
  chainId: number | string;

  @ApiProperty({ description: 'Chain name', example: 'Ethereum Mainnet' })
  chainName: string;

  @ApiProperty({
    description: 'Provider handling this step',
    example: 'Uniswap V3',
  })
  provider: string;

  @ApiPropertyOptional({ description: 'Transaction hash' })
  transactionHash?: string;

  @ApiPropertyOptional({ description: 'Block explorer URL' })
  explorerUrl?: string;

  @ApiProperty({ description: 'Timing information' })
  timing: {
    startedAt?: string;
    completedAt?: string;
    duration?: number; // seconds
    estimated: number; // seconds
  };

  @ApiPropertyOptional({ description: 'Error details if step failed' })
  error?: {
    message: string;
    code: string;
    recoverable: boolean;
  };
}

/**
 * Warnings and Recommendations
 */
export class WarningsAndRecommendations {
  @ApiProperty({ description: 'Warnings' })
  warnings: Array<{
    type: 'gas' | 'slippage' | 'liquidity' | 'time' | 'security';
    severity: 'info' | 'warning' | 'critical';
    message: string;
    impact?: string;
  }>;

  @ApiProperty({ description: 'Recommendations for improvement' })
  recommendations: Array<{
    category: 'optimization' | 'security' | 'timing';
    suggestion: string;
    potentialSavings?: string;
    implementationDifficulty?: 'easy' | 'medium' | 'hard';
  }>;
}

/**
 * Tracking Information
 */
export class TrackingInformation {
  @ApiProperty({ description: 'Block explorer URLs' })
  explorerUrls: Array<{
    chain: string;
    chainId: number | string;
    url: string;
    description: string;
    type: 'source' | 'destination' | 'intermediate';
  }>;

  @ApiPropertyOptional({ description: 'Bridge status tracking URL' })
  bridgeStatusUrl?: string;

  @ApiProperty({
    description: 'API endpoint for status polling',
    example: '/universal-swap/status',
  })
  statusCheckEndpoint: string;

  @ApiPropertyOptional({ description: 'WebSocket URL for real-time updates' })
  websocketUrl?: string;
}

/**
 * Phase 4: Alternative Route Details
 * Information about routes that were not selected
 */
export class AlternativeRouteDetails {
  @ApiProperty({ description: 'Alternative aggregator name', example: 'Odos' })
  aggregator: string;

  @ApiProperty({ description: 'Route ID', example: 'route_odos_12345' })
  routeId: string;

  @ApiProperty({ description: 'Expected output amount' })
  outputAmount: {
    raw: string;
    formatted: string;
    usd?: string;
  };

  @ApiProperty({ description: 'Total cost estimate' })
  totalCost: {
    native: string;
    usd?: string;
    breakdown: {
      gas?: string;
      protocolFees?: string;
    };
  };

  @ApiProperty({ description: 'Price comparison with selected route' })
  priceComparison: {
    outputDifference: string; // "+50 USDC" or "-25 USDC"
    outputDifferencePercent: number; // +2.5% or -1.2%
    betterThan: boolean; // true if this route would have been better
  };

  @ApiProperty({ description: 'Cost comparison with selected route' })
  costComparison: {
    costDifference: string; // "+0.002 ETH ($5.50)" or "-0.001 ETH ($2.75)"
    costDifferencePercent: number;
    cheaper: boolean;
  };

  @ApiProperty({ description: 'Estimated execution time in seconds' })
  estimatedTime: number;

  @ApiProperty({ description: 'Quality score (0-100)' })
  qualityScore: number;

  @ApiProperty({ description: 'Why this route was not selected' })
  notSelectedReason: string;
}

/**
 * Phase 4: Route Comparison Analysis
 * Comprehensive comparison between selected and alternative routes
 */
export class RouteComparisonAnalysis {
  @ApiProperty({ description: 'Selected route summary' })
  selectedRoute: {
    aggregator: string;
    outputAmount: string;
    totalCost: string;
    qualityScore: number;
    rank: number; // 1 = best
  };

  @ApiProperty({
    description: 'Alternative routes that were available',
    type: [AlternativeRouteDetails],
  })
  alternatives: AlternativeRouteDetails[];

  @ApiProperty({ description: 'Best alternative by output amount' })
  bestByOutput?: {
    aggregator: string;
    potentialGain: string; // "Could have received 25 more USDC (+1.2%)"
    gainUsd?: string;
  };

  @ApiProperty({ description: 'Cheapest alternative by total cost' })
  cheapest?: {
    aggregator: string;
    potentialSavings: string; // "Could have saved 0.001 ETH ($2.75)"
    savingsPercent: number;
  };

  @ApiProperty({ description: 'Fastest alternative by execution time' })
  fastest?: {
    aggregator: string;
    timeDifference: number; // seconds faster
  };

  @ApiProperty({ description: 'Overall route selection verdict' })
  verdict: {
    optimal: boolean; // true if selected route was the best overall
    rank: number; // 1-N where 1 is best
    totalRoutesCompared: number;
    summary: string; // "You got the best available price" or "You could have saved $2.75 with Odos"
  };
}

/**
 * Phase 4: Optimization Suggestion
 * Actionable recommendations for better swap execution
 */
export class OptimizationSuggestion {
  @ApiProperty({
    description: 'Optimization type',
    enum: ['split-order', 'timing', 'route', 'gas', 'slippage', 'aggregator'],
    example: 'split-order',
  })
  type: 'split-order' | 'timing' | 'route' | 'gas' | 'slippage' | 'aggregator';

  @ApiProperty({
    description: 'Suggestion title',
    example: 'Split large order to reduce price impact',
  })
  title: string;

  @ApiProperty({ description: 'Detailed description' })
  description: string;

  @ApiProperty({
    description: 'Priority level',
    enum: ['critical', 'high', 'medium', 'low'],
    example: 'high',
  })
  priority: 'critical' | 'high' | 'medium' | 'low';

  @ApiProperty({ description: 'Estimated potential savings' })
  potentialSavings?: {
    amount: string;
    usd?: string;
    percentage?: number;
  };

  @ApiProperty({ description: 'Implementation difficulty' })
  difficulty: 'easy' | 'medium' | 'hard';

  @ApiProperty({ description: 'Actionable steps' })
  actionableSteps: string[];

  @ApiPropertyOptional({ description: 'Code example or API parameters' })
  implementationExample?: string;

  @ApiPropertyOptional({ description: 'Estimated impact' })
  impact?: {
    metric: string; // "price impact", "gas cost", "execution time"
    improvement: string; // "Reduce from 5% to 2%"
  };
}

/**
 * Phase 4: Market Context
 * Current market conditions relevant to the swap
 */
export class MarketContext {
  @ApiProperty({ description: 'Token pair liquidity analysis' })
  liquidity: {
    available: 'excellent' | 'good' | 'moderate' | 'low' | 'poor';
    depth: {
      usd: string; // Total liquidity in USD
      tokens: string; // Liquidity in output token
    };
    topPools: Array<{
      dex: string;
      liquidity: string;
      volume24h?: string;
    }>;
  };

  @ApiProperty({ description: 'Market volatility indicators' })
  volatility: {
    level: 'very-low' | 'low' | 'moderate' | 'high' | 'very-high';
    priceChange24h: number; // percentage
    priceChange1h: number;
    historicalVolatility?: number; // annualized volatility %
  };

  @ApiProperty({ description: 'Trading volume analysis' })
  volume: {
    volume24h: string;
    volumeChange24h: number; // percentage
    averageTradeSize: string;
    largeTradeThreshold: string; // Your trade size relative to average
  };

  @ApiProperty({ description: 'Gas price context' })
  gasPriceContext?: {
    current: string;
    average24h: string;
    percentile: number; // Your gas price compared to last 24h (0-100)
    trend: 'decreasing' | 'stable' | 'increasing';
    recommendation: string; // "Good time to swap" or "Wait for lower gas"
  };

  @ApiProperty({ description: 'Optimal swap timing recommendation' })
  timingRecommendation: {
    currentTime: 'excellent' | 'good' | 'moderate' | 'poor';
    reasoning: string;
    betterTimeframes?: Array<{
      timeframe: string; // "In 2-4 hours", "Tomorrow morning"
      expectedSavings?: string;
      factors: string[]; // ["Lower gas prices", "Better liquidity"]
    }>;
  };
}

/**
 * Phase 4: Aggregator Analytics
 * Performance statistics for aggregators used
 */
export class AggregatorAnalytics {
  @ApiProperty({ description: 'Aggregator name', example: '0x' })
  aggregator: string;

  @ApiProperty({ description: 'Historical performance metrics' })
  performance: {
    successRate: number; // percentage (0-100)
    averageExecutionTime: number; // seconds
    totalSwapsProcessed: number;
    volumeProcessed: string; // USD
  };

  @ApiProperty({ description: 'Cost analysis' })
  costs: {
    averageGasCost: string; // in USD
    averageProtocolFee: number; // percentage
    averageTotalCost: string; // in USD
    comparedToOthers: 'cheaper' | 'average' | 'expensive';
  };

  @ApiProperty({ description: 'Quality metrics' })
  quality: {
    averagePriceImpact: number; // percentage
    averageSlippage: number; // percentage
    failureRate: number; // percentage
    userSatisfactionScore?: number; // 0-100
  };

  @ApiProperty({ description: 'Best use cases for this aggregator' })
  bestFor: string[]; // ["Large trades", "Cross-chain swaps", "Low fees"]

  @ApiProperty({ description: 'Recent performance trend' })
  trend: {
    period: '7d' | '30d';
    successRateChange: number; // percentage points
    costChange: number; // percentage
    qualityChange: number; // percentage points
  };
}

/**
 * Phase 4: Savings Calculator
 * Calculates actual and potential savings
 */
export class SavingsCalculation {
  @ApiProperty({ description: 'Total actual cost of this swap' })
  actualCost: {
    native: string;
    usd: string;
    breakdown: {
      gas: string;
      protocolFees: string;
      priceImpact: string;
    };
  };

  @ApiProperty({ description: 'Potential savings with optimal route' })
  potentialSavings: {
    amount: string;
    usd?: string;
    percentage: number;
    comparedTo: string; // "average route" or "worst route"
  };

  @ApiProperty({ description: 'Savings vs alternative aggregators' })
  vsAlternatives: Array<{
    aggregator: string;
    saved: string; // "+$5.50" (saved) or "-$2.25" (lost)
    percentage: number;
  }>;

  @ApiProperty({ description: 'Historical comparison' })
  vsHistorical: {
    averageCostSimilarSwaps: string;
    yourSavings: string; // or overpayment if negative
    percentile: number; // 0-100, where 100 = best deal
  };

  @ApiProperty({ description: 'Optimization opportunities' })
  optimizationOpportunities: Array<{
    opportunity: string; // "Split into 2 smaller swaps"
    potentialSavings: string;
    effort: 'low' | 'medium' | 'high';
  }>;
}

/**
 * Phase 4: Smart Recommendations
 * AI-powered recommendations based on analysis
 */
export class SmartRecommendations {
  @ApiProperty({ description: 'Overall recommendation score (0-100)' })
  score: number;

  @ApiProperty({ description: 'Verdict on swap execution' })
  verdict: {
    rating: 'excellent' | 'good' | 'fair' | 'poor';
    summary: string;
    keyPoints: string[];
  };

  @ApiProperty({ description: 'Route optimization suggestions' })
  routeOptimizations: OptimizationSuggestion[];

  @ApiProperty({ description: 'Alternative aggregator recommendations' })
  alternativeAggregators?: Array<{
    aggregator: string;
    benefit: string;
    useCase: string;
    potentialSavings?: string;
  }>;

  @ApiProperty({ description: 'Timing recommendations' })
  timingAdvice?: {
    currentTiming: 'optimal' | 'good' | 'acceptable' | 'poor';
    suggestion: string;
    potentialImprovement?: string;
  };

  @ApiProperty({ description: 'Risk warnings' })
  risks?: Array<{
    risk: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    mitigation: string;
  }>;

  @ApiProperty({ description: 'Best practices for future swaps' })
  futureAdvice: string[];
}

/**
 * Phase 4: DEX Health Metrics
 * Health and reliability metrics for DEXs involved
 */
export class DEXHealthMetrics {
  @ApiProperty({ description: 'DEX name', example: 'Uniswap V3' })
  dex: string;

  @ApiProperty({ description: 'Health score (0-100)' })
  healthScore: number;

  @ApiProperty({ description: 'Liquidity status' })
  liquidity: {
    tvl: string; // Total Value Locked
    volume24h: string;
    liquidityUtilization: number; // percentage
  };

  @ApiProperty({ description: 'Performance metrics' })
  performance: {
    uptime: number; // percentage
    averageSlippage: number; // percentage
    failedTransactionRate: number; // percentage
  };

  @ApiProperty({ description: 'Gas efficiency' })
  gasEfficiency: {
    averageGasUsed: string;
    comparedToOthers: 'efficient' | 'average' | 'inefficient';
  };

  @ApiProperty({ description: 'Security status' })
  security: {
    audited: boolean;
    lastAuditDate?: string;
    knownVulnerabilities: number;
    riskLevel: 'low' | 'medium' | 'high';
  };
}

/**
 * Phase 4: Premium Analytics
 * Advanced analytics and insights (Phase 4)
 */
export class PremiumAnalytics {
  @ApiProperty({
    description: 'Route comparison with alternatives',
    type: RouteComparisonAnalysis,
  })
  routeComparison: RouteComparisonAnalysis;

  @ApiProperty({
    description: 'Smart recommendations for optimization',
    type: SmartRecommendations,
  })
  recommendations: SmartRecommendations;

  @ApiProperty({
    description: 'Market context and conditions',
    type: MarketContext,
  })
  marketContext: MarketContext;

  @ApiProperty({
    description: 'Aggregator performance analytics',
    type: [AggregatorAnalytics],
  })
  aggregatorAnalytics: AggregatorAnalytics[];

  @ApiProperty({
    description: 'DEX health metrics for involved DEXs',
    type: [DEXHealthMetrics],
  })
  dexHealth: DEXHealthMetrics[];

  @ApiProperty({
    description: 'Savings calculation and analysis',
    type: SavingsCalculation,
  })
  savings: SavingsCalculation;

  @ApiPropertyOptional({
    description: 'Historical comparison with similar swaps',
  })
  historicalComparison?: {
    similarSwapsCount: number;
    yourPerformance: {
      percentile: number; // 0-100, where 100 = best
      betterThanAverage: boolean;
    };
    insights: string[];
  };

  @ApiPropertyOptional({ description: 'Predictive insights' })
  predictiveInsights?: {
    estimatedFuturePrice?: {
      timeframe: string; // "1h", "4h", "24h"
      estimatedChange: number; // percentage
      confidence: number; // 0-100
    };
    gasPriceForecast?: {
      timeframe: string;
      estimatedGasPrice: string;
      trend: 'up' | 'down' | 'stable';
    };
  };
}

/**
 * Enhanced Execution Data
 * Complete, comprehensive execution response
 */
export class EnhancedExecutionData {
  @ApiProperty({
    description: 'Unique execution identifier',
    example: 'exec_1699564800_xyz123',
  })
  executionId: string;

  @ApiProperty({
    description: 'Route identifier',
    example: 'route_1699564790_abc456',
  })
  routeId: string;

  @ApiProperty({
    description: 'Request timestamp',
    example: '2024-11-10T12:00:00.000Z',
  })
  requestTimestamp: string;

  @ApiPropertyOptional({
    description: 'Completion timestamp',
    example: '2024-11-10T12:00:45.000Z',
  })
  completionTimestamp?: string;

  @ApiProperty({ description: 'Overall execution status' })
  status: {
    overall: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'PARTIAL';
    currentStep: number;
    totalSteps: number;
    progressPercentage: number;
    estimatedCompletion?: string;
  };

  @ApiProperty({
    description: 'All transaction details',
    type: [EnhancedTransactionDetails],
  })
  transactions: EnhancedTransactionDetails[];

  @ApiProperty({
    description: 'Primary swap transaction',
    type: EnhancedTransactionDetails,
  })
  primaryTransaction: EnhancedTransactionDetails;

  @ApiProperty({ description: 'Gas and fee details', type: GasAndFeeDetails })
  gasAndFees: GasAndFeeDetails;

  @ApiProperty({
    description: 'Swap outcome details',
    type: SwapOutcomeDetails,
  })
  swapOutcome: SwapOutcomeDetails;

  @ApiProperty({
    description: 'Route and provider information',
    type: RouteProviderDetails,
  })
  routeProvider: RouteProviderDetails;

  @ApiPropertyOptional({
    description: 'Cross-chain specific details',
    type: CrossChainDetails,
  })
  crossChain?: CrossChainDetails;

  @ApiProperty({
    description: 'Execution steps',
    type: [EnhancedExecutionStep],
  })
  steps: EnhancedExecutionStep[];

  @ApiProperty({ description: 'Execution timeline', type: ExecutionTimeline })
  timeline: ExecutionTimeline;

  @ApiProperty({
    description: 'Tracking information',
    type: TrackingInformation,
  })
  tracking: TrackingInformation;

  @ApiPropertyOptional({
    description: 'Warnings and recommendations',
    type: WarningsAndRecommendations,
  })
  warningsRecommendations?: WarningsAndRecommendations;

  @ApiPropertyOptional({
    description:
      'Premium analytics with comparisons and recommendations (Phase 4)',
    type: PremiumAnalytics,
  })
  premiumAnalytics?: PremiumAnalytics;

  @ApiPropertyOptional({
    description: 'Error details (if failed)',
    type: EnhancedErrorDetails,
  })
  error?: EnhancedErrorDetails;

  @ApiProperty({ description: 'Response metadata' })
  metadata: {
    ecosystem: string[];
    aggregators: string[];
    chains: Array<{
      id: number | string;
      name: string;
      role: 'source' | 'destination' | 'intermediate';
    }>;
    complexity: 'simple' | 'moderate' | 'complex';
    version: string;
  };
}
