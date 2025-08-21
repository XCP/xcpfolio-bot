/**
 * Order history tracking for status page
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface OrderStatus {
  orderHash: string;
  asset: string;
  assetLongname?: string;
  price: number; // In XCP
  buyer: string;
  seller: string;
  status: 'unconfirmed' | 'listing' | 'pending' | 'processing' | 'broadcasting' | 'confirmed' | 'failed';
  stage?: 'mempool' | 'listing' | 'validation' | 'compose' | 'sign' | 'broadcast' | 'confirmed';
  confirmations?: number; // 0 for mempool, 1+ for confirmed
  orderType?: 'open' | 'filled'; // To distinguish between listing and sale
  purchasedAt: number; // Block time or timestamp
  deliveredAt?: number; // When transaction was broadcast
  confirmedAt?: number; // When transaction was confirmed
  txid?: string;
  error?: string;
  retryCount?: number;
  lastUpdated: number;
}

export class OrderHistoryService {
  private orders: Map<string, OrderStatus>;
  private historyPath: string;
  private maxOrders: number;

  constructor(historyPath?: string, maxOrders = 100) {
    this.historyPath = historyPath || join(process.cwd(), '.order-history.json');
    this.maxOrders = maxOrders;
    this.orders = this.loadHistory();
  }

  private loadHistory(): Map<string, OrderStatus> {
    if (existsSync(this.historyPath)) {
      try {
        const data = JSON.parse(readFileSync(this.historyPath, 'utf-8'));
        return new Map(data.orders || []);
      } catch (error) {
        console.error('Error loading order history:', error);
      }
    }
    return new Map();
  }

  private saveHistory(): void {
    try {
      const ordersArray = Array.from(this.orders.entries());
      // Keep only the most recent orders
      const recentOrders = ordersArray
        .sort((a, b) => b[1].lastUpdated - a[1].lastUpdated)
        .slice(0, this.maxOrders);
      
      const data = {
        version: 1,
        lastUpdated: Date.now(),
        orders: recentOrders
      };
      
      writeFileSync(this.historyPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Error saving order history:', error);
    }
  }

  /**
   * Add or update an order in the history
   */
  upsertOrder(order: OrderStatus): void {
    order.lastUpdated = Date.now();
    this.orders.set(order.orderHash, order);
    this.saveHistory();
  }

  /**
   * Update order status
   */
  updateOrderStatus(
    orderHash: string, 
    status: OrderStatus['status'], 
    stage?: OrderStatus['stage'],
    txid?: string,
    error?: string
  ): void {
    const order = this.orders.get(orderHash);
    if (order) {
      order.status = status;
      if (stage) order.stage = stage;
      if (txid) order.txid = txid;
      if (error) order.error = error;
      order.lastUpdated = Date.now();
      
      // Set delivery time when broadcast
      if (status === 'broadcasting' && !order.deliveredAt) {
        order.deliveredAt = Date.now();
      }
      
      // Set confirmation time
      if (status === 'confirmed' && !order.confirmedAt) {
        order.confirmedAt = Date.now();
      }
      
      this.saveHistory();
    }
  }

  /**
   * Get recent orders for display
   */
  getRecentOrders(limit = 50): OrderStatus[] {
    const orders = Array.from(this.orders.values());
    return orders
      .sort((a, b) => b.purchasedAt - a.purchasedAt)
      .slice(0, limit);
  }

  /**
   * Get order by hash
   */
  getOrder(orderHash: string): OrderStatus | undefined {
    return this.orders.get(orderHash);
  }

  /**
   * Get orders by buyer address
   */
  getOrdersByBuyer(buyerAddress: string): OrderStatus[] {
    return Array.from(this.orders.values())
      .filter(order => order.buyer.toLowerCase() === buyerAddress.toLowerCase())
      .sort((a, b) => b.purchasedAt - a.purchasedAt);
  }

  /**
   * Clean up old orders beyond the limit
   */
  cleanup(): void {
    if (this.orders.size > this.maxOrders * 1.5) {
      const ordersArray = Array.from(this.orders.entries());
      const recentOrders = ordersArray
        .sort((a, b) => b[1].lastUpdated - a[1].lastUpdated)
        .slice(0, this.maxOrders);
      
      this.orders = new Map(recentOrders);
      this.saveHistory();
    }
  }

  /**
   * Get statistics for monitoring
   */
  getStatistics(): {
    total: number;
    pending: number;
    processing: number;
    confirmed: number;
    failed: number;
    averageDeliveryTime: number;
  } {
    const orders = Array.from(this.orders.values());
    const delivered = orders.filter(o => o.deliveredAt && o.purchasedAt);
    
    const stats = {
      total: orders.length,
      pending: orders.filter(o => o.status === 'pending').length,
      processing: orders.filter(o => o.status === 'processing').length,
      confirmed: orders.filter(o => o.status === 'confirmed').length,
      failed: orders.filter(o => o.status === 'failed').length,
      averageDeliveryTime: 0
    };

    if (delivered.length > 0) {
      const totalTime = delivered.reduce((sum, o) => 
        sum + ((o.deliveredAt || 0) - o.purchasedAt), 0
      );
      stats.averageDeliveryTime = Math.round(totalTime / delivered.length / 1000); // in seconds
    }

    return stats;
  }
}