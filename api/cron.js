// Vercel serverless function entry point for cron job
const { FulfillmentProcessor } = require('../dist/services/fulfillment');
const { ConfirmationMonitor } = require('../dist/services/confirmation-monitor');
const { OrderMaintenanceService } = require('../dist/services/order-maintenance');
const { loadPrices } = require('../dist/services/prices');

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

    // Order maintenance: run at top of hour (minute = 0) or if forced via env
    const now = new Date();
    const runMaintenance = process.env.ORDER_MAINTENANCE_ENABLED !== 'false' &&
                          (now.getMinutes() === 0 || process.env.FORCE_MAINTENANCE === 'true');

    let maintenanceResults = [];
    if (runMaintenance) {
      console.log('Running order maintenance...');
      const prices = loadPrices();

      if (prices.size > 0) {
        const maintenanceConfig = {
          xcpfolioAddress: process.env.XCPFOLIO_ADDRESS,
          privateKey: process.env.XCPFOLIO_PRIVATE_KEY,
          network: process.env.NETWORK || 'mainnet',
          dryRun: process.env.DRY_RUN === 'true',
          maxMempoolTxs: parseInt(process.env.MAX_MEMPOOL_TXS || '25'),
          orderExpiration: parseInt(process.env.ORDER_EXPIRATION || '8064'),
          waitAfterBroadcast: parseInt(process.env.WAIT_AFTER_BROADCAST || '10000')
        };

        const maintenance = new OrderMaintenanceService(maintenanceConfig);
        maintenance.setPrices(prices);
        maintenanceResults = await maintenance.run();
        console.log(`Order maintenance: ${maintenanceResults.filter(r => r.success).length} orders created`);
      } else {
        console.log('No prices loaded, skipping order maintenance');
      }
    }

    // Log summary
    console.log(`Processed ${results.length} orders, checking confirmations for pending orders`);

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Order processing and confirmation check completed',
      fulfillment: results.length,
      maintenance: maintenanceResults.length
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