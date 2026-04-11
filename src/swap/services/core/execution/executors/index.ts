/**
 * Swap Executors Index
 *
 * Centralized export for all swap executor implementations
 * Makes imports cleaner and more maintainable
 */

// Base executor
export { BaseSwapExecutor } from './base-swap-executor';

// Executor implementations
export { EvmSwapExecutor } from './evm-swap-executor';
export { MetaSwapExecutor } from './meta-swap-executor';

// Factory
export { SwapExecutorFactory } from './swap-executor-factory';

/**
 * Executor Implementation Summary
 *
 * 1. EvmSwapExecutor
 *    - Purpose: Single-chain EVM swap execution
 *    - Chains: Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, and all EVM chains
 *    - Features: EIP-1559 gas pricing, approval flow, retry logic, 15+ blockchain explorers
 *    - Status: Production ready
 *
 * 2. MetaSwapExecutor
 *    - Purpose: Cross-chain swaps and native L1 swaps
 *    - Types: Cross-chain (EVM-EVM, EVM-L2, L2-L2), native L1 swaps (Bitcoin, Litecoin)
 *    - Features: Multi-step coordination, bridge monitoring, Bitcoin UTXO support, Solana swaps
 *    - Status: Production ready
 *    - Providers: Rubic (Bitcoin ↔ EVM, Solana), Socket, Rango, and other bridge protocols
 */
