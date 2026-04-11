# A-Bot Microservices

A high-performance, multi-chain swap aggregator microservice built with NestJS. Supports 18+ blockchains with intelligent routing, automatic RPC fallback, and unified configuration management.

## Features

### Multi-Chain Support
- **18+ Blockchains**: Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche, Solana, Bitcoin, Litecoin, Tron, and more
- **Universal Swap Interface**: Single API for cross-chain swaps
- **Automatic Chain Detection**: Smart routing based on token addresses

### Intelligent RPC Management
- **67+ Production-Grade RPC Endpoints**: Pre-configured, no setup required
- **Automatic Failover**: 3-4 backup URLs per blockchain
- **Health Monitoring**: Real-time tracking of RPC endpoint performance
- **Zero Configuration**: Works out of the box with unified configuration

### Swap Aggregation
- **Multiple DEX Aggregators**: 0x, Odos, ParaSwap, Jupiter, Rubic, Symbiosis, and more
- **Best Price Discovery**: Compares quotes across all aggregators
- **Meta-Aggregation**: Rubic SDK and Symbiosis bridge for cross-chain swaps
- **Tron Support**: Native TRX and TRC-20 token swaps via Symbiosis
- **Gas Optimization**: Intelligent routing for lowest transaction costs

### Developer Experience
- **TypeScript**: Full type safety across the entire codebase
- **NestJS**: Modular, scalable architecture with dependency injection
- **Comprehensive Testing**: Unit tests, integration tests, build validation
- **Detailed Documentation**: API docs, configuration guides, migration paths

## Prerequisites

- **Node.js**: v18+ recommended
- **Package Manager**: pnpm (recommended), npm, or yarn
- **TypeScript**: v5.1+

## 🔧 Installation

```bash
# Clone the repository
git clone https://github.com/ersgithub8/A-Bot-microservices.git
cd A-Bot-microservices

# Install dependencies
pnpm install

# Build the project
pnpm run build

# Start in development mode
pnpm run start:dev

# Start in production mode
pnpm run start:prod
```

## 🌐 Configuration

### Environment Variables

Create a `.env` file based on `env.example`:

```bash
# Server Configuration
PORT=3000
NODE_ENV=development

# Token Validation
ENABLE_STRICT_TOKEN_VALIDATION=true
ALLOW_UNKNOWN_TOKENS=false

# API Keys (optional - for enhanced features)
TRON_API_KEY=your_api_key_here
ZEROX_API_KEY=your_api_key_here
PARASWAP_API_KEY=your_api_key_here

# Aggregator Configuration
SYMBIOSIS_ENABLED=true
SYMBIOSIS_PARTNER_ID=    # Optional - for tracking & analytics

# Price Impact Validation
PRICE_IMPACT_VALIDATION_ENABLED=true
PRICE_IMPACT_WARNING_THRESHOLD=1.0      # Warn at 1% impact
PRICE_IMPACT_HIGH_THRESHOLD=3.0         # High warning at 3% impact
PRICE_IMPACT_CRITICAL_THRESHOLD=5.0     # Block execution at 5% impact
```

### Price Impact Protection

The service includes automatic price impact validation to protect users from high slippage:

**Configuration** (via environment variables):
- `PRICE_IMPACT_VALIDATION_ENABLED`: Enable/disable validation (default: `true`)
- `PRICE_IMPACT_WARNING_THRESHOLD`: Warn user at this % (default: `1.0`)
- `PRICE_IMPACT_HIGH_THRESHOLD`: Strong warning at this % (default: `3.0`)
- `PRICE_IMPACT_CRITICAL_THRESHOLD`: Block transaction at this % (default: `5.0`)

**Severity Levels:**
- **Low** (0.1% - 1%): Acceptable, no action
- **Medium** (1% - 3%): Warning logged, transaction allowed
- **High** (3% - 5%): Strong warning, transaction allowed
- **Critical** (>5%): Transaction blocked by default

**Example:**
```typescript
// Quote with 2% price impact → Warning logged, allowed
// Quote with 6% price impact → Blocked with error message
```

### RPC Configuration (Automatic)

**No RPC URLs needed in `.env`!** The service uses unified configuration with 67+ pre-configured production endpoints.

**Configuration File**: `src/shared/config/unified-token-configuration.config.ts`

**Supported Blockchains** (with 3-4 fallback URLs each):
- **EVM**: Ethereum, BSC, Polygon, Arbitrum, Optimism, Base, Avalanche
- **Solana**: 4 public RPC endpoints
- **Bitcoin**: 4 public API endpoints
- **Litecoin**: 4 public API endpoints
- **Others**: Tron, SUI, Polkadot, Cardano, Hedera, TON, XRP, Dogecoin


### Core Modules

```
src/
├── app.module.ts              # Root module
├── core/                      # Core functionality (guards, filters, interceptors)
├── shared/                    # Shared services and utilities
│   ├── config/                # Configuration files
│   │   ├── unified-token-configuration.config.ts  # RPC URLs & chain config
│   │   └── env.config.ts                         # Environment variables
│   ├── services/
│   │   ├── unified-configuration.service.ts      # Chain config access
│   │   └── rpc-fallback.service.ts              # RPC health & failover
│   └── utils/
│       ├── chain.utils.ts                        # Chain utilities
│       └── viem.utils.ts                         # Blockchain clients
└── swap/                      # Swap functionality
    ├── controllers/           # API endpoints
    ├── services/
    │   ├── blockchain/        # Blockchain providers
    │   │   ├── wallet/        # Wallet operations (EVM, Solana, Bitcoin, etc.)
    │   │   ├── approval/      # Token approvals & Permit2
    │   │   └── analysis/      # Transaction parsing
    │   └── core/
    │       └── aggregation/   # DEX aggregators (0x, Odos, etc.)
    └── dto/                   # Request/response DTOs
```

### Service Architecture

1. **Unified Configuration Service**: Manages blockchain configurations and RPC URLs
2. **RPC Fallback Service**: Handles RPC requests with automatic failover
3. **Wallet Providers**: Blockchain-specific wallet operations (5 providers)
4. **Aggregator Services**: DEX aggregator integrations (7+ aggregators)
5. **Meta Aggregator**: Cross-chain routing via Rubic SDK

## RPC Fallback System

### Features
- **Automatic Failover**: Switches to backup URLs on failure
- **Health Monitoring**: Tracks success/failure rates per endpoint
- **Smart Routing**: Prioritizes fast, healthy URLs
- **Circuit Breaking**: Auto-disables failing endpoints
- **Statistics Tracking**: Detailed metrics for monitoring

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:cov

# Run e2e tests
pnpm test:e2e
```

## 📦 Deployment

### Pre-Deployment Checklist

**1. Environment Configuration**
```bash
# Verify all required environment variables
- PORT, NODE_ENV
- Database connections (MongoDB, Redis)
- API keys for aggregators
- Symbiosis configuration (if using Tron swaps)
```

**2. Build & Test**
```bash
# Run full test suite
pnpm test

# Build the application
pnpm run build

# Verify no compilation errors
pnpm run lint
```

**3. Integration Verification**
```bash
# Test Symbiosis API connectivity (if enabled)
node scripts/test-symbiosis-api.js

# Verify RPC endpoints
node scripts/check-round-trip-swaps.js
```

### Production Build

```bash
# Build the application
pnpm run build

# Start production server
pnpm run start:prod
```

### Staging Deployment

1. **Deploy to staging environment**
2. **Run smoke tests**:
   - Health check endpoints
   - Quote retrieval (EVM + Tron)
   - Transaction simulation
3. **Monitor logs** for errors
4. **Validate Symbiosis integration** (if enabled)

### Production Deployment Strategy

**Recommended: Canary Release**

1. **Initial Deployment (10% traffic)**
   - Deploy to subset of servers
   - Monitor for 24-48 hours
   - Track error rates and latency

2. **Gradual Rollout**
   - 25% traffic → monitor 24h
   - 50% traffic → monitor 24h
   - 100% traffic → final deployment

3. **Rollback Plan**
   - Keep previous version deployed
   - Automated rollback on error threshold
   - Database migration compatibility

### Monitoring Metrics

**Key Metrics to Track:**
- API response times (p50, p95, p99)
- Aggregator success rates
- RPC endpoint health
- Symbiosis quote success rate (Tron)
- Error rates by chain/aggregator
- Transaction success rates

### Symbiosis Integration Notes

**Chain ID Mapping (Critical for Tron):**
- Internal ID: `195` or `'tron-mainnet'`
- Symbiosis API ID: `728126428`
- Automatic mapping handled by SymbiosisService

**Rate Limiting:**
- Symbiosis `/v2/swap` endpoint: 1 request per second
- Enforced automatically by built-in rate limiter

**Authentication:**
- Partner ID is optional
- API works without it (tracking limited)
- Obtain from: https://symbiosis.finance

**Supported Chains via Symbiosis:**
- Tron (primary use case)
- 50+ EVM chains
- Bitcoin (if needed)

### Production Build

```bash
# Build the application
pnpm run build

# Start production server
pnpm run start:prod
```


### Code Style

```bash
# Lint code
pnpm run lint

# Format code
pnpm run format
```
