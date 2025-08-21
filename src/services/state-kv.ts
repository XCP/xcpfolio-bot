/**
 * State manager using Vercel KV (Upstash Redis) for persistent storage
 * Works across deployments and serverless instances
 */

import { Redis } from '@upstash/redis';

// Initialize Redis client with Vercel KV credentials
const kv = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export interface FulfillmentState {
  lastBlock: number;
  lastOrderHash: string | null;
  lastChecked: number;
  processedOrders: string[];  // Array instead of Set for JSON
  lastCleanup: number;
}

export class KVStateManager {
  private stateKey: string;
  private localCache: FulfillmentState | null = null;
  private cacheExpiry = 5000; // 5 second cache
  private lastCacheTime = 0;

  constructor(stateKey = 'fulfillment-state') {
    this.stateKey = stateKey;
  }

  /**
   * Load state from Vercel KV
   */
  private async loadState(): Promise<FulfillmentState> {
    // Use local cache if fresh
    if (this.localCache && Date.now() - this.lastCacheTime < this.cacheExpiry) {
      return this.localCache;
    }

    try {
      const state = await kv.get<FulfillmentState>(this.stateKey);
      
      if (state) {
        this.localCache = state;
        this.lastCacheTime = Date.now();
        return state;
      }
    } catch (error) {
      console.error('Error loading state from KV:', error);
    }

    // Default state
    const defaultState: FulfillmentState = {
      lastBlock: 0,
      lastOrderHash: null,
      lastChecked: 0,
      processedOrders: [],
      lastCleanup: 0,
    };

    this.localCache = defaultState;
    this.lastCacheTime = Date.now();
    return defaultState;
  }

  /**
   * Save state to Vercel KV
   */
  private async saveState(state: FulfillmentState): Promise<void> {
    try {
      // Update local cache
      this.localCache = state;
      this.lastCacheTime = Date.now();
      
      // Save to KV with 30 day TTL
      await kv.set(this.stateKey, state, {
        ex: 60 * 60 * 24 * 30 // 30 days in seconds
      });
    } catch (error) {
      console.error('Error saving state to KV:', error);
      throw error;
    }
  }

  async getLastBlock(): Promise<number> {
    const state = await this.loadState();
    return state.lastBlock;
  }

  async setLastBlock(block: number): Promise<void> {
    const state = await this.loadState();
    state.lastBlock = block;
    await this.saveState(state);
  }

  async getLastOrderHash(): Promise<string | null> {
    const state = await this.loadState();
    return state.lastOrderHash;
  }

  async setLastOrderHash(hash: string): Promise<void> {
    const state = await this.loadState();
    state.lastOrderHash = hash;
    await this.saveState(state);
  }

  async isOrderProcessed(orderHash: string): Promise<boolean> {
    const state = await this.loadState();
    return state.processedOrders.includes(orderHash);
  }

  async markOrderProcessed(orderHash: string): Promise<void> {
    const state = await this.loadState();
    if (!state.processedOrders.includes(orderHash)) {
      state.processedOrders.push(orderHash);
      state.lastChecked = Date.now();
      
      // Keep only last 1000 orders to prevent unbounded growth
      if (state.processedOrders.length > 1000) {
        state.processedOrders = state.processedOrders.slice(-1000);
      }
      
      await this.saveState(state);
    }
  }

  async unmarkOrderProcessed(orderHash: string): Promise<void> {
    const state = await this.loadState();
    state.processedOrders = state.processedOrders.filter(h => h !== orderHash);
    await this.saveState(state);
  }

  async getState(): Promise<FulfillmentState> {
    return this.loadState();
  }

  async reset(): Promise<void> {
    const defaultState: FulfillmentState = {
      lastBlock: 0,
      lastOrderHash: null,
      lastChecked: 0,
      processedOrders: [],
      lastCleanup: 0,
    };
    await this.saveState(defaultState);
  }

  async getLastCleanup(): Promise<number> {
    const state = await this.loadState();
    return state.lastCleanup || 0;
  }

  async setLastCleanup(block: number): Promise<void> {
    const state = await this.loadState();
    state.lastCleanup = block;
    await this.saveState(state);
  }

  /**
   * Remove old orders from processedOrders
   */
  async cleanupOldOrders(orderHashes: Set<string>): Promise<number> {
    const state = await this.loadState();
    const initialSize = state.processedOrders.length;
    
    // Remove old orders
    state.processedOrders = state.processedOrders.filter(
      hash => !orderHashes.has(hash)
    );
    
    await this.saveState(state);
    return initialSize - state.processedOrders.length;
  }
}

/**
 * Order tracking using Vercel KV
 */
export class KVOrderTracker {
  private orderKeyPrefix: string;
  private indexKey: string;
  private maxOrders = 100;

  constructor(prefix = 'order') {
    this.orderKeyPrefix = prefix;
    this.indexKey = `${prefix}-index`;
  }

  /**
   * Store order status
   */
  async upsertOrder(order: {
    orderHash: string;
    asset: string;
    buyer: string;
    status: string;
    txid?: string;
    timestamp: number;
  }): Promise<void> {
    try {
      // Store the order
      await kv.set(`${this.orderKeyPrefix}:${order.orderHash}`, order, {
        ex: 60 * 60 * 24 * 7 // 7 days TTL
      });

      // Update index (list of recent order hashes)
      let index = await kv.get<string[]>(this.indexKey) || [];
      
      // Remove if already exists and add to front
      index = index.filter(h => h !== order.orderHash);
      index.unshift(order.orderHash);
      
      // Keep only recent orders
      if (index.length > this.maxOrders) {
        index = index.slice(0, this.maxOrders);
      }
      
      await kv.set(this.indexKey, index, {
        ex: 60 * 60 * 24 * 7 // 7 days TTL
      });
    } catch (error) {
      console.error('Error storing order:', error);
    }
  }

  /**
   * Get recent orders
   */
  async getRecentOrders(limit = 50): Promise<any[]> {
    try {
      const index = await kv.get<string[]>(this.indexKey) || [];
      const orderHashes = index.slice(0, limit);
      
      const orders = [];
      for (const hash of orderHashes) {
        const order = await kv.get(`${this.orderKeyPrefix}:${hash}`);
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

  /**
   * Get specific order
   */
  async getOrder(orderHash: string): Promise<any | null> {
    try {
      return await kv.get(`${this.orderKeyPrefix}:${orderHash}`);
    } catch (error) {
      console.error('Error getting order:', error);
      return null;
    }
  }
}