import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load .env first
dotenv.config();

// Then load .env.local if it exists (overrides .env)
const localEnvPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
  console.log('Loading .env.local (overriding .env)');
  dotenv.config({ path: localEnvPath, override: true });
}

import * as cron from 'node-cron';
import { FulfillmentProcessor } from './services/fulfillment';
import { OrderHistoryService } from './services/order-history';
import { startApiServer } from './api-server';

// Validate environment variables
const requiredEnvVars = ['XCPFOLIO_ADDRESS', 'XCPFOLIO_PRIVATE_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize processor
const processor = new FulfillmentProcessor({
  xcpfolioAddress: process.env.XCPFOLIO_ADDRESS!,
  privateKey: process.env.XCPFOLIO_PRIVATE_KEY!,
  network: (process.env.NETWORK as 'mainnet' | 'testnet') || 'mainnet',
  dryRun: process.env.DRY_RUN === 'true',
  maxMempoolTxs: process.env.MAX_MEMPOOL_TXS ? parseInt(process.env.MAX_MEMPOOL_TXS) : 25,
  composeCooldown: process.env.COMPOSE_COOLDOWN ? parseInt(process.env.COMPOSE_COOLDOWN) : 10000,
  maxPreBroadcastRetries: process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES) : 10,
  rbfEnabled: process.env.RBF_ENABLED !== 'false',
  stuckTxThreshold: process.env.STUCK_TX_THRESHOLD ? parseInt(process.env.STUCK_TX_THRESHOLD) : 3,
  maxTotalFeeSats: process.env.MAX_TOTAL_FEE_SATS ? parseInt(process.env.MAX_TOTAL_FEE_SATS) : 10000,
  maxFeeRateForNewTx: process.env.MAX_FEE_RATE_FOR_NEW_TX ? parseInt(process.env.MAX_FEE_RATE_FOR_NEW_TX) : 100,
  orderHistoryPath: process.env.VERCEL ? '/tmp/.order-history.json' : '.order-history.json',
});

// Statistics
let stats = {
  runs: 0,
  totalProcessed: 0,
  successful: 0,
  failed: 0,
  startTime: new Date(),
  lastRun: null as Date | null,
};

// Run fulfillment check
async function runFulfillment() {
  const runTime = new Date();
  stats.runs++;
  
  try {
    console.log(`\n${'*'.repeat(70)}`);
    console.log(`* Run #${stats.runs} at ${runTime.toISOString()}`);
    console.log(`${'*'.repeat(70)}`);
    
    // Process orders
    const results = await processor.process();
    
    // Update statistics
    stats.lastRun = runTime;
    stats.totalProcessed += results.length;
    stats.successful += results.filter(r => r.success).length;
    stats.failed += results.filter(r => !r.success).length;
    
    if (results.length > 0) {
      // Send notifications
      await sendNotifications(results);
    }
    
  } catch (error) {
    console.error('❌ Fulfillment error:', error);
    await sendErrorNotification(error);
  }
}

// Send notifications
async function sendNotifications(results: any[]) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    const message = successful.map(r => {
      if (r.stage === 'confirmed') {
        return `✅ ${r.asset} -> ${r.buyer.slice(0, 6)}... (already transferred)`;
      } else if (r.txid && r.txid !== 'dry-run') {
        return `✅ ${r.asset} -> ${r.buyer.slice(0, 6)}... (${r.txid.slice(0, 8)}...)`;
      } else {
        return `✅ ${r.asset} -> ${r.buyer.slice(0, 6)}... (${r.stage})`;
      }
    }).join('\n');
    
    await notify(`Fulfilled ${successful.length} orders:\n${message}`);
  }

  if (failed.length > 0) {
    const message = failed.map(r => 
      `❌ ${r.asset} -> ${r.buyer.slice(0, 6)}... Failed at ${r.stage}: ${r.error?.slice(0, 50)}`
    ).join('\n');
    
    await notify(`Failed ${failed.length} orders:\n${message}`, 'error');
  }
}

// Send error notification
async function sendErrorNotification(error: any) {
  const message = `🚨 Service error: ${error.message || error}`;
  await notify(message, 'error');
}

// Notification function
async function notify(message: string, type: 'info' | 'error' = 'info') {
  console.log(`\n[${type.toUpperCase()}] ${message}\n`);

  // Discord webhook
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message.slice(0, 2000), // Discord limit
          username: 'XCPFOLIO Bot',
        }),
      });
    } catch (error) {
      console.error('Discord notification failed:', error);
    }
  }

  // Slack webhook
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
    } catch (error) {
      console.error('Slack notification failed:', error);
    }
  }
}

// Health check endpoint
async function startHealthCheck() {
  if (!process.env.HEALTH_CHECK_PORT) return;

  const http = require('http');
  const port = parseInt(process.env.HEALTH_CHECK_PORT);
  
  http.createServer(async (req: any, res: any) => {
    if (req.url === '/health' || req.url === '/status') {
      const state = processor.getState();
      const uptime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
      
      const status = {
        status: state.isProcessing ? 'processing' : 'idle',
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        statistics: stats,
        currentOrder: state.currentOrder,
        mempool: state.mempool,
        failures: state.failures,
        lastBlock: state.lastBlock,
        processedOrders: state.processedOrders.size,
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }).listen(port);
  
  console.log(`Health check: http://localhost:${port}/status`);
}

// Main
async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('XCPFOLIO FULFILLMENT BOT (Single Worker)');
  console.log('='.repeat(70));
  console.log(`Address: ${process.env.XCPFOLIO_ADDRESS}`);
  console.log(`Network: ${process.env.NETWORK || 'mainnet'}`);
  console.log(`Dry Run: ${process.env.DRY_RUN === 'true' ? 'YES' : 'NO'}`);
  console.log(`Max Mempool Txs: ${process.env.MAX_MEMPOOL_TXS || 25}`);
  console.log(`Compose Cooldown: ${process.env.COMPOSE_COOLDOWN || 10000}ms`);
  console.log(`RBF Enabled: ${process.env.RBF_ENABLED !== 'false' ? 'YES' : 'NO'}`);
  console.log(`Max Fee: ${process.env.MAX_TOTAL_FEE_SATS || 10000} sats (${(parseInt(process.env.MAX_TOTAL_FEE_SATS || '10000') / 100000000).toFixed(6)} BTC)`);
  console.log(`Max Rate (New): ${process.env.MAX_FEE_RATE_FOR_NEW_TX || 100} sat/vB`);
  console.log('='.repeat(70));

  // Start API server for order status (using processor's orderHistory)
  const apiServer = startApiServer(processor.orderHistory);
  console.log(`API server: http://localhost:${process.env.API_PORT || 3001}`);

  // Start health check server
  await startHealthCheck();

  // Run immediately on startup
  console.log('\nRunning initial check...');
  await runFulfillment();

  // Schedule based on CHECK_INTERVAL
  const checkInterval = process.env.CHECK_INTERVAL || '* * * * *';
  cron.schedule(checkInterval, async () => {
    // Only run if not already processing
    const state = processor.getState();
    if (state.isProcessing) {
      console.log('Previous run still active, skipping...');
      return;
    }
    await runFulfillment();
  });
  
  console.log(`\nScheduled: ${checkInterval}`);
  console.log('Press Ctrl+C to stop\n');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  processor.requestStop();
  
  // Wait for current processing to complete
  const maxWait = 30000; // 30 seconds
  const startWait = Date.now();
  
  while (processor.getState().isProcessing && (Date.now() - startWait) < maxWait) {
    console.log('Waiting for current order to complete...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Log final stats
  console.log('\nFinal Statistics:');
  console.log(`- Runs: ${stats.runs}`);
  console.log(`- Processed: ${stats.totalProcessed}`);
  console.log(`- Successful: ${stats.successful}`);
  console.log(`- Failed: ${stats.failed}`);
  
  const state = processor.getState();
  console.log(`- Active Txs: ${state.mempool.activeTransactions}`);
  console.log(`- Pre-broadcast Failures: ${state.failures.preBroadcast}`);
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  processor.requestStop();
  setTimeout(() => process.exit(0), 5000);
});

// Handle errors
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  await sendErrorNotification(error);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await sendErrorNotification(reason);
});

// Start
main().catch(async error => {
  console.error('Fatal error:', error);
  await sendErrorNotification(error);
  process.exit(1);
});