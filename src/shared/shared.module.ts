import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

// Services
import { CustomHttpService } from './services/http.service';
import { ChainListService } from './services/chainlist.service';
import { UnifiedConfigurationService } from './services/unified-configuration.service';
import { EnvironmentConfigService } from './services/environment-config.service';
import { RpcFallbackService } from './services/rpc-fallback.service';
import { WinstonLoggerService } from './services/winston-logger.service';
import { TraceLoggerService } from './services/trace-logger.service';
import { SwapAnalyticsService } from './services/swap-analytics.service';
import { AmountNormalizationUtils } from './utils/amount-normalization.utils';
import { ChainUtilsService } from './utils/chain.utils';
import { EtherscanService } from './services/etherscan.service';
import { NodeRealService } from './services/nodereal.service';
import { ProviderHealthService } from './services/provider-health.service';
import { GasPriceCacheService } from './services/gas-price-cache.service';
import { TransactionRetryService } from './services/transaction-retry.service';
import { EncryptionService } from './services/encryption.service';
import { DatabaseConnectionService } from './services/database-connection.service';
import { CompanyModule } from './company/company.module';

/**
 * Shared Module - Common Utilities and Services
 *
 * Global module providing shared services and utilities used across the application.
 * All services are exported for use in feature modules.
 *
 * Services Provided:
 * - CustomHttpService: HTTP client wrapper with retry logic
 * - ChainListService: Chain metadata and information
 * - UnifiedConfigurationService: Unified token and chain configuration
 * - EnvironmentConfigService: Environment variable management
 * - RpcFallbackService: RPC endpoint failover and health monitoring
 * - WinstonLoggerService: Structured logging with file rotation
 * - SwapAnalyticsService: Swap analytics and performance tracking
 * - AmountNormalizationUtils: Token amount normalization utilities
 * - ChainUtilsService: Chain configuration and RPC utilities
 * - EtherscanService: Etherscan Gas Oracle API integration for accurate gas price estimation
 * - NodeRealService: NodeReal eth_gasPrice JSON-RPC API integration as secondary gas price source
 * - GasPriceCacheService: Gas price caching service with chain-specific TTL
 * - TransactionRetryService: Transaction retry logic with exponential backoff
 */
@Global()
@Module({
  imports: [
    HttpModule.register({
      timeout: 30000, // 30 second timeout for HTTP requests
      maxRedirects: 5, // Maximum redirects allowed
    }),
    CompanyModule,
  ],
  providers: [
    CustomHttpService,
    ChainListService,
    UnifiedConfigurationService,
    EnvironmentConfigService,
    RpcFallbackService,
    WinstonLoggerService,
    TraceLoggerService,
    SwapAnalyticsService,
    AmountNormalizationUtils,
    ChainUtilsService,
    EtherscanService,
    NodeRealService,
    ProviderHealthService,
    GasPriceCacheService,
    TransactionRetryService,
    EncryptionService,
    DatabaseConnectionService,
  ],
  exports: [
    CustomHttpService,
    ChainListService,
    UnifiedConfigurationService,
    EnvironmentConfigService,
    RpcFallbackService,
    WinstonLoggerService,
    TraceLoggerService,
    SwapAnalyticsService,
    AmountNormalizationUtils,
    ChainUtilsService,
    EtherscanService,
    NodeRealService,
    ProviderHealthService,
    GasPriceCacheService,
    TransactionRetryService,
    EncryptionService,
    DatabaseConnectionService,
    CompanyModule,
  ],
})
export class SharedModule {}
