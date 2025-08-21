import { Redis } from '@upstash/redis';

export interface FulfillmentState {
  lastBlock: number;
  lastOrderHash: string | null;
  lastChecked: number;
  processedOrders: string[];  // Array for Redis serialization (not Set)
  failedOrders: string[];  // Orders that permanently failed after all retries
  lastCleanup: number;  // Last block we cleaned up old orders
}

export class StateManager {
  private redis: Redis;
  private stateKey: string;
  private state: FulfillmentState | null = null;
  private cacheExpiry = 5000; // 5 second cache to reduce Redis calls
  private lastCacheTime = 0;

  constructor(statePath?: string) {
    // statePath parameter kept for compatibility but ignored
    // Always use Redis/KV for state management
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      throw new Error('Redis/KV credentials required: Set KV_REST_API_URL and KV_REST_API_TOKEN');
    }

    this.redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    this.stateKey = 'fulfillment-state';
    console.log('StateManager: Using Redis/KV for state persistence');
  }

  private async loadState(): Promise<FulfillmentState> {
    // Use local cache if fresh
    if (this.state && Date.now() - this.lastCacheTime < this.cacheExpiry) {
      return this.state;
    }

    try {
      const state = await this.redis.get<FulfillmentState>(this.stateKey);
      
      if (state) {
        this.state = state;
        this.lastCacheTime = Date.now();
        return state;
      }
    } catch (error) {
      console.error('Error loading state from Redis:', error);
    }

    // Default state
    const defaultState: FulfillmentState = {
      lastBlock: 0,
      lastOrderHash: null,
      lastChecked: 0,
      processedOrders: [],
      failedOrders: [],
      lastCleanup: 0,
    };

    this.state = defaultState;
    this.lastCacheTime = Date.now();
    return defaultState;
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;

    try {
      await this.redis.set(this.stateKey, JSON.stringify(this.state), {
        ex: 60 * 60 * 24 * 30 // 30 day TTL
      });
    } catch (error) {
      console.error('Error saving state to Redis:', error);
      throw error; // Re-throw to ensure we know about save failures
    }
  }

  async getLastBlock(): Promise<number> {
    const state = await this.loadState();
    return state.lastBlock;
  }

  async setLastBlock(block: number): Promise<void> {
    const state = await this.loadState();
    state.lastBlock = block;
    state.lastChecked = Date.now();
    this.state = state;
    await this.saveState();
  }

  async getLastOrderHash(): Promise<string | null> {
    const state = await this.loadState();
    return state.lastOrderHash;
  }

  async setLastOrderHash(hash: string | null): Promise<void> {
    const state = await this.loadState();
    state.lastOrderHash = hash;
    this.state = state;
    await this.saveState();
  }

  async isOrderProcessed(orderHash: string): Promise<boolean> {
    const state = await this.loadState();
    return state.processedOrders.includes(orderHash);
  }

  async markOrderProcessed(orderHash: string): Promise<void> {
    const state = await this.loadState();
    if (!state.processedOrders.includes(orderHash)) {
      state.processedOrders.push(orderHash);
      // Keep only last 1000 orders to prevent unbounded growth
      if (state.processedOrders.length > 1000) {
        state.processedOrders = state.processedOrders.slice(-1000);
      }
      this.state = state;
      await this.saveState();
    }
  }

  async getProcessedOrders(): Promise<Set<string>> {
    const state = await this.loadState();
    return new Set(state.processedOrders);
  }

  async getLastCleanup(): Promise<number> {
    const state = await this.loadState();
    return state.lastCleanup;
  }

  async setLastCleanup(block: number): Promise<void> {
    const state = await this.loadState();
    state.lastCleanup = block;
    this.state = state;
    await this.saveState();
  }

  async getState(): Promise<FulfillmentState> {
    return await this.loadState();
  }

  async clearOldOrders(keepCount: number = 100): Promise<void> {
    const state = await this.loadState();
    if (state.processedOrders.length > keepCount) {
      state.processedOrders = state.processedOrders.slice(-keepCount);
      this.state = state;
      await this.saveState();
    }
  }

  async markOrderFailed(orderHash: string): Promise<void> {
    const state = await this.loadState();
    if (!state.failedOrders) {
      state.failedOrders = [];
    }
    if (!state.failedOrders.includes(orderHash)) {
      state.failedOrders.push(orderHash);
      // Keep only last 500 failed orders
      if (state.failedOrders.length > 500) {
        state.failedOrders = state.failedOrders.slice(-500);
      }
      this.state = state;
      await this.saveState();
    }
  }

  async isOrderFailed(orderHash: string): Promise<boolean> {
    const state = await this.loadState();
    return state.failedOrders?.includes(orderHash) || false;
  }

  async getFailedOrders(): Promise<string[]> {
    const state = await this.loadState();
    return state.failedOrders || [];
  }

  async removeFromFailed(orderHash: string): Promise<void> {
    const state = await this.loadState();
    if (state.failedOrders) {
      state.failedOrders = state.failedOrders.filter(h => h !== orderHash);
      this.state = state;
      await this.saveState();
    }
  }
}