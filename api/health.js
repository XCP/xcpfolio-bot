// Health check endpoint for monitoring
module.exports = async (req, res) => {
  const dryRun = process.env.DRY_RUN === 'true';
  
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    network: process.env.NETWORK,
    dryRun,
    version: '1.0.0'
  });
};