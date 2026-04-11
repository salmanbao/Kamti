import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
  Max,
  IsBoolean,
  ValidateNested,
  IsArray,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Supported blockchain ecosystems
 */
export enum BlockchainEcosystem {
  EVM = 'evm', // Ethereum, Polygon, BSC, Arbitrum, etc.
  SOLANA = 'solana', // Solana ecosystem
  COSMOS = 'cosmos', // Cosmos ecosystem (ATOM, OSMO, etc.)
  BITCOIN = 'bitcoin', // Bitcoin and Bitcoin-based chains
  SUBSTRATE = 'substrate', // Polkadot, Kusama ecosystem
  NEAR = 'near', // NEAR Protocol
  TERRA = 'terra', // Terra ecosystem
  AVALANCHE = 'avalanche', // Avalanche C-Chain (also EVM but sometimes needs special handling)
  THORCHAIN = 'thorchain', // THORChain native
  MAYA = 'maya', // Maya Protocol
  CARDANO = 'cardano', // Cardano ecosystem (ADA)
  SUI = 'sui', // Sui blockchain
  HEDERA = 'hedera', // Hedera Hashgraph (HBAR)
  TON = 'ton', // TON blockchain
  TRON = 'tron', // Tron blockchain (TRX)
  XRPL = 'xrpl', // XRP Ledger
}

/**
 * Swap operation types
 */
export enum SwapType {
  ON_CHAIN = 'on-chain', // Same chain swap
  CROSS_CHAIN = 'cross-chain', // Different chains
  L1_TO_L2 = 'l1-to-l2', // Layer 1 to Layer 2
  L2_TO_L1 = 'l2-to-l1', // Layer 2 to Layer 1
  L2_TO_L2 = 'l2-to-l2', // Layer 2 to Layer 2
  NATIVE_SWAP = 'native-swap', // Native L1 swaps (THORChain, Maya)
}

/**
 * Token standard types
 */
export enum TokenStandard {
  NATIVE = 'native', // Native gas tokens (ETH, BNB, MATIC, SOL, etc.)
  ERC20 = 'erc20', // ERC-20 tokens
  SPL = 'spl', // Solana SPL tokens
  BEP20 = 'bep20', // BSC tokens (technically ERC20 but on BSC)
  TRC20 = 'trc20', // Tron TRC-20 tokens
  COSMOS_NATIVE = 'cosmos-native', // Cosmos native tokens
  RUNE = 'rune', // THORChain RUNE
  CACAO = 'cacao', // Maya CACAO
  // New ecosystem standards
  HTS = 'hts', // Hedera Token Service (HBAR ecosystem)
  JETTON = 'jetton', // TON blockchain tokens
  XRPL_NATIVE = 'xrpl-native', // XRP Ledger native tokens
  SUI_COIN = 'sui-coin', // Sui blockchain coin standard
  CARDANO_NATIVE = 'cardano-native', // Cardano native tokens
}

/**
 * Chain information for the swap
 */
export class ChainInfo {
  @ApiProperty({
    description:
      'Chain ID (for EVM chains use number, for others use string identifier)',
    examples: [1, 56, 137, 'solana-mainnet', 'cosmos-hub', 'bitcoin-mainnet'],
    required: true,
  })
  @IsNotEmpty()
  chainId: number | string;

  @ApiProperty({
    description: 'Blockchain ecosystem',
    enum: BlockchainEcosystem,
    example: BlockchainEcosystem.EVM,
  })
  @IsEnum(BlockchainEcosystem)
  ecosystem: BlockchainEcosystem;

  @ApiPropertyOptional({
    description: 'Network name for non-EVM chains',
    examples: ['mainnet', 'testnet', 'devnet'],
  })
  @IsOptional()
  @IsString()
  network?: string;
}

/**
 * Token information
 * NOTE: Token standard and decimals are automatically resolved from unified configuration
 * based on the token symbol. No need to pass these manually.
 */
export class TokenInfo {
  @ApiProperty({
    description:
      'Token symbol (e.g., USDT, ETH, SOL). Required for token configuration lookup.',
    example: 'USDT',
  })
  @IsString()
  symbol: string;

  @ApiPropertyOptional({
    description:
      'Token contract address (optional - auto-resolved from unified config if not provided)',
    examples: [
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT on Ethereum
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC on Solana
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // Native token placeholder
      'So11111111111111111111111111111111111111112', // SOL on Solana
    ],
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description:
      'Token standard (optional - auto-resolved from unified config)',
    enum: TokenStandard,
    example: TokenStandard.ERC20,
  })
  @IsOptional()
  @IsEnum(TokenStandard)
  standard?: TokenStandard;

  @ApiPropertyOptional({
    description:
      'Token decimals (optional - auto-resolved from unified config)',
    example: 18,
  })
  @IsOptional()
  @IsNumber()
  decimals?: number;

  @ApiProperty({
    description: 'Chain information where this token exists',
  })
  @ValidateNested()
  @Type(() => ChainInfo)
  chain: ChainInfo;
}

/**
 * Universal swap request DTO that can handle all swap scenarios
 */
export class UniversalSwapRequestDto {
  @ApiProperty({
    description: 'Token to sell',
    type: TokenInfo,
  })
  @ValidateNested()
  @Type(() => TokenInfo)
  sellToken: TokenInfo;

  @ApiProperty({
    description: 'Token to buy',
    type: TokenInfo,
  })
  @ValidateNested()
  @Type(() => TokenInfo)
  buyToken: TokenInfo;

  @ApiProperty({
    description: 'Amount to sell (in smallest unit, e.g., wei for ERC20)',
    example: '1000000000000000000',
  })
  @IsString()
  sellAmount: string;

  @ApiProperty({
    description:
      'Wallet address that will execute the swap (format depends on ecosystem)',
    examples: [
      '0x9C30214BeBfC3cD36aA4A11a9540e019f2951c5C', // EVM address
      'DJZ7ZD8Cf4KF5Q7JfgXNSPDY7hM1DfgY3wGg9SKUkrfE', // Solana address
      'cosmos1...', // Cosmos address
      'thor1...', // THORChain address
    ],
  })
  @IsString()
  taker: string;

  @ApiPropertyOptional({
    description: 'Recipient address (defaults to taker if not provided)',
  })
  @IsOptional()
  @IsString()
  recipient?: string;

  @ApiPropertyOptional({
    description: 'Slippage tolerance in basis points (e.g., 100 = 1%)',
    example: 100,
    minimum: 1,
    maximum: 5000,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5000)
  slippageToleranceBps?: number;

  @ApiPropertyOptional({
    description: 'Swap type (auto-detected if not provided)',
    enum: SwapType,
  })
  @IsOptional()
  @IsEnum(SwapType)
  swapType?: SwapType;

  @ApiPropertyOptional({
    description: 'Maximum gas fee willing to pay (in native token units)',
    example: '0.01',
  })
  @IsOptional()
  @IsString()
  maxGasFee?: string;

  @ApiPropertyOptional({
    description: 'Deadline for the swap (Unix timestamp)',
    example: 1640995200,
  })
  @IsOptional()
  @IsNumber()
  deadline?: number;

  @ApiPropertyOptional({
    description:
      'Preferred aggregator/router provider. ' +
      'For EVM swaps (same chain): preference order is Symbiosis > Rubic > EVM aggregators (0x, Odos). ' +
      'For cross-chain swaps: Rubic is primary with Symbiosis as fallback. ' +
      'Leave empty for auto-selection using the optimal provider preference order.',
    examples: ['symbiosis', 'rubic', '0x', 'odos', 'jupiter'],
  })
  @IsOptional()
  @IsString()
  preferredProvider?: string;

  @ApiPropertyOptional({
    description:
      'Preferred aggregator for swap execution. Explicit control over which provider executes the swap. ' +
      'For EVM on-chain swaps (same chain): ' +
      '  - "symbiosis" (primary): Best liquidity and feature support across multiple chains. ' +
      '  - "rubic" (secondary): Cross-chain specialist, 70+ blockchains support. ' +
      '  - "0x" or "odos" (tertiary): EVM-only specialized aggregators. ' +
      'For cross-chain swaps: Rubic and Symbiosis available (both support bridging). ' +
      'For native assets (BTC, SOL, etc.): Rubic is the primary option. ' +
      'Leave empty for automatic provider selection (recommended for best rates).',
    enum: ['symbiosis', 'rubic', '0x', 'odos', 'jupiter', 'thorchain', 'maya'],
    example: 'symbiosis',
  })
  @IsOptional()
  @IsString()
  preferredAggregator?: string;

  @ApiPropertyOptional({
    description: 'Enable MEV protection (EVM chains only)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  enableMevProtection?: boolean;

  @ApiPropertyOptional({
    description: 'Bridge preferences for cross-chain swaps',
    type: 'array',
    items: { type: 'string' },
    examples: [
      ['stargate', 'across'],
      ['hop', 'cbridge'],
    ],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  preferredBridges?: string[];

  @ApiPropertyOptional({
    description: 'Additional metadata for specific ecosystems',
    example: {
      priorityFee: '0.001',
      memo: 'swap:BTC.BTC',
      computeUnits: 200000,
    },
  })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Skip validation and simulation (faster but riskier)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipValidation?: boolean;

  @ApiPropertyOptional({
    description: 'Return multiple route options',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  returnMultipleRoutes?: boolean;

  @ApiPropertyOptional({
    description:
      'Swap full balance flag - when true, automatically adjusts swap amount to account for gas fees. ' +
      'Only applies to native token swaps (ETH, MATIC, BNB, etc.). ' +
      'The system will reduce the swap amount by estimated gas cost to ensure transaction succeeds.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  swapFullBalance?: boolean;

  @ApiPropertyOptional({
    description: 'Maximum number of routes to return',
    default: 3,
    minimum: 1,
    maximum: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  maxRoutes?: number;

  @ApiPropertyOptional({
    description:
      'Final output token for round-trip swaps (e.g., ETH→USDT→ETH). ' +
      'When specified, system executes two sequential swaps: ' +
      '1) sellToken → buyToken (intermediate), then ' +
      '2) buyToken → finalOutputToken. ' +
      'IMPORTANT: finalOutputToken.chain must match sellToken.chain (requirement #8). ' +
      'For cross-chain round-trips (e.g., ETH→SOL→ETH), buyToken must be native token (SOL) (requirement #10).',
    type: TokenInfo,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TokenInfo)
  finalOutputToken?: TokenInfo;

  @ApiPropertyOptional({
    description:
      'Enable gasless transaction execution via EIP-7702 (Pimlico). ' +
      'Only supported on EVM chains with Pimlico integration. ' +
      'When enabled, gas estimation is skipped (requirement #13) and transaction is sponsored.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  gasless?: boolean;

  @ApiPropertyOptional({
    description:
      'Webhook URL for swap completion notifications. ' +
      'System will POST swap result to this URL on completion/failure. ' +
      'Supports retry with exponential backoff (3 attempts: 5s, 15s, 45s).',
    example: 'https://api.example.com/webhooks/swap-complete',
  })
  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @ApiPropertyOptional({
    description:
      'Private key for transaction signing (EVM format). Required for swap execution.',
    example:
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  })
  @IsOptional()
  @IsString()
  privateKey?: string;

  @ApiPropertyOptional({
    description:
      'Solana private key (base58 encoded). Required for cross-chain round-trips involving Solana (e.g., ETH→SOL→ETH).',
    example: '5Jv8...',
  })
  @IsOptional()
  @IsString()
  solanaPrivateKey?: string;

  @ApiPropertyOptional({
    description:
      'Bitcoin private key (WIF format). Required for cross-chain round-trips involving Bitcoin.',
    example: 'L1aW4...',
  })
  @IsOptional()
  @IsString()
  bitcoinPrivateKey?: string;

  @ApiPropertyOptional({
    description:
      'Tron private key (64-character hex string, no 0x prefix). Required for cross-chain round-trips involving Tron (e.g., ETH→TRX→ETH).',
    example: 'afa5b710c1edaddc3067318d15db8252535681cebc9a5919637d6419d633fe94',
  })
  @IsOptional()
  @IsString()
  tronPrivateKey?: string;

  @ApiPropertyOptional({
    description:
      'Minimum profit in basis points for round-trip execution (e.g., 50 = 0.5%). ' +
      'If estimated profit is below this threshold after first swap, second swap is skipped.',
    minimum: 0,
    maximum: 10000,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  minProfitBps?: number;

  @ApiPropertyOptional({
    description:
      'Execute swap asynchronously via message queue. ' +
      'When true, returns executionId immediately and processes in background.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  async?: boolean;
}

/**
 * Swap route information
 */
export class SwapRoute {
  @ApiProperty({
    description: 'Provider/aggregator name',
    example: 'rubic',
  })
  provider: string;

  @ApiProperty({
    description: 'Estimated output amount',
    example: '999500000',
  })
  outputAmount: string;

  @ApiProperty({
    description: 'Estimated gas cost',
    example: '0.0045',
  })
  estimatedGas: string;

  @ApiProperty({
    description: 'Route steps for cross-chain swaps',
    type: 'array',
    items: { type: 'object' },
  })
  steps: Array<{
    action: 'swap' | 'bridge' | 'wrap' | 'unwrap' | 'native';
    provider: string;
    fromToken: string;
    toToken: string;
    fromChain: string;
    toChain: string;
    estimatedTime: number; // in seconds
  }>;

  @ApiProperty({
    description: 'Total estimated execution time in seconds',
    example: 180,
  })
  estimatedTime: number;

  @ApiProperty({
    description: 'Route quality score (0-100)',
    example: 95,
  })
  qualityScore: number;
}

/**
 * Universal swap response
 */
export class UniversalSwapResponseDto {
  @ApiProperty({
    description: 'Detected swap type',
    enum: SwapType,
  })
  swapType: SwapType;

  @ApiProperty({
    description: 'Available routes',
    type: [SwapRoute],
  })
  routes: SwapRoute[];

  @ApiProperty({
    description: 'Recommended route (highest quality score)',
    type: SwapRoute,
  })
  recommendedRoute: SwapRoute;

  @ApiProperty({
    description: 'Transaction data for execution',
    example: { to: '0x...', data: '0x...', value: '0' },
  })
  transactionData: any;

  @ApiProperty({
    description: 'Warnings or important notes',
    type: 'array',
    items: { type: 'string' },
  })
  warnings: string[];
}
