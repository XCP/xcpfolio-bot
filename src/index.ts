import 'dotenv/config';
import * as cron from 'node-cron';
import { FulfillmentProcessor } from './fulfillment';

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
});

// Function to run fulfillment check
async function runFulfillment() {
  console.log(`[${new Date().toISOString()}] Running fulfillment check...`);
  
  try {
    const results = await processor.process();
    
    if (results.length > 0) {
      console.log('Results:', JSON.stringify(results, null, 2));
      
      // Send notifications if configured
      await sendNotifications(results);
    }
  } catch (error) {
    console.error('Fulfillment error:', error);
    
    // Send error notification
    await sendErrorNotification(error);
  }
}

// Send notifications for processed orders
async function sendNotifications(results: any[]) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  if (successful.length > 0) {
    const message = `✅ Successfully fulfilled ${successful.length} orders:\n` +
      successful.map(r => `- ${r.asset} to ${r.buyer} (${r.txid})`).join('\n');
    
    await notify(message);
  }

  if (failed.length > 0) {
    const message = `❌ Failed to fulfill ${failed.length} orders:\n` +
      failed.map(r => `- ${r.asset} to ${r.buyer}: ${r.error}`).join('\n');
    
    await notify(message, 'error');
  }
}

// Send error notification
async function sendErrorNotification(error: any) {
  const message = `🚨 Fulfillment service error:\n${error.message || error}`;
  await notify(message, 'error');
}

// Generic notification function (implement your preferred notification method)
async function notify(message: string, type: 'info' | 'error' = 'info') {
  console.log(`[${type.toUpperCase()}] ${message}`);

  // Discord webhook
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message,
          username: 'XCPFOLIO Fulfillment',
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

// Main execution
async function main() {
  console.log('XCPFOLIO Fulfillment Service Starting...');
  console.log(`Address: ${process.env.XCPFOLIO_ADDRESS}`);
  console.log(`Network: ${process.env.NETWORK || 'mainnet'}`);
  console.log(`Dry Run: ${process.env.DRY_RUN === 'true'}`);

  // Run immediately on startup
  await runFulfillment();

  // Schedule to run every minute
  cron.schedule('* * * * *', runFulfillment);
  
  console.log('Fulfillment service is running (checking every minute)...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down fulfillment service...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down fulfillment service...');
  process.exit(0);
});

// Start the service
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});