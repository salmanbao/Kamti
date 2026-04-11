/**
 * Solana Router Providers
 *
 * Solana-specific DEX aggregators and routers.
 *
 * Current Status:
 * - Solana swaps are currently handled via RubicService (meta aggregator)
 * - Rubic aggregates multiple Solana DEXs (Jupiter, Raydium, etc.)
 * - No direct Solana router implementations are registered at this time
 *
 * Future Implementations (commented for reference):
 * - SaberService: Saber Protocol aggregator
 * - SerumService: Serum DEX aggregator
 * - LifinityService: Lifinity aggregator
 *
 * Note: When implementing direct Solana routers, ensure they implement
 * the ISolanaRouter interface from @swap/models/ports.
 */
