/**
 * Vercel Serverless API endpoint for order tracking
 * This runs as a serverless function and uses Vercel KV for persistence
 */

import { Redis } from '@upstash/redis';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Initialize Redis client
const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const ORDER_KEY_PREFIX = 'order';
const ORDER_INDEX_KEY = 'order-index';
const MAX_ORDERS = 100;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // GET /api/orders - Get recent orders
    if (req.method === 'GET' && !req.query.hash) {
      const limit = parseInt(req.query.limit as string) || 50;
      const orders = await getRecentOrders(limit);
      
      return res.status(200).json({
        success: true,
        orders,
        total: orders.length,
        timestamp: Date.now()
      });
    }

    // GET /api/orders?hash=XXX - Get specific order
    if (req.method === 'GET' && req.query.hash) {
      const order = await getOrder(req.query.hash as string);
      
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      return res.status(200).json({
        success: true,
        order
      });
    }

    // POST /api/orders - Update order (internal use)
    if (req.method === 'POST') {
      // Verify internal token (add this to your env vars)
      const authToken = req.headers.authorization?.replace('Bearer ', '');
      if (authToken !== process.env.INTERNAL_API_TOKEN) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
      }

      const order = req.body;
      await upsertOrder(order);
      
      return res.status(200).json({
        success: true,
        message: 'Order updated'
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });

  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
}

async function getRecentOrders(limit: number): Promise<any[]> {
  try {
    // Get the index of recent order hashes
    const indexData = await redis.get(ORDER_INDEX_KEY);
    
    let index: string[] = [];
    if (indexData) {
      try {
        // Check if it's already an array (shouldn't be, but check)
        if (Array.isArray(indexData)) {
          index = indexData;
        } else if (typeof indexData === 'string') {
          // Try to parse as JSON
          index = JSON.parse(indexData);
        } else {
          console.error('Unexpected index data type:', typeof indexData, indexData);
        }
      } catch (parseError) {
        console.error('Failed to parse order index:', parseError);
        console.error('Raw index data:', indexData);
        // Return empty array if parsing fails
        return [];
      }
    }
    
    const orderHashes = index.slice(0, limit);
    
    // Fetch each order
    const orders = [];
    for (const hash of orderHashes) {
      const order = await redis.hgetall(`${ORDER_KEY_PREFIX}:${hash}`);
      if (order) {
        orders.push(order);
      }
    }
    
    return orders;
  } catch (error) {
    console.error('Error getting recent orders:', error);
    return [];
  }
}

async function getOrder(orderHash: string): Promise<any | null> {
  try {
    return await redis.hgetall(`${ORDER_KEY_PREFIX}:${orderHash}`);
  } catch (error) {
    console.error('Error getting order:', error);
    return null;
  }
}

async function upsertOrder(order: any): Promise<void> {
  try {
    // Filter out undefined/null values for Redis
    const cleanOrder: any = {};
    for (const [key, value] of Object.entries(order)) {
      if (value !== undefined && value !== null) {
        cleanOrder[key] = value;
      }
    }
    
    // Store the order as a hash with 7 day TTL
    await redis.hset(`${ORDER_KEY_PREFIX}:${order.orderHash}`, cleanOrder);
    await redis.expire(`${ORDER_KEY_PREFIX}:${order.orderHash}`, 60 * 60 * 24 * 7);

    // Update the index
    const indexData = await redis.get(ORDER_INDEX_KEY);
    let index = indexData ? JSON.parse(indexData as string) : [];
    
    // Remove if already exists and add to front
    index = index.filter((h: string) => h !== order.orderHash);
    index.unshift(order.orderHash);
    
    // Keep only recent orders
    if (index.length > MAX_ORDERS) {
      index = index.slice(0, MAX_ORDERS);
    }
    
    await redis.set(ORDER_INDEX_KEY, JSON.stringify(index), {
      ex: 60 * 60 * 24 * 7
    });
  } catch (error) {
    console.error('Error storing order:', error);
    throw error;
  }
}