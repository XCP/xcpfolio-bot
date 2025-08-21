/**
 * Read-only API server for order status
 */

import express from 'express';
import cors from 'cors';
import { OrderHistoryService } from './services/order-history';

const PORT = process.env.API_PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

export function startApiServer(orderHistory: OrderHistoryService) {
  const app = express();

  // Enable CORS for the frontend
  app.use(cors({
    origin: CORS_ORIGIN,
    credentials: true
  }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: Date.now(),
      version: '1.0.0'
    });
  });

  // Get recent orders
  app.get('/api/orders', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const orders = await orderHistory.getRecentOrders(limit);
      
      // Transform for frontend display
      const formattedOrders = orders.map(order => ({
        orderHash: order.orderHash,
        asset: order.assetLongname || order.asset,
        price: order.price,
        buyer: order.buyer,
        status: order.status,
        stage: order.stage,
        purchasedAt: order.purchasedAt,
        deliveredAt: order.deliveredAt,
        confirmedAt: order.confirmedAt,
        txid: order.txid,
        error: order.error,
        retryCount: order.retryCount
      }));

      res.json({
        success: true,
        orders: formattedOrders,
        total: formattedOrders.length,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error fetching orders:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch orders'
      });
    }
  });

  // Get specific order by hash
  app.get('/api/orders/:hash', async (req, res) => {
    try {
      const order = await orderHistory.getOrder(req.params.hash);
      
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      res.json({
        success: true,
        order: {
          orderHash: order.orderHash,
          asset: order.assetLongname || order.asset,
          price: order.price,
          buyer: order.buyer,
          status: order.status,
          stage: order.stage,
          purchasedAt: order.purchasedAt,
          deliveredAt: order.deliveredAt,
          confirmedAt: order.confirmedAt,
          txid: order.txid,
          error: order.error,
          retryCount: order.retryCount
        }
      });
    } catch (error) {
      console.error('Error fetching order:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch order'
      });
    }
  });

  // Get orders by buyer address
  app.get('/api/orders/buyer/:address', async (req, res) => {
    try {
      const allOrders = await orderHistory.getOrders();
      const orders = allOrders.filter(o => o.buyer === req.params.address);
      
      const formattedOrders = orders.map(order => ({
        orderHash: order.orderHash,
        asset: order.assetLongname || order.asset,
        price: order.price,
        buyer: order.buyer,
        status: order.status,
        stage: order.stage,
        purchasedAt: order.purchasedAt,
        deliveredAt: order.deliveredAt,
        confirmedAt: order.confirmedAt,
        txid: order.txid
      }));

      res.json({
        success: true,
        orders: formattedOrders,
        total: formattedOrders.length
      });
    } catch (error) {
      console.error('Error fetching buyer orders:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch buyer orders'
      });
    }
  });

  // Get statistics
  app.get('/api/stats', async (req, res) => {
    try {
      const summary = await orderHistory.getStatusSummary();
      const orders = await orderHistory.getOrders();
      
      // Calculate average delivery time
      const deliveredOrders = orders.filter(o => o.deliveredAt && o.purchasedAt);
      const averageDeliveryTime = deliveredOrders.length > 0
        ? Math.floor(deliveredOrders.reduce((sum, o) => sum + (o.deliveredAt! - o.purchasedAt), 0) / deliveredOrders.length / 1000)
        : 0;
      
      const stats = {
        ...summary,
        averageDeliveryTime
      };
      
      res.json({
        success: true,
        stats: {
          ...stats,
          averageDeliveryTimeFormatted: stats.averageDeliveryTime > 0 
            ? `${Math.floor(stats.averageDeliveryTime / 60)}m ${stats.averageDeliveryTime % 60}s`
            : 'N/A'
        }
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch statistics'
      });
    }
  });

  const server = app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
    console.log(`CORS enabled for: ${CORS_ORIGIN}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down API server...');
    server.close(() => {
      console.log('API server closed');
    });
  });

  return server;
}