// Vercel serverless function entry point for cron job
const { FulfillmentProcessor } = require('../dist/services/fulfillment');
const { ConfirmationMonitor } = require('../dist/services/confirmation-monitor');

module.exports = async (req, res) => {
  console.log('Cron job triggered:', new Date().toISOString());
  
  try {
    // Build config from environment variables
    const config = {
      xcpfolioAddress: process.env.XCPFOLIO_ADDRESS,
      privateKey: process.env.XCPFOLIO_PRIVATE_KEY,
      network: process.env.NETWORK || 'mainnet',
      dryRun: process.env.DRY_RUN === 'true',
      maxMempoolTxs: parseInt(process.env.MAX_MEMPOOL_TXS || '25'),
      composeCooldown: parseInt(process.env.COMPOSE_COOLDOWN || '10000'),
      maxPreBroadcastRetries: parseInt(process.env.MAX_RETRIES || '10'),
      rbfEnabled: process.env.RBF_ENABLED !== 'false',
      stuckTxThreshold: parseInt(process.env.STUCK_TX_THRESHOLD || '3'),
      maxTotalFeeSats: parseInt(process.env.MAX_TOTAL_FEE_SATS || '10000'),
      maxFeeRateForNewTx: parseInt(process.env.MAX_FEE_RATE_FOR_NEW_TX || '100')
    };
    
    const processor = new FulfillmentProcessor(config);
    
    // Run order processing (this includes tracking mempool orders)
    const results = await processor.process();
    
    // Also check confirmations for pending orders
    const confirmationMonitor = new ConfirmationMonitor(processor.orderHistory);
    await confirmationMonitor.checkConfirmations();
    
    // Log summary
    console.log(`Processed ${results.length} orders, checking confirmations for pending orders`);
    
    res.status(200).json({ 
      success: true, 
      timestamp: new Date().toISOString(),
      message: 'Order processing and confirmation check completed'
    });
  } catch (error) {
    console.error('Error in cron job:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};