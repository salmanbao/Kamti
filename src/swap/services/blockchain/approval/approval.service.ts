import { Injectable, BadRequestException } from '@nestjs/common';
import { WalletService } from '@swap/services/blockchain/wallet/wallet.service';
import { AggregatorManagerService } from '@swap/services/core/aggregation/aggregator-manager.service';
import {
  ApprovalResult,
  AggregatorType,
} from '@swap/models/swap-request.model';
import { isNativeToken } from '@shared/utils/chain.utils';
import {
  validatePrivateKey,
  validateTokenAddress,
  validateWalletAddress,
} from '@shared/utils/validation.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { formatUnits, maxUint256, parseUnits } from 'viem';
import { detectEcosystemFromChainId } from '@config/swap-config';

/**
 * Approval service for handling ERC-20 token approvals
 */
@Injectable()
export class ApprovalService {
  // Configuration: Approve extra tokens to reduce approval frequency
  private readonly EXTRA_APPROVAL_TOKENS = '10'; // Approve 10 additional tokens

  private isTronChain(chainId: number): boolean {
    return chainId === 195;
  }

  private getEcosystem(chainId: number): string {
    return detectEcosystemFromChainId(chainId);
  }

  private isTronBase58Address(address: string): boolean {
    return (
      typeof address === 'string' &&
      address.startsWith('T') &&
      address.length === 34
    );
  }

  private validateWalletAddressForChain(
    chainId: number,
    address: string,
    fieldName: string,
  ): void {
    if (this.isTronChain(chainId)) {
      if (!this.isTronBase58Address(address)) {
        throw new Error(`Invalid Tron address for ${fieldName}`);
      }
      return;
    }

    validateWalletAddress(address);
  }

  private validateTokenAddressForChain(
    chainId: number,
    tokenAddress: string,
  ): void {
    if (this.isTronChain(chainId)) {
      // TRC20 contract address is also a base58 Tron address (starts with 'T')
      if (!this.isTronBase58Address(tokenAddress)) {
        throw new Error('Invalid TRC20 token address');
      }
      return;
    }

    validateTokenAddress(tokenAddress);
  }

  constructor(
    private readonly walletService: WalletService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.winstonLogger.setContext('ApprovalService');
  }

  /**
   * Calculate approval amount with extra buffer
   * Adds 10 tokens (in token's native decimals) to reduce approval frequency
   *
   * @param requiredAmount - The minimum required amount in wei/smallest unit
   * @param tokenDecimals - Token decimals (e.g., 18 for most ERC20, 6 for USDC)
   * @returns Approval amount with 10 extra tokens added
   */
  private calculateApprovalAmountWithBuffer(
    requiredAmount: string,
    tokenDecimals: number,
  ): string {
    try {
      const requiredAmountBigInt = BigInt(requiredAmount);

      // Calculate 10 tokens in the smallest unit (wei equivalent)
      // Example: For USDC (6 decimals), 10 tokens = 10 * 10^6 = 10,000,000
      // Example: For ETH-like tokens (18 decimals), 10 tokens = 10 * 10^18
      const extraTokensInSmallestUnit = parseUnits(
        this.EXTRA_APPROVAL_TOKENS,
        tokenDecimals,
      );

      // Add buffer to required amount
      const approvalAmount = requiredAmountBigInt + extraTokensInSmallestUnit;

      this.winstonLogger.log(
        `💰 Approval buffer calculation: ` +
          `Required: ${formatUnits(BigInt(requiredAmount), tokenDecimals)} (${requiredAmount} wei), ` + // Convert to token decimals for logging(requiredAmount)}, ` +
          `Extra: ${formatUnits(extraTokensInSmallestUnit, tokenDecimals)} tokens), ` +
          `Total: ${formatUnits(approvalAmount, tokenDecimals)}`,
      );

      return approvalAmount.toString();
    } catch (error) {
      this.winstonLogger.warn(
        `Failed to calculate approval buffer: ${error.message}. ` +
          `Falling back to required amount only.`,
      );
      return requiredAmount; // Fallback to required amount if calculation fails
    }
  }

  /**
   * Check if approval is needed for ERC-20 tokens
   */
  async isApprovalNeeded(
    chainId: number,
    tokenAddress: string,
    owner: string,
    spender: string,
    amount: string,
  ): Promise<boolean> {
    try {
      const ecosystem = this.getEcosystem(chainId);

      // Solana/Bitcoin do not use ERC20-style allowances. Swaps are authorized
      // by signing the swap transaction itself.
      if (ecosystem === 'solana' || ecosystem === 'bitcoin') {
        this.winstonLogger.debug(
          `Skipping approval check for ecosystem without allowances: ${ecosystem}`,
        );
        return false;
      }

      if (isNativeToken(tokenAddress)) {
        return false; // Native tokens don't need approval
      }

      // Check traditional ERC-20 approval
      const currentAllowance = await this.walletService.getAllowance(
        chainId,
        tokenAddress,
        owner,
        spender,
      );

      const requiredAmount = BigInt(amount);
      const currentAllowanceBigInt = BigInt(currentAllowance);
      const isNeeded = currentAllowanceBigInt < requiredAmount;
      this.winstonLogger.log(
        `✅ Approval needed check: Current allowance ${currentAllowance} vs Required ${amount} => isNeeded: ${isNeeded}`,
      );
      // Audit log approval check
      this.winstonLogger.audit('APPROVAL_CHECK', {
        chainId,
        tokenAddress,
        owner,
        spender,
        requiredAmount: amount,
        currentAllowance,
        isApprovalNeeded: isNeeded,
        timestamp: new Date().toISOString(),
      });

      return isNeeded;
    } catch (error) {
      this.winstonLogger.error(
        `Failed to check approval status: ${error.message}`,
        error.stack,
      );

      // Check if it's a validation error
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to check approval status: ${error.message}`);
    }
  }

  /**
   * Get approval status
   */
  async getApprovalStatus(
    chainId: number,
    tokenAddress: string,
    owner: string,
    spender: string,
    amount?: string,
  ): Promise<{
    currentAllowance: string;
    isApprovalNeeded: boolean;
    tokenInfo: any;
  }> {
    const startTime = Date.now();

    try {
      const ecosystem = this.getEcosystem(chainId);

      // Validate inputs
      if (!chainId || chainId <= 0) {
        throw new Error('Invalid chain ID');
      }

      // Solana/Bitcoin do not use ERC20-style allowances.
      if (ecosystem === 'solana' || ecosystem === 'bitcoin') {
        const duration = Date.now() - startTime;

        this.winstonLogger.audit('APPROVAL_STATUS_CHECK', {
          chainId,
          tokenAddress,
          owner,
          spender,
          ecosystem,
          isNativeToken: false,
          isApprovalNeeded: false,
          duration,
          timestamp: new Date().toISOString(),
        });

        return {
          currentAllowance: '0',
          isApprovalNeeded: false,
          tokenInfo: null,
        };
      }

      this.validateTokenAddressForChain(chainId, tokenAddress);
      this.validateWalletAddressForChain(chainId, owner, 'owner');
      this.validateWalletAddressForChain(chainId, spender, 'spender');

      // Native tokens don't need approval
      if (isNativeToken(tokenAddress)) {
        const duration = Date.now() - startTime;

        // Audit log native token status check
        this.winstonLogger.audit('APPROVAL_STATUS_CHECK', {
          chainId,
          tokenAddress,
          owner,
          spender,
          isNativeToken: true,
          isApprovalNeeded: false,
          duration,
          timestamp: new Date().toISOString(),
        });

        return {
          currentAllowance: '0',
          isApprovalNeeded: false,
          tokenInfo: null,
        };
      }

      const [currentAllowance, tokenInfo] = await Promise.all([
        this.walletService.getAllowance(chainId, tokenAddress, owner, spender),
        this.walletService.getTokenInfo(chainId, tokenAddress),
      ]);

      // Determine if approval is needed
      let isApprovalNeeded = false;

      if (amount) {
        // If amount is provided, check if current allowance is sufficient
        const requiredAmount = BigInt(amount);
        const currentAllowanceBigInt = BigInt(currentAllowance);
        isApprovalNeeded = currentAllowanceBigInt < requiredAmount;
      } else {
        // If no amount provided, approval is needed if allowance is 0
        isApprovalNeeded = BigInt(currentAllowance) === BigInt(0);
      }

      const duration = Date.now() - startTime;

      // Audit log approval status check
      this.winstonLogger.audit('APPROVAL_STATUS_CHECK', {
        chainId,
        tokenAddress,
        owner,
        spender,
        currentAllowance,
        requiredAmount: amount || 'not_specified',
        isApprovalNeeded,
        tokenSymbol: tokenInfo?.symbol,
        tokenDecimals: tokenInfo?.decimals,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        currentAllowance,
        isApprovalNeeded,
        tokenInfo,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log status check failure
      this.winstonLogger.audit('APPROVAL_STATUS_CHECK_FAILED', {
        chainId,
        tokenAddress,
        owner,
        spender,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to get approval status: ${error.message}`,
        error.stack,
      );

      // Check if it's a validation error
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to get approval status: ${error.message}`);
    }
  }

  /**
   * Execute approval transaction
   * Automatically approves 10 extra tokens beyond the required amount to reduce approval frequency
   */
  async executeApproval(
    chainId: number,
    privateKey: string,
    tokenAddress: string,
    spender: string,
    amount: string,
  ): Promise<ApprovalResult> {
    const startTime = Date.now();

    try {
      const ecosystem = this.getEcosystem(chainId);

      // Solana/Bitcoin do not use ERC20-style approvals.
      if (ecosystem === 'solana' || ecosystem === 'bitcoin') {
        throw new BadRequestException(
          `Token approvals are not supported for ecosystem '${ecosystem}'. ` +
            'On these chains, swaps are authorized by signing the swap transaction itself.',
        );
      }

      validatePrivateKey(privateKey);
      this.validateTokenAddressForChain(chainId, tokenAddress);
      this.validateWalletAddressForChain(chainId, spender, 'spender');

      if (isNativeToken(tokenAddress)) {
        throw new Error('Cannot approve native token');
      }

      // Get token info to determine decimals for buffer calculation
      let approvalAmount = amount;
      let actualApprovedAmount = amount;

      // Only add buffer for non-zero approvals (not for revocations)
      if (BigInt(amount) > BigInt(0)) {
        try {
          const tokenInfo = await this.walletService.getTokenInfo(
            chainId,
            tokenAddress,
          );

          if (tokenInfo?.decimals) {
            approvalAmount = this.calculateApprovalAmountWithBuffer(
              amount,
              tokenInfo.decimals,
            );
            actualApprovedAmount = approvalAmount;

            this.winstonLogger.log(
              `✅ Approval buffer applied for ${tokenInfo.symbol || tokenAddress}: ` +
                `Requested: ${amount}, Approving: ${approvalAmount} ` +
                `(+${this.EXTRA_APPROVAL_TOKENS} tokens buffer)`,
            );
          } else {
            this.winstonLogger.warn(
              `Token decimals not available for ${tokenAddress}. ` +
                `Approving exact amount without buffer.`,
            );
          }
        } catch (tokenInfoError) {
          this.winstonLogger.warn(
            `Failed to fetch token info for ${tokenAddress}: ${tokenInfoError.message}. ` +
              `Approving exact amount without buffer.`,
          );
        }
      }

      const txHash = await this.walletService.executeApproval(
        chainId,
        privateKey,
        tokenAddress,
        spender,
        maxUint256.toString(), // Use calculated amount with buffer
      );

      const duration = Date.now() - startTime;

      // Audit log approval execution
      this.winstonLogger.audit('APPROVAL_EXECUTED', {
        chainId,
        transactionHash: txHash,
        tokenAddress,
        spender,
        requestedAmount: amount,
        actualApprovedAmount,
        extraTokensBuffer:
          BigInt(amount) > BigInt(0) ? this.EXTRA_APPROVAL_TOKENS : 0,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.log(`Approval transaction executed: ${txHash}`);

      return {
        transactionHash: txHash,
        tokenAddress,
        spender,
        amount: actualApprovedAmount, // Return actual approved amount
        timestamp: Date.now(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log approval failure
      this.winstonLogger.audit('APPROVAL_FAILED', {
        chainId,
        tokenAddress,
        spender,
        amount,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to execute approval: ${error.message}`,
        error.stack,
      );

      // Check if it's a validation error
      if (this.isValidationError(error)) {
        throw new BadRequestException(error.message);
      }

      throw new Error(`Failed to execute approval: ${error.message}`);
    }
  }

  /**
   * Get spender address for aggregator
   */
  async getSpenderAddress(
    chainId: number,
    aggregatorType: AggregatorType,
  ): Promise<string> {
    try {
      return await this.aggregatorManager.getSpenderAddress(
        chainId,
        aggregatorType,
      );
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get spender address: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to get spender address: ${error.message}`);
    }
  }

  /**
   * Prepare approval for swap
   * Returns approval amount with 10 extra tokens buffer
   */
  async prepareApprovalForSwap(
    chainId: number,
    tokenAddress: string,
    owner: string,
    aggregatorType: AggregatorType,
    amount: string,
  ): Promise<{
    isApprovalNeeded: boolean;
    spenderAddress: string;
    currentAllowance: string;
    approvalAmount: string;
  }> {
    const startTime = Date.now();

    try {
      if (isNativeToken(tokenAddress)) {
        const duration = Date.now() - startTime;

        // Audit log native token preparation
        this.winstonLogger.audit('APPROVAL_PREPARED_FOR_SWAP', {
          chainId,
          tokenAddress,
          owner,
          aggregatorType,
          isNativeToken: true,
          isApprovalNeeded: false,
          duration,
          timestamp: new Date().toISOString(),
        });

        return {
          isApprovalNeeded: false,
          spenderAddress: '',
          currentAllowance: '0',
          approvalAmount: '0',
        };
      }

      const spenderAddress = await this.getSpenderAddress(
        chainId,
        aggregatorType,
      );
      const currentAllowance = await this.walletService.getAllowance(
        chainId,
        tokenAddress,
        owner,
        spenderAddress,
      );

      const isApprovalNeeded = BigInt(currentAllowance) < BigInt(amount);

      // Calculate approval amount with buffer
      let approvalAmount = amount;
      if (isApprovalNeeded) {
        try {
          const tokenInfo = await this.walletService.getTokenInfo(
            chainId,
            tokenAddress,
          );

          if (tokenInfo?.decimals) {
            approvalAmount = this.calculateApprovalAmountWithBuffer(
              amount,
              tokenInfo.decimals,
            );

            this.winstonLogger.log(
              `📋 Preparing approval for ${tokenInfo.symbol || tokenAddress}: ` +
                `Required: ${amount}, Will approve: ${approvalAmount} ` +
                `(+${this.EXTRA_APPROVAL_TOKENS} tokens buffer)`,
            );
          }
        } catch (tokenInfoError) {
          this.winstonLogger.warn(
            `Failed to fetch token info during preparation: ${tokenInfoError.message}. ` +
              `Will approve exact amount.`,
          );
        }
      }

      const duration = Date.now() - startTime;

      // Audit log approval preparation
      this.winstonLogger.audit('APPROVAL_PREPARED_FOR_SWAP', {
        chainId,
        tokenAddress,
        owner,
        spenderAddress,
        aggregatorType,
        currentAllowance,
        requiredAmount: amount,
        approvalAmountWithBuffer: approvalAmount,
        extraTokensBuffer: isApprovalNeeded ? this.EXTRA_APPROVAL_TOKENS : 0,
        isApprovalNeeded,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        isApprovalNeeded,
        spenderAddress,
        currentAllowance,
        approvalAmount, // Return amount with buffer
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log preparation failure
      this.winstonLogger.audit('APPROVAL_PREPARATION_FAILED', {
        chainId,
        tokenAddress,
        owner,
        aggregatorType,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Failed to prepare approval for swap: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to prepare approval for swap: ${error.message}`);
    }
  }

  /**
   * Revoke approval (set to 0)
   */
  async revokeApproval(
    chainId: number,
    privateKey: string,
    tokenAddress: string,
    spender: string,
  ): Promise<ApprovalResult> {
    try {
      return await this.executeApproval(
        chainId,
        privateKey,
        tokenAddress,
        spender,
        '0',
      );
    } catch (error) {
      this.winstonLogger.error(
        `Failed to revoke approval: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to revoke approval: ${error.message}`);
    }
  }

  /**
   * Get approval transaction status
   */
  async getApprovalTransactionStatus(
    chainId: number,
    txHash: string,
  ): Promise<{
    status: 'pending' | 'confirmed' | 'failed';
    receipt?: any;
  }> {
    try {
      return await this.walletService.getTransactionStatus(chainId, txHash);
    } catch (error) {
      this.winstonLogger.error(
        `Failed to get approval transaction status: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to get approval transaction status: ${error.message}`,
      );
    }
  }

  /**
   * Wait for approval transaction confirmation
   */
  async waitForApprovalConfirmation(
    chainId: number,
    txHash: string,
    confirmations: number = 1,
  ): Promise<any> {
    try {
      return await this.walletService.waitForTransactionConfirmation(
        chainId,
        txHash,
        confirmations,
      );
    } catch (error) {
      this.winstonLogger.error(
        `Failed to wait for approval confirmation: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to wait for approval confirmation: ${error.message}`,
      );
    }
  }

  /**
   * Check if an error is a validation error (should return 400 status)
   */
  private isValidationError(error: any): boolean {
    const validationErrorMessages = [
      'Invalid chain ID',
      'Invalid token address',
      'Invalid wallet address',
      'Invalid private key',
      'Cannot approve native token',
      'Cannot create Permit2 signature for native token',
      'Permit2 not supported',
      'not Permit2 compatible',
    ];

    return validationErrorMessages.some((msg) => error?.message?.includes(msg));
  }
}
