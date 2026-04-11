/**
 * Execution Module - Barrel Export File
 *
 * Centralized exports for all execution-related components.
 * Provides a clean import interface for swap execution functionality.
 *
 * Exports:
 * - Interfaces: Swap executor contracts and types
 * - Executors: Base and concrete executor implementations
 * - Factory: Executor factory for runtime executor selection
 */
export * from './ports/swap-executor.interface';
export * from './executors/base-swap-executor';
export * from './executors/evm-swap-executor';
export * from './executors/meta-swap-executor';
export * from './executors/swap-executor-factory';
