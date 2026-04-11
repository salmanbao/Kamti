import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { ISwapExecutor } from '../ports/swap-executor.interface';
import { RouteQuote } from '@swap/models/ports';
import { EvmSwapExecutor } from './evm-swap-executor';
import { MetaSwapExecutor } from './meta-swap-executor';

/**
 * Swap Executor Factory
 *
 * Implements Factory Pattern for creating appropriate swap executors based on route type.
 * Uses Chain of Responsibility pattern to select the first executor that can handle a route.
 *
 * Design Benefits:
 * - Encapsulates executor creation and selection logic
 * - Easy to add new executor types without modifying existing code
 * - Supports runtime executor selection based on route characteristics
 * - Centralized executor registration and management
 *
 * Executor Selection Order (most specific first):
 * 1. MetaSwapExecutor - Cross-chain swaps, native L1 swaps, Solana swaps
 * 2. EvmSwapExecutor - Single-chain EVM swaps (catch-all for EVM chains)
 */
@Injectable()
export class SwapExecutorFactory {
  private readonly logger: WinstonLoggerService;
  private readonly executors: ISwapExecutor[] = [];

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    private readonly evmExecutor: EvmSwapExecutor,
    private readonly metaExecutor: MetaSwapExecutor,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(SwapExecutorFactory.name);
    this.registerExecutors();
  }

  /**
   * Register all available executors
   *
   * Registration order is critical: More specific executors must be registered first.
   * The factory checks executors in registration order and selects the first one that
   * can handle the route.
   *
   * Current Registration Order:
   * 1. MetaSwapExecutor - Handles cross-chain swaps, native L1 swaps (Bitcoin, Litecoin),
   *                       and Solana swaps via Rubic
   * 2. EvmSwapExecutor - Handles all single-chain EVM swaps (catch-all for EVM chains)
   */
  private registerExecutors(): void {
    // Register in order of specificity (most specific first)
    this.executors.push(this.metaExecutor); // Cross-chain, native L1, Solana
    this.executors.push(this.evmExecutor); // EVM chains (catch-all)

    this.logger.log(`✅ Registered ${this.executors.length} swap executors:`, {
      executors: this.executors.map((e) => e.getName()),
    });
  }

  /**
   * Get the appropriate executor for a given route
   *
   * Uses Chain of Responsibility pattern: iterates through registered executors
   * in registration order and returns the first one that can handle the route.
   *
   * @param route - Route quote to find executor for
   * @returns Executor that can handle the route
   * @throws Error if no executor can handle the route
   */
  getExecutor(route: RouteQuote): ISwapExecutor {
    for (const executor of this.executors) {
      this.logger.debug(
        `Checking if executor ${executor.getName()} can handle route...`,
      );
      if (executor.canExecute(route)) {
        this.logger.debug(`Selected executor: ${executor.getName()}`);
        return executor;
      }
    }

    throw new Error(
      `No executor found for route. Route steps: ${JSON.stringify(route.steps?.map((s) => ({ kind: s.kind, chainId: s.chainId })))}`,
    );
  }

  /**
   * Get all registered executors
   */
  getAllExecutors(): ISwapExecutor[] {
    return [...this.executors];
  }

  /**
   * Check if any executor can handle the given route
   */
  canExecuteRoute(route: RouteQuote): boolean {
    return this.executors.some((executor) => executor.canExecute(route));
  }
}
