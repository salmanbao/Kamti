import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

/**
 * Symbiosis Transaction Status Handler
 *
 * Handles all transaction statuses returned by Symbiosis /v2/tx/{chainId}/{transactionHash} endpoint
 *
 * ⚠️ CRITICAL LIMITATION:
 * The Symbiosis status endpoint does NOT return the destination chain transaction hash.
 * The API returns:
 * - status: Operation status code
 * - tx: Token information (expected on destination)
 * - txIn: Source chain transaction info
 * - transitTokenSent: Bridge transfer information
 *
 * But NO destination transaction hash is provided by Symbiosis API.
 *
 * To track destination transactions:
 * 1. Use Symbiosis SDK for complete tracking
 * 2. Query destination chain using bridge contract events
 * 3. Monitor destination chain wallet for token receipt
 * 4. Use destination chain explorers with expected token/wallet
 *
 * Status Codes (from Symbiosis API):
 * - (-1): NOT_FOUND - The transaction was not found
 * - (1): PENDING - The source transaction is pending confirmation
 * - (0): SUCCESS - The operation was successfully processed (source chain only)
 * - (2): STUCK - The operation is stuck
 * - (3): REVERTED - The operation was reverted
 *
 * @see https://docs.symbiosis.finance/developer-tools/symbiosis-api
 */
@Injectable()
export class SymbiosisStatusHandler {
  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.winstonLogger.setContext('SymbiosisStatusHandler');
  }

  /**
   * Status code enum for type safety
   */
  static readonly STATUS_CODES = {
    NOT_FOUND: -1,
    SUCCESS: 0,
    PENDING: 1,
    STUCK: 2,
    REVERTED: 3,
  } as const;

  /**
   * Human-readable status names
   */
  static readonly STATUS_NAMES: Record<number, string> = {
    [-1]: 'NOT_FOUND',
    [0]: 'SUCCESS',
    [1]: 'PENDING',
    [2]: 'STUCK',
    [3]: 'REVERTED',
  };

  /**
   * Handle Symbiosis transaction status and determine next action
   *
   * @param statusCode The status code from Symbiosis API
   * @param txData The full transaction response from Symbiosis
   * @param chainId The source chain ID
   * @param transactionHash The source transaction hash
   *
   * @returns Object with status, action, and handling instructions
   */
  handleTransactionStatus(
    statusCode: number,
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    const statusName =
      SymbiosisStatusHandler.STATUS_NAMES[statusCode] || 'UNKNOWN';

    this.winstonLogger.debug(
      `📊 Symbiosis transaction status check | tx=${transactionHash} | chain=${chainId} | status=${statusName}(${statusCode})`,
    );

    switch (statusCode) {
      case SymbiosisStatusHandler.STATUS_CODES.SUCCESS:
        return this.handleSuccess(txData, chainId, transactionHash);

      case SymbiosisStatusHandler.STATUS_CODES.PENDING:
        return this.handlePending(txData, chainId, transactionHash);

      case SymbiosisStatusHandler.STATUS_CODES.STUCK:
        return this.handleStuck(txData, chainId, transactionHash);

      case SymbiosisStatusHandler.STATUS_CODES.REVERTED:
        return this.handleReverted(txData, chainId, transactionHash);

      case SymbiosisStatusHandler.STATUS_CODES.NOT_FOUND:
        return this.handleNotFound(txData, chainId, transactionHash);

      default:
        return this.handleUnknown(statusCode, chainId, transactionHash);
    }
  }

  /**
   * Handle SUCCESS status (0)
   * Cross-chain operation completed successfully
   * NOTE: Symbiosis /v2/tx endpoint does NOT return destination transaction hash
   * The API only returns source chain transaction details (txIn, tx, transitTokenSent)
   * To get destination TX, you must:
   * 1. Wait for the relay to complete on destination chain
   * 2. Query destination chain using bridge contract events
   * 3. Use Symbiosis SDK to track the cross-chain operation
   *
   * The status code reaching SUCCESS (0) confirms:
   * - Source transaction was executed
   * - Bridge received the transit tokens
   * - Destination swap should be processing
   */
  private handleSuccess(
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.log(
      `✅ Symbiosis cross-chain operation SUCCESSFUL | tx=${transactionHash}`,
    );

    // Extract source transaction details from txData
    const sourceTxInfo = txData?.txIn; // User's source chain transaction
    const transitTokenInfo = txData?.transitTokenSent; // Token sent to bridge
    const destinationTokenInfo = txData?.tx; // Token expected on destination (but no TX hash returned)

    // Audit log the success
    this.winstonLogger.audit('SYMBIOSIS_SWAP_SUCCESS', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      sourceTokenAmount: sourceTxInfo?.tokenAmount?.amount,
      transitTokenAmount: transitTokenInfo?.amount,
      expectedDestinationToken: destinationTokenInfo?.tokenAmount?.symbol,
      expectedDestinationChain: destinationTokenInfo?.tokenAmount?.chainId,
      note: 'Destination TX hash not available from Symbiosis API - use SDK or chain events',
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: SymbiosisStatusHandler.STATUS_CODES.SUCCESS,
      statusName: 'SUCCESS',
      isTerminal: true,
      action: 'COMPLETE',
      message:
        'Cross-chain swap completed successfully on source chain - destination transaction requires separate tracking',
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        sourceTokenAmount: sourceTxInfo?.tokenAmount?.amount,
        sourceTokenSymbol: sourceTxInfo?.tokenAmount?.symbol,
        transitTokenAmount: transitTokenInfo?.amount,
        transitTokenChain: transitTokenInfo?.chainId,
        expectedDestinationToken: destinationTokenInfo?.tokenAmount?.symbol,
        expectedDestinationChain: destinationTokenInfo?.tokenAmount?.chainId,
        // NOTE: Destination TX hash is NOT available from Symbiosis API
        destinationTx: null,
        requiresDestinationTracking: true,
        trackingNote:
          'Use Symbiosis SDK, bridge contract events, or destination chain explorer to track final swap',
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Handle PENDING status (1)
   * Source transaction is pending confirmation on source blockchain
   * Operation has NOT yet been relayed to destination
   * User should wait for confirmation
   */
  private handlePending(
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.log(
      `⏳ Symbiosis cross-chain operation PENDING | tx=${transactionHash} | waiting for confirmation on source chain`,
    );

    this.winstonLogger.audit('SYMBIOSIS_SWAP_PENDING', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      reason: 'Source transaction pending confirmation',
      recommendedRetryAfter: '30-60 seconds',
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: SymbiosisStatusHandler.STATUS_CODES.PENDING,
      statusName: 'PENDING',
      isTerminal: false,
      action: 'WAIT_AND_RETRY',
      message:
        'Cross-chain operation pending - source transaction awaiting confirmation',
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        expectedConfirmationTime: '30-60 seconds',
        recommendedRetryDelay: 30000, // 30 seconds
        nextCheckTime: new Date(Date.now() + 30000),
      },
    };
  }

  /**
   * Handle STUCK status (2)
   * Cross-chain operation is stuck and requires manual intervention
   * May need to trigger a revert/unstick operation
   * This is NOT automatically recoverable
   */
  private handleStuck(
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.error(
      `⚠️ Symbiosis cross-chain operation STUCK | tx=${transactionHash} | requires manual intervention`,
    );

    // Audit log for operations team
    this.winstonLogger.audit('SYMBIOSIS_SWAP_STUCK', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      severity: 'HIGH',
      action: 'MANUAL_REVIEW_REQUIRED',
      reason: 'Cross-chain operation appears stuck',
      userNotification:
        'Your swap is taking longer than expected. Our team has been notified and is investigating.',
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: SymbiosisStatusHandler.STATUS_CODES.STUCK,
      statusName: 'STUCK',
      isTerminal: false,
      action: 'MANUAL_REVIEW',
      message:
        'Cross-chain operation stuck - manual intervention may be required',
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        userAction: 'Please contact support',
        supportUrl: 'https://support.example.com/symbiosis-stuck',
        ticketId: `SYMBIOSIS_STUCK_${transactionHash}`,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Handle REVERTED status (3)
   * Cross-chain operation was reverted (either source or destination failed)
   * Funds should have been returned to user on source chain
   * This is a terminal failure state
   */
  private handleReverted(
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.error(
      `❌ Symbiosis cross-chain operation REVERTED | tx=${transactionHash}`,
    );

    this.winstonLogger.audit('SYMBIOSIS_SWAP_REVERTED', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      reason: 'Cross-chain operation reverted',
      expectedAction: 'Funds returned to user source address',
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: SymbiosisStatusHandler.STATUS_CODES.REVERTED,
      statusName: 'REVERTED',
      isTerminal: true,
      action: 'FAILED',
      message:
        'Cross-chain swap reverted - funds should be returned to your wallet',
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        userAction: 'Check your wallet for returned funds',
        expectedRefund: txData?.tx?.tokenAmount?.amount,
        refundChain: chainId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Handle NOT_FOUND status (-1)
   * Transaction was not found in Symbiosis system
   * May indicate:
   * 1. Transaction not yet indexed/processed by Symbiosis
   * 2. Transaction hash is invalid
   * 3. Chain ID mismatch
   */
  private handleNotFound(
    txData: any,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.warn(
      `❓ Symbiosis transaction NOT FOUND | tx=${transactionHash} | chain=${chainId}`,
    );

    this.winstonLogger.audit('SYMBIOSIS_SWAP_NOT_FOUND', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      reason: 'Transaction not found in Symbiosis system',
      possibleReasons: [
        'Transaction not yet indexed',
        'Invalid transaction hash',
        'Chain ID mismatch',
        'Transaction has not been finalized',
      ],
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: SymbiosisStatusHandler.STATUS_CODES.NOT_FOUND,
      statusName: 'NOT_FOUND',
      isTerminal: false,
      action: 'RETRY',
      message: 'Transaction not found - may not be indexed yet',
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        userAction: 'Please wait a few moments and try again',
        recommendedRetryDelay: 60000, // 60 seconds
        nextCheckTime: new Date(Date.now() + 60000),
        possibleIssues: [
          'Transaction not yet finalized',
          'Chain ID mismatch',
          'Invalid transaction hash',
        ],
      },
    };
  }

  /**
   * Handle UNKNOWN status
   * Received an unexpected status code
   */
  private handleUnknown(
    statusCode: number,
    chainId: number | string,
    transactionHash: string,
  ): SymbiosisStatusResponse {
    this.winstonLogger.error(
      `🔴 Symbiosis transaction received UNKNOWN status | tx=${transactionHash} | status=${statusCode}`,
    );

    this.winstonLogger.audit('SYMBIOSIS_SWAP_UNKNOWN_STATUS', {
      sourceChain: chainId,
      sourceTx: transactionHash,
      unknownStatus: statusCode,
      severity: 'MEDIUM',
      action: 'INVESTIGATE',
      timestamp: new Date().toISOString(),
    });

    return {
      statusCode: statusCode,
      statusName: 'UNKNOWN',
      isTerminal: false,
      action: 'INVESTIGATE',
      message: `Received unexpected status code: ${statusCode}`,
      details: {
        sourceTx: transactionHash,
        sourceChain: chainId,
        statusCode: statusCode,
        userAction: 'Contact support if issue persists',
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Determine if a transaction status is terminal (no further retries needed)
   */
  isTerminalStatus(statusCode: number): boolean {
    return (
      statusCode === SymbiosisStatusHandler.STATUS_CODES.SUCCESS ||
      statusCode === SymbiosisStatusHandler.STATUS_CODES.REVERTED
    );
  }

  /**
   * Determine if a transaction status indicates failure
   */
  isFailureStatus(statusCode: number): boolean {
    return (
      statusCode === SymbiosisStatusHandler.STATUS_CODES.REVERTED ||
      statusCode === SymbiosisStatusHandler.STATUS_CODES.STUCK
    );
  }

  /**
   * Get recommended retry delay for a status (in milliseconds)
   */
  getRecommendedRetryDelay(statusCode: number): number {
    switch (statusCode) {
      case SymbiosisStatusHandler.STATUS_CODES.PENDING:
        return 30000; // 30 seconds
      case SymbiosisStatusHandler.STATUS_CODES.NOT_FOUND:
        return 60000; // 60 seconds
      case SymbiosisStatusHandler.STATUS_CODES.STUCK:
      case SymbiosisStatusHandler.STATUS_CODES.REVERTED:
      case SymbiosisStatusHandler.STATUS_CODES.SUCCESS:
        return 0; // No retry needed
      default:
        return 30000; // Default: 30 seconds
    }
  }
}

/**
 * Response type for status handling
 */
export interface SymbiosisStatusResponse {
  statusCode: number;
  statusName: string;
  isTerminal: boolean;
  action:
    | 'COMPLETE'
    | 'WAIT_AND_RETRY'
    | 'MANUAL_REVIEW'
    | 'FAILED'
    | 'RETRY'
    | 'INVESTIGATE';
  message: string;
  details: {
    [key: string]: any;
  };
}
