# XCPFOLIO Fulfillment Service

Automated fulfillment service for XCPFOLIO asset transfers. Monitors the Counterparty DEX for filled XCPFOLIO.* orders and automatically transfers asset ownership to buyers.

## Architecture

- **Block-based polling**: Only checks for new orders when a new Bitcoin block is mined
- **Counterparty as source of truth**: All state verification done via Counterparty API
- **Idempotent processing**: Safe to restart, won't double-process orders
- **State persistence**: Tracks last processed block and orders locally

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

Required environment variables:
- `XCPFOLIO_ADDRESS`: Your XCPFOLIO address (e.g., 1BoTXcPiDFJgXMbydpRPDKKaqM1MbaEuSe)
- `XCPFOLIO_PRIVATE_KEY`: Private key for signing transactions

Optional:
- `DRY_RUN=true`: Test mode, won't broadcast transactions
- `DISCORD_WEBHOOK_URL`: Discord notifications
- `SLACK_WEBHOOK_URL`: Slack notifications

## Usage

### Development Mode
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

### Check Orders (Read-Only)
```bash
npm run check-orders
```

## How It Works

1. **Block Monitoring**: Checks for new Bitcoin blocks every minute
2. **Order Detection**: When new block found, fetches filled XCPFOLIO.* orders
3. **Deduplication**: Checks if order already processed or asset already transferred
4. **Transaction Composition**: Creates asset transfer transaction with optimal fee
5. **Broadcasting**: Signs and broadcasts to Bitcoin network
6. **State Update**: Records processed orders to prevent reprocessing

## State Management

The service maintains state in `.fulfillment-state.json`:
- `lastBlock`: Last Bitcoin block height checked
- `lastOrderHash`: Most recent order processed
- `processedOrders`: Set of all processed order hashes
- `lastChecked`: Timestamp of last check

## API Endpoints Used

- Counterparty API:
  - `/addresses/{address}/orders` - Get orders for XCPFOLIO address
  - `/assets/{asset}/issuances` - Check transfer history
  - `/compose/issuance` - Create transfer transaction
  - `/broadcast` - Broadcast signed transaction

- Mempool.space API:
  - `/blocks/tip/height` - Current block height
  - `/v1/fees/recommended` - Fee recommendations

## Security Notes

- Private key should be stored securely (use environment variables or secret manager)
- Consider using a hardware wallet or signing service in production
- Monitor for unusual activity
- Set up alerts for failed fulfillments

## Monitoring

The service logs all activity and can send notifications via:
- Console output
- Discord webhook
- Slack webhook

## Deployment Options

### Local/VPS
Run directly with Node.js and systemd/pm2

### Vercel
Deploy as serverless function with cron trigger

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
CMD ["npm", "start"]
```

## Testing

Test without processing orders:
```bash
DRY_RUN=true npm run dev
```

Check current state:
```bash
npm run check-orders
```

## Troubleshooting

- **Orders not processing**: Check if new blocks are being detected
- **Transaction failures**: Verify private key and address match
- **API errors**: Check rate limits and API availability
- **State issues**: Delete `.fulfillment-state.json` to reset (will reprocess all orders!)

## TODO

- [ ] Implement proper Bitcoin transaction signing
- [ ] Add RBF (Replace-By-Fee) support for stuck transactions
- [ ] Implement WebSocket connections for real-time updates
- [ ] Add database support for better state management
- [ ] Create monitoring dashboard
- [ ] Add unit tests