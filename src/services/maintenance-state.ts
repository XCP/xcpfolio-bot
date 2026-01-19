import { Redis } from '@upstash/redis';

export interface ActiveOrder {
  asset: string;
  txid: string;
  broadcastTime: number;
  price: number;
}

export interface FailedAsset {
  count: number;
  lastError: string;
  lastAttemptTime: number;
}

export interface MaintenanceState {
  lastRun: number;
  activeOrders: Record<string, ActiveOrder>;  // Orders broadcast but not yet confirmed
  failedAssets: Record<string, FailedAsset>;  // Failed during current run
}

/**
 * Maintenance State Manager
 *
 * Separate state manager for OrderMaintenanceService using Redis.
 * Uses different key from fulfillment state to keep the two systems independent.
 */
export class MaintenanceStateManager {
  private redis: Redis;
  private stateKey: string;
  private lockKey: string;
  private state: MaintenanceState | null = null;
  private cacheExpiry = 5000; // 5 second cache to reduce Redis calls
  private lastCacheTime = 0;
  private lockId: string | null = null;

  constructor() {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      throw new Error('Redis/KV credentials required: Set KV_REST_API_URL and KV_REST_API_TOKEN');
    }

    this.redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    this.stateKey = 'xcpfolio:maintenance:state';
    this.lockKey = 'xcpfolio:maintenance:lock';
    console.log('[MaintenanceState] Using Redis/KV for state persistence');
  }

  /**
   * Acquire a distributed lock to prevent concurrent runs
   * Returns true if lock acquired, false if another run is active
   */
  async acquireLock(ttlSeconds: number = 300): Promise<boolean> {
    const lockId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Try to set lock with NX (only if not exists)
    const result = await this.redis.set(this.lockKey, lockId, {
      nx: true,
      ex: ttlSeconds
    });

    if (result === 'OK') {
      this.lockId = lockId;
      console.log(`[MaintenanceState] Acquired distributed lock: ${lockId}`);
      return true;
    }

    // Lock exists - check who owns it
    const existingLock = await this.redis.get<string>(this.lockKey);
    console.log(`[MaintenanceState] Lock already held: ${existingLock}`);
    return false;
  }

  /**
   * Release the distributed lock
   */
  async releaseLock(): Promise<void> {
    if (!this.lockId) return;

    // Only release if we own the lock
    const currentLock = await this.redis.get<string>(this.lockKey);
    if (currentLock === this.lockId) {
      await this.redis.del(this.lockKey);
      console.log(`[MaintenanceState] Released distributed lock: ${this.lockId}`);
    }
    this.lockId = null;
  }

  /**
   * Check if an asset has an active order (for duplicate prevention)
   * This bypasses the cache to get fresh data
   */
  async hasActiveOrderFresh(asset: string): Promise<boolean> {
    try {
      const state = await this.redis.get<MaintenanceState>(this.stateKey);
      return !!(state?.activeOrders?.[asset]);
    } catch (error) {
      console.error('[MaintenanceState] Error checking active order:', error);
      return false;
    }
  }

  /**
   * Load state from Redis
   */
  async loadState(): Promise<MaintenanceState> {
    // Use local cache if fresh
    if (this.state && Date.now() - this.lastCacheTime < this.cacheExpiry) {
      return this.state;
    }

    try {
      const state = await this.redis.get<MaintenanceState>(this.stateKey);

      if (state) {
        this.state = state;
        this.lastCacheTime = Date.now();
        return state;
      }
    } catch (error) {
      console.error('[MaintenanceState] Error loading state from Redis:', error);
    }

    // Default state
    const defaultState: MaintenanceState = {
      lastRun: 0,
      activeOrders: {},
      failedAssets: {},
    };

    this.state = defaultState;
    this.lastCacheTime = Date.now();
    return defaultState;
  }

  /**
   * Save state to Redis
   */
  async saveState(): Promise<void> {
    if (!this.state) return;

    try {
      await this.redis.set(this.stateKey, JSON.stringify(this.state), {
        ex: 60 * 60 * 24 * 30 // 30 day TTL
      });
    } catch (error) {
      console.error('[MaintenanceState] Error saving state to Redis:', error);
      throw error;
    }
  }

  /**
   * Mark an order as active (broadcast but not yet confirmed)
   */
  async markOrderActive(asset: string, txid: string, price: number): Promise<void> {
    const state = await this.loadState();
    state.activeOrders[asset] = {
      asset,
      txid,
      broadcastTime: Date.now(),
      price,
    };
    this.state = state;
    await this.saveState();
    console.log(`[MaintenanceState] Marked order active: ${asset} (${txid})`);
  }

  /**
   * Clear an active order (after confirmation or expiry)
   */
  async clearActiveOrder(asset: string): Promise<void> {
    const state = await this.loadState();
    if (state.activeOrders[asset]) {
      delete state.activeOrders[asset];
      this.state = state;
      await this.saveState();
      console.log(`[MaintenanceState] Cleared active order: ${asset}`);
    }
  }

  /**
   * Get all active orders
   */
  async getActiveOrders(): Promise<Record<string, ActiveOrder>> {
    const state = await this.loadState();
    return state.activeOrders;
  }

  /**
   * Track a failure for an asset
   * Returns the new failure count
   */
  async trackFailure(asset: string, error: string): Promise<number> {
    const state = await this.loadState();

    const existing = state.failedAssets[asset];
    const count = (existing?.count || 0) + 1;

    state.failedAssets[asset] = {
      count,
      lastError: error,
      lastAttemptTime: Date.now(),
    };

    this.state = state;
    await this.saveState();
    console.log(`[MaintenanceState] Tracked failure for ${asset}: attempt ${count}`);
    return count;
  }

  /**
   * Get failure info for an asset
   */
  async getFailure(asset: string): Promise<FailedAsset | null> {
    const state = await this.loadState();
    return state.failedAssets[asset] || null;
  }

  /**
   * Get all failed assets
   */
  async getFailedAssets(): Promise<Record<string, FailedAsset>> {
    const state = await this.loadState();
    return state.failedAssets;
  }

  /**
   * Clear a single failure
   */
  async clearFailure(asset: string): Promise<void> {
    const state = await this.loadState();
    if (state.failedAssets[asset]) {
      delete state.failedAssets[asset];
      this.state = state;
      await this.saveState();
    }
  }

  /**
   * Clear all failures (call at start of each run)
   */
  async clearFailures(): Promise<void> {
    const state = await this.loadState();
    state.failedAssets = {};
    this.state = state;
    await this.saveState();
    console.log('[MaintenanceState] Cleared all failure tracking');
  }

  /**
   * Update last run timestamp
   */
  async setLastRun(timestamp: number = Date.now()): Promise<void> {
    const state = await this.loadState();
    state.lastRun = timestamp;
    this.state = state;
    await this.saveState();
  }

  /**
   * Get last run timestamp
   */
  async getLastRun(): Promise<number> {
    const state = await this.loadState();
    return state.lastRun;
  }

  /**
   * Get the full state (for debugging/status)
   */
  async getState(): Promise<MaintenanceState> {
    return await this.loadState();
  }

  /**
   * Check if an asset has an active order that was broadcast recently
   */
  async hasRecentActiveOrder(asset: string, maxAgeMs: number = 60 * 60 * 1000): Promise<boolean> {
    const state = await this.loadState();
    const order = state.activeOrders[asset];
    if (!order) return false;

    const age = Date.now() - order.broadcastTime;
    return age < maxAgeMs;
  }

  /**
   * Clear stale active orders (older than maxAge)
   * Orders that haven't confirmed within maxAge are considered dropped
   */
  async clearStaleActiveOrders(maxAgeMs: number = 2 * 60 * 60 * 1000): Promise<string[]> {
    const state = await this.loadState();
    const staleAssets: string[] = [];
    const now = Date.now();

    for (const [asset, order] of Object.entries(state.activeOrders)) {
      if (now - order.broadcastTime > maxAgeMs) {
        staleAssets.push(asset);
        delete state.activeOrders[asset];
      }
    }

    if (staleAssets.length > 0) {
      this.state = state;
      await this.saveState();
      console.log(`[MaintenanceState] Cleared ${staleAssets.length} stale active orders`);
    }

    return staleAssets;
  }
}
