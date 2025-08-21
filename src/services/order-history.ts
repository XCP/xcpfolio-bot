/**
 * Order history tracking for status page
 * Uses Vercel KV (Redis) for persistence
 */

import { Redis } from '@upstash/redis';

export interface OrderStatus {
  orderHash: string;
  asset: string;
  assetLongname?: string;
  price: number; // In XCP
  buyer: string;
  seller: string;
  status: 'unconfirmed' | 'listing' | 'pending' | 'processing' | 'broadcasting' | 'confirming' | 'confirmed' | 'failed' | 'permanently_failed';
  stage?: 'mempool' | 'listing' | 'validation' | 'compose' | 'sign' | 'broadcast' | 'confirmed';
  confirmations?: number; // 0 for mempool, 1+ for confirmed
  orderType?: 'open' | 'filled'; // To distinguish between listing and sale
  purchasedAt: number; // Block time or timestamp
  purchasedBlock?: number; // Block height when order was filled
  broadcastAt?: number; // When transfer tx was broadcast
  deliveredAt?: number; // When transfer tx was confirmed (delivery complete)
  confirmedAt?: number; // When transaction was confirmed
  confirmedBlock?: number; // Block height when transfer was confirmed
  txid?: string;
  error?: string;
  retryCount?: number;
  lastUpdated: number;
}

export class OrderHistoryService {
  private redis: Redis;
  private orders: Map<string, OrderStatus>;
  private maxOrders: number;
  private cacheExpiry = 5000; // 5 second cache
  private lastCacheTime = 0;

  constructor(historyPath?: string, maxOrders = 100) {
    // historyPath parameter kept for compatibility but ignored
    // Always use Redis/KV for order history
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      throw new Error('Redis/KV credentials required: Set KV_REST_API_URL and KV_REST_API_TOKEN');
    }

    this.redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    this.maxOrders = maxOrders;
    this.orders = new Map();
    console.log('OrderHistory: Using Redis/KV for persistence');
  }

  private async loadHistory(): Promise<Map<string, OrderStatus>> {
    // Use cache if fresh
    if (this.orders.size > 0 && Date.now() - this.lastCacheTime < this.cacheExpiry) {
      return this.orders;
    }

    try {
      // Get order index
      const indexData = await this.redis.get<string[]>('order-index');
      if (indexData && Array.isArray(indexData)) {
        const orders = new Map<string, OrderStatus>();
        
        // Load each order
        for (const hash of indexData) {
          const order = await this.redis.hgetall(`order:${hash}`);
          if (order) {
            // Parse numeric fields from Redis strings
            const parsedOrder: OrderStatus = {
              ...order,
              price: typeof order.price === 'string' ? parseFloat(order.price) : order.price,
              purchasedAt: typeof order.purchasedAt === 'string' ? parseInt(order.purchasedAt) : order.purchasedAt,
              lastUpdated: typeof order.lastUpdated === 'string' ? parseInt(order.lastUpdated) : order.lastUpdated,
              purchasedBlock: order.purchasedBlock ? (typeof order.purchasedBlock === 'string' ? parseInt(order.purchasedBlock) : order.purchasedBlock) : undefined,
              confirmedBlock: order.confirmedBlock ? (typeof order.confirmedBlock === 'string' ? parseInt(order.confirmedBlock) : order.confirmedBlock) : undefined,
              broadcastAt: order.broadcastAt ? (typeof order.broadcastAt === 'string' ? parseInt(order.broadcastAt) : order.broadcastAt) : undefined,
              deliveredAt: order.deliveredAt ? (typeof order.deliveredAt === 'string' ? parseInt(order.deliveredAt) : order.deliveredAt) : undefined,
              confirmedAt: order.confirmedAt ? (typeof order.confirmedAt === 'string' ? parseInt(order.confirmedAt) : order.confirmedAt) : undefined,
              confirmations: order.confirmations ? (typeof order.confirmations === 'string' ? parseInt(order.confirmations) : order.confirmations) : undefined,
              retryCount: order.retryCount ? (typeof order.retryCount === 'string' ? parseInt(order.retryCount) : order.retryCount) : undefined,
            } as OrderStatus;
            
            orders.set(hash, parsedOrder);
          }
        }
        
        this.orders = orders;
        this.lastCacheTime = Date.now();
        return orders;
      }
    } catch (error) {
      console.error('Error loading order history from Redis:', error);
    }

    return new Map();
  }

  private async saveHistory(): Promise<void> {
    try {
      // Get existing index from Redis first
      const existingIndex = await this.redis.get<string[]>('order-index') || [];
      const existingSet = new Set(existingIndex);
      
      // Save all orders in memory (they've been updated/added)
      for (const [hash, order] of this.orders.entries()) {
        // Clean up null/undefined values before saving to Redis
        const cleanOrder: any = {};
        for (const [key, value] of Object.entries(order)) {
          if (value !== null && value !== undefined) {
            cleanOrder[key] = value;
          }
        }
        await this.redis.hset(`order:${hash}`, cleanOrder);
        await this.redis.expire(`order:${hash}`, 60 * 60 * 24 * 7); // 7 day TTL
        existingSet.add(hash); // Add to index
      }
      
      // Convert back to array and sort by recency (need to load all orders for proper sorting)
      const allOrders: Array<[string, OrderStatus]> = [];
      for (const hash of existingSet) {
        const order = await this.redis.hgetall(`order:${hash}`);
        if (order) {
          // Parse numeric fields
          const parsedOrder: OrderStatus = {
            ...order,
            price: typeof order.price === 'string' ? parseFloat(order.price) : order.price,
            purchasedAt: typeof order.purchasedAt === 'string' ? parseInt(order.purchasedAt) : order.purchasedAt,
            lastUpdated: typeof order.lastUpdated === 'string' ? parseInt(order.lastUpdated) : order.lastUpdated,
            purchasedBlock: order.purchasedBlock ? (typeof order.purchasedBlock === 'string' ? parseInt(order.purchasedBlock) : order.purchasedBlock) : undefined,
          } as OrderStatus;
          allOrders.push([hash, parsedOrder]);
        }
      }
      
      // Sort and keep only the most recent
      const sortedOrders = allOrders
        .sort((a, b) => {
          if (a[1].purchasedBlock && b[1].purchasedBlock) {
            return b[1].purchasedBlock - a[1].purchasedBlock;
          }
          return b[1].lastUpdated - a[1].lastUpdated;
        })
        .slice(0, this.maxOrders);
      
      // Update index with sorted order hashes
      const orderHashes = sortedOrders.map(([hash]) => hash);
      await this.redis.set('order-index', JSON.stringify(orderHashes), {
        ex: 60 * 60 * 24 * 7
      });
    } catch (error) {
      console.error('Error saving order history to Redis:', error);
      throw error; // Re-throw to ensure we know about save failures
    }
  }

  /**
   * Add or update an order in the history
   */
  async upsertOrder(order: OrderStatus): Promise<void> {
    order.lastUpdated = Date.now();
    // Clean nulls before setting in memory map
    const cleanedOrder = this.cleanNullValues(order);
    this.orders.set(order.orderHash, cleanedOrder);
    await this.saveHistory();
  }
  
  /**
   * Helper to clean null/undefined values from order object
   */
  private cleanNullValues(order: OrderStatus): OrderStatus {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(order)) {
      if (value !== null && value !== undefined) {
        cleaned[key] = value;
      }
    }
    return cleaned as OrderStatus;
  }

  /**
   * Update order status
   */
  async updateOrderStatus(
    orderHash: string, 
    status: OrderStatus['status'], 
    stage?: OrderStatus['stage'],
    txid?: string,
    error?: string
  ): Promise<void> {
    // Load latest state from Redis
    await this.loadHistory();
    
    const order = this.orders.get(orderHash);
    if (order) {
      order.status = status;
      if (stage) order.stage = stage;
      if (txid) order.txid = txid;
      if (error) order.error = error;
      order.lastUpdated = Date.now();
      
      // Set broadcast time when initially sent
      if ((status === 'broadcasting' || status === 'confirming') && !order.broadcastAt) {
        order.broadcastAt = Date.now();
      }
      
      // Set delivery/confirmation time when transfer is confirmed
      if (status === 'confirmed') {
        if (!order.confirmedAt) {
          order.confirmedAt = Date.now();
        }
        if (!order.deliveredAt) {
          order.deliveredAt = Date.now(); // Delivery complete when confirmed
        }
      }
      
      // Clean nulls before saving
      const cleanedOrder = this.cleanNullValues(order);
      this.orders.set(orderHash, cleanedOrder);
      
      await this.saveHistory();
    }
  }

  /**
   * Update order confirmations
   */
  async updateOrderConfirmations(orderHash: string, confirmations: number): Promise<void> {
    await this.loadHistory();
    
    const order = this.orders.get(orderHash);
    if (order) {
      order.confirmations = confirmations;
      order.lastUpdated = Date.now();
      
      // Mark as confirmed if has confirmations
      if (confirmations > 0 && order.status !== 'confirmed') {
        order.status = 'confirmed';
        order.stage = 'confirmed';
        if (!order.confirmedAt) {
          order.confirmedAt = Date.now();
        }
      }
      
      await this.saveHistory();
    }
  }

  /**
   * Get order by hash
   */
  async getOrder(orderHash: string): Promise<OrderStatus | undefined> {
    await this.loadHistory();
    return this.orders.get(orderHash);
  }

  /**
   * Get all orders
   */
  async getOrders(): Promise<OrderStatus[]> {
    await this.loadHistory();
    return Array.from(this.orders.values())
      .sort((a, b) => {
        // Sort by purchasedBlock if available (newest first), otherwise by lastUpdated
        if (a.purchasedBlock && b.purchasedBlock) {
          return b.purchasedBlock - a.purchasedBlock;
        }
        return b.lastUpdated - a.lastUpdated;
      });
  }

  /**
   * Get recent orders
   */
  async getRecentOrders(limit: number = 50): Promise<OrderStatus[]> {
    const orders = await this.getOrders();
    return orders.slice(0, limit);
  }

  /**
   * Get pending orders (not confirmed)
   */
  async getPendingOrders(): Promise<OrderStatus[]> {
    const orders = await this.getOrders();
    return orders.filter(o => 
      o.status !== 'confirmed' && 
      o.status !== 'failed'
    );
  }

  /**
   * Get confirmed orders
   */
  async getConfirmedOrders(): Promise<OrderStatus[]> {
    const orders = await this.getOrders();
    return orders.filter(o => o.status === 'confirmed');
  }

  /**
   * Get failed orders
   */
  async getFailedOrders(): Promise<OrderStatus[]> {
    const orders = await this.getOrders();
    return orders.filter(o => o.status === 'failed');
  }

  /**
   * Clean up old orders
   */
  async cleanupOldOrders(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    await this.loadHistory();
    
    const now = Date.now();
    const oldOrders: string[] = [];
    
    for (const [hash, order] of this.orders.entries()) {
      if (now - order.lastUpdated > maxAge) {
        oldOrders.push(hash);
      }
    }
    
    // Remove old orders
    for (const hash of oldOrders) {
      this.orders.delete(hash);
      await this.redis.del(`order:${hash}`);
    }
    
    if (oldOrders.length > 0) {
      await this.saveHistory();
      console.log(`Cleaned up ${oldOrders.length} old orders`);
    }
  }

  /**
   * Get status summary
   */
  async getStatusSummary(): Promise<{
    total: number;
    pending: number;
    confirmed: number;
    failed: number;
  }> {
    const orders = await this.getOrders();
    
    return {
      total: orders.length,
      pending: orders.filter(o => o.status !== 'confirmed' && o.status !== 'failed').length,
      confirmed: orders.filter(o => o.status === 'confirmed').length,
      failed: orders.filter(o => o.status === 'failed').length
    };
  }
}