import {
  isValidEVMAddress,
  isValidSolanaAddress,
  isValidBitcoinAddress,
  isValidTronAddress,
  isValidLitecoinAddress,
  validateRecipientAddress as validateRecipient,
} from './token-address-validation.utils';
import { isChainSupported } from './chain.utils';

/**
 * Validation utility functions
 *
 * Note: Address validation has been centralized in token-address-validation.utils.ts
 * This file now delegates to that module for consistency and maintainability
 */

/**
 * Validate chain ID
 */
export function validateChainId(chainId: number): void {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('Chain ID must be a positive integer');
  }

  if (!isChainSupported(chainId)) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/**
 * Validate token address (EVM only)
 * For multi-chain support, use token-address-validation.utils.ts
 */
export function validateTokenAddress(tokenAddress: string): void {
  if (!tokenAddress || typeof tokenAddress !== 'string') {
    throw new Error('Token address is required');
  }

  if (!isValidEVMAddress(tokenAddress)) {
    throw new Error('Invalid token address format');
  }
}

/**
 * Validate wallet address (EVM only)
 * For multi-chain support, use token-address-validation.utils.ts
 */
export function validateWalletAddress(walletAddress: string): void {
  if (!walletAddress || typeof walletAddress !== 'string') {
    throw new Error('Wallet address is required');
  }

  if (!isValidEVMAddress(walletAddress)) {
    throw new Error(`Invalid wallet address format ${walletAddress}`);
  }
}

/**
 * Re-export address validation functions from centralized module
 * Provides backward compatibility while directing to single source of truth
 */
export {
  isValidEVMAddress,
  isValidSolanaAddress,
  isValidBitcoinAddress,
  isValidTronAddress,
  isValidLitecoinAddress,
};

/**
 * Validate recipient address based on destination ecosystem/chain
 * Delegates to centralized validation module
 */
export function validateRecipientAddress(
  ecosystem: string,
  chainId: number | string,
  recipient: string,
): void {
  validateRecipient(ecosystem, chainId, recipient);
}

/**
 * Validate amount
 */
export function validateAmount(amount: string | number): void {
  if (!amount && amount !== 0) {
    throw new Error('Amount is required');
  }

  const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;

  if (isNaN(numAmount) || !isFinite(numAmount)) {
    throw new Error('Amount must be a valid number');
  }

  if (numAmount <= 0) {
    throw new Error('Amount must be greater than zero');
  }
}

/**
 * Validate slippage percentage
 */
export function validateSlippage(slippage: number): void {
  if (typeof slippage !== 'number') {
    throw new Error('Slippage must be a number');
  }

  if (slippage < 0 || slippage > 50) {
    throw new Error('Slippage must be between 0 and 50 percent');
  }
}

/**
 * Validate deadline (timestamp in seconds)
 */
export function validateDeadline(deadline: number): void {
  if (!Number.isInteger(deadline) || deadline <= 0) {
    throw new Error(
      'Deadline must be a positive integer (timestamp in seconds)',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) {
    throw new Error('Deadline must be in the future');
  }

  // Maximum deadline of 1 hour from now
  const maxDeadline = now + 3600;
  if (deadline > maxDeadline) {
    throw new Error('Deadline cannot be more than 1 hour in the future');
  }
}

/**
 * Validate transaction hash
 */
export function validateTransactionHash(txHash: string): void {
  if (!txHash || typeof txHash !== 'string') {
    throw new Error('Transaction hash is required');
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error('Invalid transaction hash format');
  }
}

/**
 * Sanitize and validate input string
 */
export function sanitizeString(
  input: string,
  maxLength: number = 1000,
): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }

  const sanitized = input.trim();
  if (sanitized.length === 0) {
    throw new Error('Input cannot be empty');
  }

  if (sanitized.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength} characters`);
  }

  return sanitized;
}

/**
 * Validate private key format
 */
export function validatePrivateKey(privateKey: string): void {
  if (!privateKey || typeof privateKey !== 'string') {
    throw new Error('Private key is required');
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('Invalid private key format');
  }
}
