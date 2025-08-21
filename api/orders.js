// API endpoint to serve order history
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
  // Enable CORS for the main site
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Read order history from /tmp (writable in Vercel)
    const historyPath = path.join('/tmp', '.order-history.json');
    
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      const orders = data.orders || [];
      
      // Convert from Map entries to array if needed
      const orderArray = Array.isArray(orders) && orders.length > 0 && Array.isArray(orders[0]) 
        ? orders.map(([key, value]) => value)
        : orders;
      
      // Sort by most recent first
      orderArray.sort((a, b) => (b.purchasedAt || 0) - (a.purchasedAt || 0));
      
      // Apply limit from query params
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const limitedOrders = orderArray.slice(0, limit);
      
      return res.status(200).json({
        success: true,
        orders: limitedOrders,
        total: limitedOrders.length,
        timestamp: Date.now()
      });
    }
    
    // No history file yet - return empty
    return res.status(200).json({
      success: true,
      orders: [],
      total: 0,
      timestamp: Date.now(),
      message: 'No orders processed yet'
    });
    
  } catch (error) {
    console.error('Error reading order history:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch order history',
      details: error.message
    });
  }
};