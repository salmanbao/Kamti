/**
 * Provider Barrel Exports
 *
 * Centralized exports for all aggregator providers organized by category.
 * Provides a clean import interface for provider services.
 *
 * Provider Categories:
 * - EVM Aggregators: Single-chain DEX aggregators (0x, Odos)
 * - Meta Aggregators: Cross-chain aggregators (Rubic)
 * - Solana Routers: Solana-specific aggregators (currently handled via meta)
 *
 * Also re-exports provider interfaces from models/ports for convenience.
 */
export * from './evm-aggregators';
export * from './meta';
export * from './solana';
export * from '@swap/models/ports';
