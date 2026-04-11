/**
 * Meta Aggregator Providers
 *
 * Cross-chain aggregators that support swaps across multiple blockchains.
 * These providers handle bridge protocols and cross-chain routing.
 *
 * Current Implementation:
 * - RubicService: Rubic aggregator supporting 70+ blockchains
 *   - Handles cross-chain swaps (EVM-EVM, EVM-L2, L2-L2)
 *   - Supports native L1 swaps (Bitcoin, Litecoin, Dogecoin, etc.)
 *   - Integrates Socket, Rango, Router Protocol internally
 *   - No need for separate implementations of these protocols
 *
 * Future Implementations (commented for reference):
 * - BungeeService: Bungee Exchange aggregator
 * - XYFinanceService: XY Finance aggregator
 * - HopService: Hop Protocol aggregator
 */
export { RubicService } from './rubic.service';
