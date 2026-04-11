import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Environment Configuration Service
 * Provides type-safe access to environment variables through ConfigService
 * This is the recommended way to access environment variables in NestJS
 */
@Injectable()
export class EnvironmentConfigService {
  constructor(private readonly configService: ConfigService) {}

  // Server Configuration
  get port(): number {
    return this.configService.get<number>('PORT', 3000);
  }

  get nodeEnv(): string {
    return this.configService.get<string>('NODE_ENV', 'development');
  }

  get corsOrigin(): string {
    return this.configService.get<string>('CORS_ORIGIN', '*');
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  // Token Validation
  get enableStrictTokenValidation(): boolean {
    return (
      this.configService.get<string>('ENABLE_STRICT_TOKEN_VALIDATION') ===
      'true'
    );
  }

  get allowUnknownTokens(): boolean {
    return this.configService.get<string>('ALLOW_UNKNOWN_TOKENS') === 'true';
  }

  // ==================== RPC CONFIGURATION ====================
  // RPC URLs are now managed in unified-token-configuration.config.ts
  // Use UnifiedConfigurationService.getChainConfiguration(chainId).rpcUrls
  // or ChainUtilsService.getRpcUrlsForChain(chainId) to get RPC URLs
  // ==================== END RPC CONFIGURATION ====================

  get tronApiKey(): string | undefined {
    return this.configService.get<string>('TRON_API_KEY');
  }

  // Aggregator API Keys
  get zeroxApiKey(): string | undefined {
    return this.configService.get<string>('ZEROX_API_KEY');
  }

  get paraswapApiKey(): string | undefined {
    return this.configService.get<string>('PARASWAP_API_KEY');
  }

  get cowApiKey(): string | undefined {
    return this.configService.get<string>('COW_API_KEY');
  }

  get socketApiKey(): string | undefined {
    return this.configService.get<string>('SOCKET_API_KEY');
  }

  get rangoApiKey(): string | undefined {
    return this.configService.get<string>('RANGO_API_KEY');
  }

  get routerApiKey(): string | undefined {
    return this.configService.get<string>('ROUTER_API_KEY');
  }

  get etherscanApiKey(): string | undefined {
    return this.configService.get<string>('ETHERSCAN_API_KEY');
  }

  get noderealApiKey(): string | undefined {
    return this.configService.get<string>('NODEREAL_API_KEY');
  }

  // Configuration
  get odosReferralCode(): number {
    return parseInt(
      this.configService.get<string>('ODOS_REFERRAL_CODE', '0'),
      10,
    );
  }

  get rubicFeeWallet(): string | undefined {
    return this.configService.get<string>('RUBIC_FEE_WALLET');
  }

  // Symbiosis Configuration
  get symbiosisPartnerId(): string | undefined {
    return this.configService.get<string>('SYMBIOSIS_PARTNER_ID');
  }

  get symbiosisEnabled(): boolean {
    return (
      this.configService.get<string>('SYMBIOSIS_ENABLED', 'true') !== 'false'
    );
  }

  // Price Impact Validation
  get priceImpactValidationEnabled(): boolean {
    return (
      this.configService.get<string>('PRICE_IMPACT_VALIDATION_ENABLED', 'true') !== 'false'
    );
  }

  get priceImpactWarningThreshold(): number {
    return parseFloat(
      this.configService.get<string>('PRICE_IMPACT_WARNING_THRESHOLD', '1.0'),
    );
  }

  get priceImpactHighThreshold(): number {
    return parseFloat(
      this.configService.get<string>('PRICE_IMPACT_HIGH_THRESHOLD', '3.0'),
    );
  }

  get priceImpactCriticalThreshold(): number {
    return parseFloat(
      this.configService.get<string>('PRICE_IMPACT_CRITICAL_THRESHOLD', '5.0'),
    );
  }

  // Logging
  get logLevel(): string {
    return this.configService.get<string>('LOG_LEVEL', 'info');
  }

  /**
   * Check if an API key is configured for a given aggregator
   * @param aggregatorName - Name of the aggregator
   * @returns boolean indicating if API key is configured
   */
  hasApiKey(aggregatorName: string): boolean {
    const keyMap: Record<string, string | undefined> = {
      zerox: this.zeroxApiKey,
      '0x': this.zeroxApiKey,
      paraswap: this.paraswapApiKey,
      cow: this.cowApiKey,
      socket: this.socketApiKey,
      rango: this.rangoApiKey,
      router: this.routerApiKey,
      symbiosis: this.symbiosisPartnerId,
    };

    return !!keyMap[aggregatorName.toLowerCase()];
  }
}
