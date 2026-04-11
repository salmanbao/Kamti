import { registerAs } from '@nestjs/config';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Environment configuration interface with type safety
 */
export interface EnvironmentVariables {
  // Server Configuration
  port: number;
  nodeEnv: string;
  corsOrigin: string;

  // Token Validation
  enableStrictTokenValidation: boolean;
  allowUnknownTokens: boolean;

  // ==================== RPC CONFIGURATION ====================
  // RPC URLs are now managed in unified-token-configuration.config.ts
  // Use UnifiedConfigurationService.getChainConfiguration(chainId).rpcUrls
  // ==================== END RPC CONFIGURATION ====================

  // API Keys
  tronApiKey?: string;
  etherscanApiKey?: string;
  noderealApiKey?: string;

  // Aggregator API Keys
  zeroxApiKey?: string;
  paraswapApiKey?: string;
  cowApiKey?: string;
  socketApiKey?: string;
  rangoApiKey?: string;
  routerApiKey?: string;

  // Configuration
  odosReferralCode: number;
  rubicFeeWallet?: string;

  // Gasless Transactions (EIP-7702 & Pimlico)
  pimlicoApiKey?: string;
  gaslessEnabled: boolean;
  gasllessSupportedChains?: string; // Comma-separated chain IDs

  // Message Queue (Redis/Bull)
  redisUrl?: string;
  redisHost?: string;
  redisPort: number;
  redisPassword?: string;
  queueEnabled: boolean;

  // WebSocket Configuration
  websocketPort: number;
  websocketEnabled: boolean;
  websocketCorsOrigin: string;

  // Webhook Configuration
  webhookRetryMax: number;
  webhookTimeoutMs: number;
  webhookEnabled: boolean;

  // Round-Trip Configuration
  roundTripMinConfirmationsEvm: number;
  roundTripMinConfirmationsSolana: number;
  roundTripMinConfirmationsBitcoin: number;
  roundTripDefaultWaitSeconds: number;

  // Logging
  logLevel: string;
}

/**
 * Application configuration factory
 * Provides type-safe access to environment variables with validation
 */
export default registerAs(
  'app',
  (): EnvironmentVariables => ({
    // Server Configuration
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigin: process.env.CORS_ORIGIN || '*',

    // Token Validation
    enableStrictTokenValidation:
      process.env.ENABLE_STRICT_TOKEN_VALIDATION === 'true',
    allowUnknownTokens: process.env.ALLOW_UNKNOWN_TOKENS === 'true',

    // ==================== RPC CONFIGURATION ====================
    // RPC URLs are now managed in unified-token-configuration.config.ts
    // Use UnifiedConfigurationService.getChainConfiguration(chainId).rpcUrls
    // ==================== END RPC CONFIGURATION ====================

    // API Keys
    tronApiKey: process.env.TRON_API_KEY,
    etherscanApiKey: process.env.ETHERSCAN_API_KEY,
    noderealApiKey: process.env.NODEREAL_API_KEY,

    // Aggregator API Keys (optional)
    zeroxApiKey: process.env.ZEROX_API_KEY,

    // Configuration
    odosReferralCode: parseInt(process.env.ODOS_REFERRAL_CODE || '0', 10),
    rubicFeeWallet: process.env.RUBIC_FEE_WALLET,

    // Gasless Transactions (EIP-7702 & Pimlico)
    pimlicoApiKey: process.env.PIMLICO_API_KEY,
    gaslessEnabled: process.env.GASLESS_ENABLED === 'true',
    gasllessSupportedChains: process.env.GASLESS_SUPPORTED_CHAINS,

    // Message Queue (Redis/Bull)
    redisUrl: process.env.REDIS_URL,
    redisHost: process.env.REDIS_HOST || 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
    redisPassword: process.env.REDIS_PASSWORD,
    queueEnabled: process.env.QUEUE_ENABLED === 'true',

    // WebSocket Configuration
    websocketPort: parseInt(process.env.WEBSOCKET_PORT || '3001', 10),
    websocketEnabled: process.env.WEBSOCKET_ENABLED === 'true',
    websocketCorsOrigin: process.env.WEBSOCKET_CORS_ORIGIN || '*',

    // Webhook Configuration
    webhookRetryMax: parseInt(process.env.WEBHOOK_RETRY_MAX || '3', 10),
    webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10),
    webhookEnabled: process.env.WEBHOOK_ENABLED === 'true',

    // Round-Trip Configuration
    roundTripMinConfirmationsEvm: parseInt(
      process.env.ROUND_TRIP_MIN_CONFIRMATIONS_EVM || '1',
      10,
    ),
    roundTripMinConfirmationsSolana: parseInt(
      process.env.ROUND_TRIP_MIN_CONFIRMATIONS_SOLANA || '1',
      10,
    ),
    roundTripMinConfirmationsBitcoin: parseInt(
      process.env.ROUND_TRIP_MIN_CONFIRMATIONS_BITCOIN || '3',
      10,
    ),
    roundTripDefaultWaitSeconds: parseInt(
      process.env.ROUND_TRIP_DEFAULT_WAIT_SECONDS || '30',
      10,
    ),

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
  }),
);

/**
 * Validation schema for environment variables
 * This can be extended with class-validator decorators if needed
 */
export const validateEnvironmentVariables = (
  config: Record<string, unknown>,
) => {
  const errors: string[] = [];

  // Validate port
  const port = Number(config.PORT);
  if (isNaN(port) || port < 0 || port > 65535) {
    errors.push('PORT must be a valid number between 0 and 65535');
  }

  // Validate node environment
  const validNodeEnvs = ['development', 'production', 'test'];
  if (config.NODE_ENV && !validNodeEnvs.includes(config.NODE_ENV as string)) {
    errors.push(`NODE_ENV must be one of: ${validNodeEnvs.join(', ')}`);
  }

  // Validate boolean values
  const booleanFields = [
    'ENABLE_STRICT_TOKEN_VALIDATION',
    'ALLOW_UNKNOWN_TOKENS',
  ];
  booleanFields.forEach((field) => {
    if (
      config[field] &&
      !['true', 'false'].includes((config[field] as string).toLowerCase())
    ) {
      errors.push(`${field} must be 'true' or 'false'`);
    }
  });

  // Validate mandatory API keys for production features
  const requiredApiKeys = [
    {
      key: 'ETHERSCAN_API_KEY',
      name: 'Etherscan',
      purpose: 'gas estimation and transaction tracking',
    },
    {
      key: 'NODEREAL_API_KEY',
      name: 'NodeReal',
      purpose: 'enhanced RPC endpoints',
    },
  ];

  requiredApiKeys.forEach(({ key, name, purpose }) => {
    const value = config[key] as string | undefined;
    if (!value || value.trim() === '') {
      errors.push(
        `❌ ${key} is required for ${purpose}.\n` +
          `   Please set ${key} in your .env file.\n` +
          `   ${name} service will not function without this key.`,
      );
    }
  });

  if (errors.length > 0) {
    throw new Error(
      `\n\n🚨 Environment validation failed:\n\n${errors.join('\n\n')}\n`,
    );
  }

  return config;
};
