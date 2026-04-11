import { RouteQuote } from '@swap/models/ports';

/**
 * Amount adjustment details when swap amount is adjusted for gas fees
 */
export interface AmountAdjustment {
  originalAmount: string;
  adjustedAmount: string;
  gasCost: string;
  gasLimit?: string; // Accurate gas limit from estimation (without double margins)
  reserved?: string; // Amount reserved for fees (rent-exempt minimum, gas, etc.)
  feeBreakdown?: any; // Detailed fee breakdown (signature, compute, rent, safety buffer, etc.)
  reason: string;
  originalOutputAmount?: string;
  adjustedOutputAmount?: string;
}

/**
 * Execution request containing all necessary data for swap execution
 */
export interface ExecutionRequest {
  routeId: string;
  route: RouteQuote;
  userWallet: string;
  recipient?: string;
  privateKey: string;
  slippageToleranceBps?: number;
  deadline?: number;
  swapFullBalance?: boolean; // Flag indicating user wants to swap full balance
  amountAdjustment?: AmountAdjustment; // Details of amount adjustment if applied
}

/**
 * Execution result containing transaction details and status
 */
export interface ExecutionResult {
  success: boolean;
  transactionHash: string;
  chainId: number | string;
  blockNumber?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  error?: string;
  errorDetails?: any;
  timestamp: Date;
  warnings?: string[];
  explorerUrl?: string;
  // Cross-chain enrichment (optional)
  destChainId?: number | string;
  destTransactionHash?: string;
  destExplorerUrl?: string;
  bridgeStatus?: string; // e.g., 'initiated' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'reverted'
  bridgeStatusUrl?: string;
}

/**
 * Execution context for passing data between validation and execution steps
 *
 * Note on validation flags:
 * - routeValid: Basic route structure and provider availability
 * - slippageAcceptable: Slippage tolerance is within user's acceptable range
 * - providerHealthy: Provider service is operational and responding
 * - balanceSufficient: Optional - Executors may check balance dynamically in preExecute()
 * - approvalGranted: Optional - Executors handle approvals dynamically in preExecute()
 */
export interface ExecutionContext {
  request: ExecutionRequest;
  validations: {
    routeValid: boolean;
    slippageAcceptable: boolean;
    providerHealthy: boolean;
    balanceSufficient?: boolean; // Optional: Checked dynamically by executors
    approvalGranted?: boolean; // Optional: Handled dynamically by executors
  };
  estimatedGas?: string;
  executionStartTime?: Date;
}

/**
 * Base interface for swap executors following Strategy Pattern
 * Each ecosystem (EVM, Solana, Native L1) implements this interface
 */
export interface ISwapExecutor {
  /**
   * Get executor name for logging and identification
   */
  getName(): string;

  /**
   * Check if this executor can handle the given route
   */
  canExecute(route: RouteQuote): boolean;

  /**
   * Validate execution prerequisites before executing
   * Returns validation errors if any
   */
  validate(context: ExecutionContext): Promise<string[]>;

  /**
   * Execute the swap transaction
   */
  execute(context: ExecutionContext): Promise<ExecutionResult>;

  /**
   * Monitor transaction confirmation
   */
  waitForConfirmation(
    transactionHash: string,
    chainId: number | string,
    requiredConfirmations?: number,
  ): Promise<any>;
}

/**
 * Validation step interface following Chain of Responsibility Pattern
 */
export interface IExecutionValidator {
  /**
   * Validate a specific aspect of the execution
   * Returns error message if validation fails, null if passes
   */
  validate(context: ExecutionContext): Promise<string | null>;

  /**
   * Set next validator in the chain
   */
  setNext(validator: IExecutionValidator): IExecutionValidator;
}
