import { forwardRef, Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UniversalSwapController } from './controllers/universal-swap.controller';
import { SwapAnalysisController } from './controllers/swap-analysis.controller';
import { AdminConfigurationController } from './controllers/admin-configuration.controller';
import { JobStatusController } from './controllers/job-status.controller';
import { WebhookTestController } from './controllers/webhook-test.controller';
import { QuoteService } from './services/core/execution/quote.service';
import { SwapExecutionService } from './services/core/execution/swap-execution.service';
import { SwapRoutingService } from './services/core/swap-routing.service';
import { SwapCacheService } from './services/core/swap-cache.service';
import { QuoteExpiryService } from './services/core/quote-expiry.service';
import { RateLimitService } from './services/core/rate-limit.service';
import { ApprovalService } from './services/blockchain/approval/approval.service';
import { WalletService } from './services/blockchain/wallet/wallet.service';
import { EvmWalletProvider } from './services/blockchain/wallet/providers/evm-wallet.provider';
import { SolanaWalletProvider } from './services/blockchain/wallet/providers/solana-wallet.provider';
import { BitcoinWalletProvider } from './services/blockchain/wallet/providers/bitcoin-wallet.provider';
import { LitecoinWalletProvider } from './services/blockchain/wallet/providers/litecoin-wallet.provider';
import { TronWalletProvider } from './services/blockchain/wallet/providers/tron-wallet.provider';
import { AggregatorManagerService } from './services/core/aggregation/aggregator-manager.service';
import { TransactionParserService } from './services/blockchain/analysis/transaction-parser.service';

// Execution system
import { SwapExecutorFactory } from './services/core/execution/executors/swap-executor-factory';
import { EvmSwapExecutor } from './services/core/execution/executors/evm-swap-executor';
import { MetaSwapExecutor } from './services/core/execution/executors/meta-swap-executor';
import { GasEstimationTrackerService } from './services/core/execution/gas-estimation-tracker.service';
import { EnhancedResponseBuilderService } from './services/core/execution/enhanced-response-builder.service';

// Phase 1: Orchestration and validation services
import { SwapOrchestrationService } from './services/core/orchestration/swap-orchestration.service';
import { RoundTripOrchestrationService } from './services/core/orchestration/round-trip-orchestration.service';
import { SwapValidationService } from './services/core/validation/swap-validation.service';
import { PriceImpactValidatorService } from './services/validation/price-impact-validator.service';
import { ExecutionStateService } from './services/core/state/execution-state.service';
import { BridgeStatusTrackerService } from './services/core/state/bridge-status-tracker.service';
import { DestinationFundDetectorService } from './services/core/state/destination-fund-detector.service';
import { SubscriptionCleanupCronService } from './services/core/state/subscription-cleanup.cron';
import { GasReserveTrackerService } from './services/core/gas-reserve-tracker.service';

// Execution state storage - pluggable backend (in-memory or MongoDB)
import { ExecutionStorage } from './services/core/state/execution-storage.interface';
import { InMemoryExecutionStorage } from './services/core/state/in-memory-execution-storage';
import { MongoDBExecutionStorage } from './services/core/state/mongodb-execution-storage';
import {
  ExecutionSnapshotModel,
  ExecutionSnapshotSchema,
} from './services/core/state/execution-snapshot.schema';

// Phase 2: Gas estimation service
import { GasEstimationService } from './services/core/execution/gas/gas-estimation.service';

// Ecosystem fee calculators
import {
  EcosystemFeeCalculatorFactory,
  EvmFeeCalculator,
  SolanaFeeCalculator,
  BitcoinFeeCalculator,
  TronFeeCalculator,
} from './services/core/execution/fee-calculators';

// Phase 2: Transaction monitoring services
import { MonitoringModule } from './services/blockchain/monitoring/monitoring.module';
import { RoundTripBalanceService } from './services/core/round-trip-balance.service';

// Phase 4: Gasless transaction services
import { GaslessTransactionService } from './services/blockchain/gasless/gasless-transaction.service';

// Phase 5: Message queue services
import { QueueModule } from './services/queue/queue.module';

// Provider imports
import { ZeroXService } from './services/providers/evm-aggregators/zero-x.service';
import { OdosService } from './services/providers/evm-aggregators/odos.service';

import { RubicService } from './services/providers/meta/rubic.service';
import { SymbiosisService } from './services/providers/meta/symbiosis.service';

/**
 * Swap Module - Unified Swap Architecture
 *
 * Main module for the swap aggregator service. Provides comprehensive swap
 * functionality across multiple blockchain ecosystems.
 *
 * Features:
 * - Universal swap interface supporting all swap types
 * - Multi-chain support: EVM, Solana, Bitcoin, Litecoin, Tron
 * - Intelligent routing with automatic provider selection
 * - Cross-chain swaps via bridge protocols
 * - Native L1 swaps (Bitcoin, Litecoin via Rubic)
 *
 * Architecture:
 * - Controllers: API endpoints for swap operations
 * - Services: Core business logic and routing
 * - Executors: Strategy pattern for swap execution
 * - Providers: Aggregator integrations (0x, Odos, Rubic)
 * - Wallet Providers: Multi-chain wallet operations
 */
@Module({
  imports: [
    // MongoDB schema for execution state storage (optional)
    MongooseModule.forFeature([
      {
        name: ExecutionSnapshotModel.name,
        schema: ExecutionSnapshotSchema,
      },
    ]),
    MonitoringModule, // Phase 2: WebSocket transaction monitoring
    forwardRef(() => QueueModule), // Phase 5: Message queue for async execution (forwardRef to resolve circular dependency)
  ],
  controllers: [
    UniversalSwapController,
    SwapAnalysisController,
    AdminConfigurationController,
    JobStatusController, // Phase 5: Job status tracking for async execution
    WebhookTestController, // Phase 6: Webhook testing and validation
  ],
  providers: [
    // Core Services - Business logic and orchestration
    QuoteService, // Quote retrieval from aggregators
    SwapExecutionService, // Swap execution orchestration
    SwapRoutingService, // Intelligent routing logic
    SwapCacheService, // Route and quote caching
    ApprovalService, // Token approval management
    WalletService, // Multi-chain wallet operations

    // Execution System - Strategy pattern implementation
    SwapExecutorFactory, // Factory for executor selection
    EvmSwapExecutor, // EVM chain swap executor
    MetaSwapExecutor, // Cross-chain swap executor
    GasEstimationTrackerService, // Gas usage tracking and analytics
    EnhancedResponseBuilderService, // Rich response data builder

    // Phase 1: Orchestration and validation services
    SwapOrchestrationService, // Swap orchestration (business logic)
    {
      provide: 'SwapOrchestrationService', // Token for queue module injection
      useExisting: SwapOrchestrationService,
    },
    RoundTripOrchestrationService, // Round-trip swap orchestration
    SwapValidationService, // Swap validation logic
    PriceImpactValidatorService, // Price impact validation with configurable thresholds

    // Execution state storage - pluggable backend
    {
      provide: 'ExecutionStorage',
      useClass: InMemoryExecutionStorage, // Default: Fast in-memory storage
      // To switch to MongoDB:
      // useClass: MongoDBExecutionStorage, // Persistent storage for multi-instance deployments
    },
    InMemoryExecutionStorage, // Available for direct injection if needed
    MongoDBExecutionStorage, // Available for direct injection if needed
    ExecutionStateService, // Execution state management
    BridgeStatusTrackerService, // Background bridge status tracking
    DestinationFundDetectorService, // Multi-layered destination fund detection with retry resilience
    SubscriptionCleanupCronService, // Periodic cleanup of stale subscriptions and tracking state
    GasReserveTrackerService, // Adaptive gas reserve calculation and tracking

    // Phase 2: Gas estimation service
    GasEstimationService, // Centralized gas estimation logic

    // Ecosystem fee calculators
    EcosystemFeeCalculatorFactory, // Factory for ecosystem-specific fee calculators
    EvmFeeCalculator, // EVM fee calculation
    SolanaFeeCalculator, // Solana fee calculation (signature + compute + rent)
    BitcoinFeeCalculator, // Bitcoin fee calculation (UTXO-based)
    TronFeeCalculator, // Tron fee calculation (energy/bandwidth)

    // Phase 2: Round-trip balance service
    RoundTripBalanceService, // Native currency balance handling for round-trips

    // Phase 4: Gasless transaction service
    GaslessTransactionService, // EIP-7702 & Pimlico gasless transactions

    // Wallet Providers - Multi-chain wallet support
    EvmWalletProvider, // EVM chains (Ethereum, BSC, Polygon, etc.)
    SolanaWalletProvider, // Solana blockchain
    BitcoinWalletProvider, // Bitcoin network
    LitecoinWalletProvider, // Litecoin network
    TronWalletProvider, // Tron network

    // Analysis Services
    TransactionParserService, // Transaction analysis and parsing

    // Aggregator Management
    AggregatorManagerService, // Unified aggregator coordination

    // Core supporting services
    QuoteExpiryService, // Quote expiry monitoring and warnings
    RateLimitService, // Per-aggregator rate limiting

    // EVM Aggregator Providers
    ZeroXService, // 0x Protocol aggregator
    OdosService, // Odos aggregator

    // Meta Aggregator Providers
    RubicService, // Rubic (cross-chain + 70+ blockchains)
    SymbiosisService, // Symbiosis (cross-chain bridge aggregator for Tron support)
  ],
  exports: [
    // Core services
    QuoteService,
    SwapExecutionService,
    SwapRoutingService,
    SwapCacheService,
    QuoteExpiryService,
    RateLimitService,
    ApprovalService,
    WalletService,
    TransactionParserService,

    // Execution system
    SwapExecutorFactory,
    EvmSwapExecutor,
    MetaSwapExecutor,

    // Phase 1: Orchestration and validation services
    SwapOrchestrationService,
    RoundTripOrchestrationService,
    SwapValidationService,
    PriceImpactValidatorService,
    ExecutionStateService,
    BridgeStatusTrackerService,

    // Unified aggregator manager
    AggregatorManagerService,

    // All provider services
    ZeroXService,
    OdosService,
    RubicService,
    SymbiosisService,
  ],
})
export class SwapModule implements OnModuleInit {
  constructor(
    private readonly swapRoutingService: SwapRoutingService,
    private readonly aggregatorManager: AggregatorManagerService,
    private readonly walletService: WalletService,
    private readonly zeroXService: ZeroXService,
    private readonly odosService: OdosService,
    private readonly rubicService: RubicService,
    private readonly symbiosisService: SymbiosisService,
  ) {}

  /**
   * Module initialization hook
   * Called after all providers are instantiated and dependencies are resolved
   */
  onModuleInit() {
    // Register all aggregator providers with routing service
    // This enables chain support validation and provider discovery
    const allProviders = [
      this.zeroXService,
      this.odosService,
      this.rubicService,
      this.symbiosisService,
    ];

    this.swapRoutingService.setProviderRegistry(allProviders);

    // Signal that all aggregator providers have been registered
    // This allows AggregatorManagerService to finalize its initialization
    this.aggregatorManager.onRegistrationComplete();

    // Signal that all wallet providers have been registered
    // This allows WalletService to finalize its initialization
    this.walletService.onRegistrationComplete();
  }
}
