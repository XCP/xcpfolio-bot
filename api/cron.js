// Vercel serverless function entry point for cron job
const { FulfillmentProcessor } = require('../dist/services/fulfillment');

module.exports = async (req, res) => {
  console.log('Cron job triggered:', new Date().toISOString());
  
  try {
    const processor = new FulfillmentProcessor();
    await processor.process();
    
    res.status(200).json({ 
      success: true, 
      timestamp: new Date().toISOString(),
      message: 'Order processing completed'
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