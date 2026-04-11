/**
 * Token Address Validation Utilities
 * Centralized validation for blockchain addresses across all ecosystems
 *
 * Architecture: Single source of truth for address validation
 * Security: Prevents invalid addresses from causing runtime errors or lost funds
 * Supports: EVM, Solana, Tron, Bitcoin, Litecoin
 */

import TronWeb from 'tronweb';
import { isAddress as viemIsAddress } from 'viem';
import { BlockchainEcosystem } from '@swap/dto/universal-swap-request.dto';
import { PublicKey } from '@solana/web3.js';
import * as bitcoinjs from 'bitcoinjs-lib';
import bs58 from 'bs58';
import { bech32, bech32m } from 'bech32';
// ==================== ECOSYSTEM DETECTION & CHAIN HELPERS ====================

export function getEcosystemFromChainId(
  chainId: number | string,
): BlockchainEcosystem | 'bitcoin' | 'litecoin' {
  const chainIdStr = chainId.toString().toLowerCase();

  // Solana
  if (
    chainIdStr === 'solana-mainnet' ||
    chainIdStr === 'solana' ||
    chainIdStr === 'sol' ||
    chainIdStr === '7565164' ||
    chainIdStr === '1399811149'
  ) {
    return BlockchainEcosystem.SOLANA;
  }

  // Tron
  if (
    chainIdStr === 'tron-mainnet' ||
    chainIdStr === 'tron' ||
    chainIdStr === 'trx' ||
    chainIdStr === '195'
  ) {
    return BlockchainEcosystem.TRON;
  }

  // Bitcoin
  if (
    chainIdStr === 'bitcoin-mainnet' ||
    chainIdStr === 'bitcoin' ||
    chainIdStr === 'btc'
  ) {
    return 'bitcoin';
  }

  // Litecoin
  if (
    chainIdStr === 'litecoin-mainnet' ||
    chainIdStr === 'litecoin' ||
    chainIdStr === 'ltc'
  ) {
    return 'litecoin';
  }

  // Default to EVM for numeric chain IDs
  return BlockchainEcosystem.EVM;
}

// ==================== PUBLIC API ====================

// ==================== PUBLIC API ====================

export function validateTokenAddress(
  address: string,
  ecosystem: BlockchainEcosystem | 'bitcoin' | 'litecoin',
): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  try {
    switch (ecosystem.toLowerCase()) {
      case 'evm':
        return isValidEVMAddress(address);
      case 'solana':
        return isValidSolanaAddress(address);
      case 'tron':
        return isValidTronAddress(address);
      case 'bitcoin':
        return isValidBitcoinAddress(address);
      case 'litecoin':
        return isValidLitecoinAddress(address);
      default:
        console.warn(`Unknown ecosystem for address validation: ${ecosystem}`);
        return false;
    }
  } catch (error) {
    console.error(`Address validation error for ${ecosystem}:`, error.message);
    return false;
  }
}

export function validateRecipientAddress(
  ecosystem: string,
  chainId: number | string,
  recipient: string,
): void {
  if (!recipient || typeof recipient !== 'string') {
    throw new Error('Recipient address is required');
  }
  const eco = (ecosystem || '').toString().toLowerCase();
  const chainStr = String(chainId || '').toLowerCase();
  if (eco === 'evm') {
    if (!isValidEVMAddress(recipient)) {
      throw new Error('Invalid EVM recipient address');
    }
    return;
  }
  if (eco === 'solana') {
    if (!isValidSolanaAddress(recipient)) {
      throw new Error('Invalid Solana recipient address');
    }
    return;
  }
  if (
    eco === 'bitcoin' ||
    chainStr.includes('bitcoin') ||
    chainStr.includes('btc')
  ) {
    if (!isValidBitcoinAddress(recipient)) {
      throw new Error('Invalid Bitcoin recipient address');
    }
    return;
  }
  if (eco === 'tron' || chainStr.includes('tron') || chainStr.includes('trx')) {
    if (!isValidTronAddress(recipient)) {
      throw new Error('Invalid Tron recipient address');
    }
    return;
  }
  if (
    eco === 'litecoin' ||
    chainStr.includes('litecoin') ||
    chainStr.includes('ltc')
  ) {
    if (!isValidLitecoinAddress(recipient)) {
      throw new Error('Invalid Litecoin recipient address');
    }
    return;
  }
  throw new Error(
    `Recipient validation not implemented for ecosystem '${ecosystem}' on chain '${chainId}'`,
  );
}

export function isValidEVMAddress(address: string): boolean {
  return viemIsAddress(address);
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const pk = new PublicKey(address);
    return pk.toBase58() === address;
  } catch {
    return false;
  }
}

export function isValidTronAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  try {
    return TronWeb.utils.address.isAddress(address);
  } catch {
    return false;
  }
}

export function isValidBitcoinAddress(address: string): boolean {
  try {
    bitcoinjs.address.toOutputScript(address, bitcoinjs.networks.bitcoin);
    return true;
  } catch {
    return false;
  }
}

export function isValidLitecoinAddress(address: string): boolean {
  if (/^[LM][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    try {
      bs58.decode(address);
      return true;
    } catch {
      return false;
    }
  }
  if (address.startsWith('ltc1')) {
    try {
      let decoded;
      try {
        decoded = bech32.decode(address);
      } catch {
        decoded = bech32m.decode(address);
      }
      if (decoded.prefix !== 'ltc') {
        return false;
      }
      if (decoded.words.length < 2) {
        return false;
      }
      const witnessVersion = decoded.words[0];
      if (witnessVersion < 0 || witnessVersion > 16) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Validate token address with automatic ecosystem detection
 * @param address - Token address to validate
 * @param chainId - Chain ID to determine ecosystem
 * @returns true if valid, false otherwise
 */
export function validateTokenAddressForChain(
  address: string,
  chainId: number | string,
): boolean {
  const ecosystem = getEcosystemFromChainId(chainId);
  return validateTokenAddress(address, ecosystem);
}

/**
 * Normalize token address to lowercase (for EVM chains)
 * Other ecosystems are case-sensitive and should not be normalized
 */
export function normalizeTokenAddress(
  address: string,
  ecosystem: BlockchainEcosystem | 'bitcoin' | 'litecoin',
): string {
  if (ecosystem === BlockchainEcosystem.EVM) {
    return address.toLowerCase();
  }
  // Solana, Tron, Bitcoin, Litecoin are case-sensitive
  return address;
}
