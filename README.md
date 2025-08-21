# XCPFOLIO Fulfillment Bot

Automated order fulfillment service for XCPFOLIO asset transfers on the Counterparty DEX.

## Overview

This bot monitors the Counterparty DEX for filled XCPFOLIO.* orders and automatically transfers ownership of the underlying asset to the buyer. When someone purchases `XCPFOLIO.ASSET` on the DEX, the bot transfers ownership of `ASSET` to the buyer's address.

## Process Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        XCPFOLIO FULFILLMENT BOT                        │
│                         (Single Worker Process)                        │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────┐
                    │   CHECK PROCESSING LOCK      │
                    │   (Prevent double-broadcast) │
                    └──────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────┐
                    │   UPDATE MEMPOOL STATE       │
                    │   - Check confirmations      │
                    │   - Detect dropped txs       │
                    └──────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────┐
                    │   HANDLE STUCK TXS (RBF)     │
                    │   - If stuck > 3 blocks      │
                    │   - If dropped from mempool   │
                    └──────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────┐
                    │   CHECK MEMPOOL CAPACITY     │
                    │   (Max 25 unconfirmed txs)   │
                    └──────────────────────────────┘
                                    │
                         ◆ At capacity? ◆──Yes──→ [Wait for confirmations]
                                    │
                                   No
                                    ▼
                    ┌──────────────────────────────┐
                    │   FETCH FILLED ORDERS        │
                    │   (XCPFOLIO.* from DEX)      │
                    └──────────────────────────────┘
                                    │
                                    ▼
                    ╔══════════════════════════════╗
                    ║   PROCESS EACH ORDER         ║
                    ╚══════════════════════════════╝
                                    │
                ┌───────────────────┴─────────────────────┐
                ▼                                         ▼
    ┌─────────────────────┐                 ┌─────────────────────┐
    │  VALIDATION STAGE   │                 │  PRE-BROADCAST      │
    │  - Order is filled  │                 │  RETRY CHECK        │
    │  - We own asset     │                 │  - Progressive      │
    │  - Asset not locked │                 │  - Max 100 attempts │
    └─────────────────────┘                 └─────────────────────┘
                │                                         │
                ▼                                         ▼
    ┌─────────────────────┐                 ┌─────────────────────┐
    │  DUPLICATE CHECK    │                 │  COMPOSE TX         │
    │  - Already sent?    │────No──────────▶│  - Check fee limit  │
    └─────────────────────┘                 │  - Create transfer  │
                │                            └─────────────────────┘
               Yes                                        │
                │                                         ▼
                ▼                            ┌─────────────────────┐
          [Mark Complete]                    │  SIGN TX            │
                                            │  - RBF enabled      │
                                            │  - Check fee ceiling│
                                            └─────────────────────┘
                                                          │
                                                          ▼
                                            ┌─────────────────────┐
                                            │  BROADCAST TX       │
                                            │  - Multiple nodes   │
                                            │  - Track in mempool │
                                            └─────────────────────┘
                                                          │
                                                          ▼
                                            ┌─────────────────────┐
                                            │  MONITOR TX         │
                                            │  - RBF if stuck     │
                                            │  - Track confirms   │
                                            └─────────────────────┘
```

## Core Services

### 1. FulfillmentProcessor (`src/services/fulfillment.ts`)
The main orchestrator that manages the entire fulfillment process.

**Key Features:**
- Single-worker lock mechanism to prevent race conditions
- Progressive retry strategy for pre-broadcast failures
- RBF (Replace-By-Fee) support for stuck transactions
- Mempool management with 25 transaction limit
- Fee ceiling protection (max 0.0001 BTC per transaction)

**Configuration:**
```typescript
{
  xcpfolioAddress: string;       // Your XCPFOLIO address
  privateKey: string;             // WIF format private key
  network: 'mainnet' | 'testnet';
  dryRun: boolean;                // Test without broadcasting
  maxMempoolTxs: number;          // Max unconfirmed (default: 25)
  composeCooldown: number;        // MS between compose calls (default: 10000)
  maxPreBroadcastRetries: number; // Retries before broadcast (default: 10)
  rbfEnabled: boolean;            // Enable RBF (default: true)
  stuckTxThreshold: number;       // Blocks before RBF (default: 3)
  maxTotalFeeSats: number;        // Max fee per tx (default: 10000)
  maxFeeRateForNewTx: number;     // Max rate for new tx (default: 100 sat/vB)
}
```

### 2. CounterpartyService (`src/services/counterparty.ts`)
Handles all interactions with the Counterparty protocol.

**Key Methods:**
- `getFilledXCPFOLIOOrders()` - Fetch filled XCPFOLIO.* orders
- `composeTransfer()` - Create asset transfer transaction
- `validateOrder()` - Verify order status and ownership
- `isAssetTransferredTo()` - Check if asset already sent
- `getAssetInfo()` - Get asset ownership details

### 3. BitcoinService (`src/services/bitcoin.ts`)
Manages Bitcoin transaction signing and broadcasting.

**Key Methods:**
- `signTransaction()` - Sign with P2PKH (RBF-enabled by default)
- `broadcastTransaction()` - Multi-endpoint broadcasting
- `fetchUTXOs()` - Get available UTXOs
- `getFeeRates()` - Current mempool fee rates
- `isInMempool()` - Check transaction status

**Broadcasting Strategy:**
1. Counterparty API
2. Mempool.space
3. Blockstream

### 4. StateManager (`src/services/state.ts`)
Persistent state management for processed orders.

**Tracks:**
- Last processed block
- Processed order hashes
- Processing timestamps

## Retry & RBF Strategy

### Pre-Broadcast Retries (Compose/Sign Failures)
- **Attempts 1-10**: 5-second backoff
- **Attempts 11-25**: 30-second backoff
- **Attempts 26-50**: 1-minute backoff
- **Attempts 51-100**: 5-minute backoff
- **Alerts**: At 10, 25, and 50 attempts
- **Reset**: After 1 hour

### RBF Strategy (Stuck Transactions)
- **First RBF**: At 3 blocks with 1.25x fee
- **RBFs 2-3**: Every 2 blocks with 1.5x fee
- **RBFs 4-5**: Every 3 blocks with 2x fee
- **RBFs 6-10**: Every 6 blocks with 2.5x fee
- **Dropped TX**: Immediate RBF with 2x fee
- **Max Attempts**: 10 RBFs before fresh retry

### Fee Protection
- **Hard Ceiling**: 10,000 sats (0.0001 BTC) per transaction
- **New TX Limit**: 100 sat/vB (waits if market is higher)
- **RBF Handling**: Caps at ceiling, abandons if can't increase

## Installation

```bash
# Clone repository
git clone https://github.com/yourusername/xcpfolio.com
cd xcpfolio.com/bot

# Install dependencies
npm install

# Build TypeScript
npm run build

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Run the bot
npm start
```

## Environment Variables

```bash
# Required
XCPFOLIO_ADDRESS=1YourBitcoinAddressHere
XCPFOLIO_PRIVATE_KEY=YourWIFPrivateKeyHere

# Network
NETWORK=mainnet
COUNTERPARTY_API=https://api.counterparty.io:4000/v2
MEMPOOL_API=https://mempool.space/api

# Processing
DRY_RUN=false
MAX_MEMPOOL_TXS=25
COMPOSE_COOLDOWN=10000
MAX_RETRIES=10

# RBF
RBF_ENABLED=true
STUCK_TX_THRESHOLD=3

# Fee Limits
MAX_TOTAL_FEE_SATS=10000      # 0.0001 BTC
MAX_FEE_RATE_FOR_NEW_TX=100   # 100 sat/vB

# Schedule
CHECK_INTERVAL=* * * * *       # Cron format

# Optional
DISCORD_WEBHOOK_URL=
SLACK_WEBHOOK_URL=
HEALTH_CHECK_PORT=3000
```

## Health Check

When `HEALTH_CHECK_PORT` is set, the bot exposes a health endpoint:

```bash
curl http://localhost:3000/status
```

Returns:
```json
{
  "status": "processing" | "idle",
  "uptime": "2h 15m",
  "statistics": {
    "runs": 135,
    "totalProcessed": 12,
    "successful": 11,
    "failed": 1
  },
  "mempool": {
    "activeTransactions": 3,
    "maxTxs": 25
  },
  "failures": {
    "preBroadcast": 0
  }
}
```

## Development

```bash
# Run in development mode
npm run dev

# Check orders without processing
npm run check-orders

# Run tests (if available)
npm test

# Lint code
npm run lint
```

## Architecture

The bot uses a single-worker architecture to prevent race conditions and double-broadcasting. Only one instance processes orders at a time, with a lock mechanism ensuring sequential processing.

**Key Design Decisions:**
1. **No Database**: Uses Counterparty API as source of truth
2. **Single-threaded**: Prevents race conditions
3. **Progressive Retries**: Handles transient failures gracefully
4. **RBF Support**: Recovers from stuck transactions
5. **Fee Protection**: Hard ceiling prevents excessive spending

## Security

- Private keys are stored in environment variables (never commit!)
- RBF enabled by default for transaction recovery
- Multiple broadcast endpoints for reliability
- Fee ceiling protection against market spikes
- Single-worker lock prevents double-spending

## License

MIT