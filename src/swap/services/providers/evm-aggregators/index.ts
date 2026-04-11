/**
 * EVM Aggregator Providers
 *
 * Single-chain DEX aggregators for EVM-compatible blockchains.
 * These providers aggregate liquidity from multiple DEXs on a single chain.
 *
 * Current Implementations:
 * - ZeroXService: 0x Protocol aggregator
 * - OdosService: Odos aggregator
 *
 * Future Implementations (commented for reference):
 * - ParaSwapService: ParaSwap aggregator
 * - OneInchService: 1inch aggregator
 * - UniswapService: Direct Uniswap integration
 * - CowSwapService: CoW Protocol aggregator
 * - KyberSwapService: KyberSwap aggregator
 */
export { ZeroXService } from './zero-x.service';
export { OdosService } from './odos.service';
