import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  getAddress,
  isHex,
  formatEther,
  parseEther,
  formatUnits,
  parseUnits,
  type PublicClient,
  type WalletClient,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as https from 'https';
import axios from 'axios';

/**
 * Utility functions for Ethereum/EVM operations
 */

/**
 * Normalize token address to consistent format
 * - Converts to lowercase for API calls
 * - Optionally returns checksummed address for display
 * - Handles native token placeholder (0xEeee...)
 *
 * @param address Token address to normalize
 * @param useChecksum Whether to return checksummed address (default: false for API calls)
 * @returns Normalized address string
 */
export function normalizeTokenAddress(
  address: string,
  useChecksum: boolean = false,
): string {
  if (!address) return address;

  // Trim whitespace
  const trimmed = address.trim();

  // Handle native token placeholder (multiple formats)
  const nativePlaceholder = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  if (trimmed.toLowerCase() === nativePlaceholder) {
    return useChecksum ? trimmed : nativePlaceholder;
  }

  // Validate address format using viem's isAddress
  if (!isValidEVMAddress(trimmed)) {
    throw new Error(`Invalid Ethereum address format: ${trimmed}`);
  }

  // Return checksummed or lowercase based on preference
  if (useChecksum) {
    try {
      return getAddress(trimmed);
    } catch {
      // If checksum fails, return lowercase
      return trimmed.toLowerCase();
    }
  }

  return trimmed.toLowerCase();
}

/**
 * Validate EVM address (re-exported from viem for consistency)
 * Centralizes EVM address validation across the codebase
 */
export function isValidEVMAddress(address: string): boolean {
  return isAddress(address);
}

/**
 * Create custom HTTPS agent with relaxed SSL settings
 *
 * ⚠️ SECURITY WARNING:
 * This disables SSL certificate verification to work around SSL/TLS issues
 * with certain RPC providers (like QuickNode) that may have certificate problems.
 *
 * For production, you should:
 * 1. Use RPC providers with valid SSL certificates
 * 2. Set rejectUnauthorized: true
 * 3. Or use environment variable to control this behavior
 */
const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false,
  keepAlive: true,
  timeout: 30000,
  maxSockets: 50,
});

/**
 * Custom fetch function using axios to handle SSL issues
 */
async function customFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const response = await axios({
      url,
      method: init?.method || 'POST',
      data: init?.body,
      headers: init?.headers as any,
      httpsAgent,
      timeout: 30000,
    });

    // Convert axios response to fetch Response-like object
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers as any),
      json: async () => response.data,
      text: async () => JSON.stringify(response.data),
    } as Response;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Validate Ethereum address (alias for isValidEVMAddress)
 * @deprecated Use isValidEVMAddress for clarity
 */
export function isValidAddress(address: string): boolean {
  return isValidEVMAddress(address);
}

/**
 * Validate Ethereum transaction hash
 */
export function isValidTxHash(txHash: string): boolean {
  try {
    return isHex(txHash) && txHash.length === 66; // 0x + 64 hex chars
  } catch {
    return false;
  }
}

/**
 * Convert wei to ether
 */
export function weiToEther(wei: string | bigint): string {
  return formatEther(BigInt(wei));
}

/**
 * Convert ether to wei
 */
export function etherToWei(ether: string): bigint {
  return parseEther(ether);
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(
  amount: string | bigint,
  decimals: number,
): string {
  return formatUnits(BigInt(amount), decimals);
}

/**
 * Parse token amount to wei
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

/**
 * Calculate minimum return amount with slippage
 */
export function calculateMinReturn(
  expectedAmount: string | bigint,
  slippageBps: number,
): bigint {
  const expected = BigInt(expectedAmount);
  const slippageMultiplier = BigInt(10000 - slippageBps);
  return (expected * slippageMultiplier) / BigInt(10000);
}

/**
 * Calculate maximum input amount with slippage
 */
export function calculateMaxInput(
  expectedAmount: string | bigint,
  slippageBps: number,
): bigint {
  const expected = BigInt(expectedAmount);
  const slippageMultiplier = BigInt(10000 + slippageBps);
  return (expected * slippageMultiplier) / BigInt(10000);
}

/**
 * Get ERC-20 token ABI
 */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Approval',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Create public client for a given chain with custom fetch to handle SSL issues
 */
export function createProvider(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, {
      timeout: 30000,
      retryCount: 3,
      retryDelay: 1000,
      // Use custom fetch to handle SSL/TLS issues
      fetchOptions: {
        // @ts-ignore - viem types don't include custom fetch
        fetch: customFetch,
      },
    }),
  });
}

/**
 * Create wallet client from private key with custom fetch to handle SSL issues
 */
export function createWallet(privateKey: string, rpcUrl: string): WalletClient {
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({
    account,
    transport: http(rpcUrl, {
      timeout: 30000,
      retryCount: 3,
      retryDelay: 1000,
      // Use custom fetch to handle SSL/TLS issues
      fetchOptions: {
        // @ts-ignore - viem types don't include custom fetch
        fetch: customFetch,
      },
    }),
  });
}

/**
 * Estimate gas for a transaction
 */
export async function estimateGas(
  client: PublicClient,
  transaction: {
    account: Address;
    to: Address;
    data: Hex;
    value?: bigint;
  },
): Promise<bigint> {
  try {
    return await client.estimateGas(transaction);
  } catch (error) {
    throw new Error(`Gas estimation failed: ${error.message}`);
  }
}

/**
 * Get current gas price
 */
export async function getGasPrice(client: PublicClient): Promise<bigint> {
  try {
    return await client.getGasPrice();
  } catch (error) {
    throw new Error(`Failed to get gas price: ${error.message}`);
  }
}

/**
 * Wait for transaction confirmation with configurable parameters
 * Uses viem's waitForTransactionReceipt with proper retry and polling settings
 */
export async function waitForTransaction(
  client: PublicClient,
  txHash: Hex,
  confirmations: number = 1,
  options?: {
    timeout?: number;
    pollingInterval?: number;
    retryCount?: number;
    retryDelay?: number | ((config: { count: number; error: Error }) => number);
  },
): Promise<TransactionReceipt> {
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      confirmations,
      // Cross-chain bridge transactions can take longer than default timeout (180s)
      timeout: options?.timeout ?? 300_000, // Default: 5 minutes for cross-chain transactions
      pollingInterval: options?.pollingInterval ?? 4_000, // Default: 4 seconds (standard block time)
      retryCount: options?.retryCount ?? 6, // Default: 6 retries
      retryDelay: options?.retryDelay ?? (({ count }) => ~~(1 << count) * 1000), // Exponential backoff
    });
    return receipt;
  } catch (error) {
    throw new Error(`Transaction confirmation failed: ${error.message}`);
  }
}

/**
 * Parse transaction receipt for token transfers
 */
export function parseTokenTransfers(
  receipt: TransactionReceipt,
  tokenAddress: string,
): Array<{ from: string; to: string; amount: bigint }> {
  const transfers: Array<{ from: string; to: string; amount: bigint }> = [];

  // Find Transfer event signature
  const transferEventSignature =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  for (const log of receipt.logs) {
    try {
      // Check if this is a Transfer event for the specific token
      if (
        log.address.toLowerCase() === tokenAddress.toLowerCase() &&
        log.topics[0] === transferEventSignature &&
        log.topics.length >= 3
      ) {
        const from = `0x${log.topics[1]?.slice(26)}`;
        const to = `0x${log.topics[2]?.slice(26)}`;
        const amount = BigInt(log.data);

        transfers.push({
          from,
          to,
          amount,
        });
      }
    } catch {
      // Skip logs that don't match ERC-20 Transfer event
    }
  }

  return transfers;
}
