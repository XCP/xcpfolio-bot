import { CounterpartyService } from './counterparty';
import { BitcoinService } from './bitcoin';
import { NotificationService } from './notifications';
import { MaintenanceStateManager } from './maintenance-state';
import { TX_LIMITS, ASSET_CONFIG, MAINTENANCE_RETRY_STRATEGY } from '../constants';

export interface OrderMaintenanceConfig {
  xcpfolioAddress: string;
  privateKey: string; // WIF format
  network?: 'mainnet' | 'testnet';
  dryRun?: boolean;
  maxMempoolTxs?: number;
  orderExpiration?: number; // blocks (~8 weeks = 8064)
  waitAfterBroadcast?: number; // ms to wait between broadcasts
  pricesPath?: string; // Path to prices JSON
}

export interface MaintenanceResult {
  asset: string;
  price: number;
  success: boolean;
  txid?: string;
  error?: string;
  retries?: number;
}

interface AssetPrice {
  asset: string;
  price: number;
}

interface ToProcess {
  asset: string;
  price: number;
}

/**
 * Order Maintenance Service
 *
 * Automatically re-lists XCPFOLIO.* subassets when orders expire.
 *
 * Logic:
 * - If we have a balance of XCPFOLIO.* asset, it means the order expired
 *   (active orders escrow the asset, so balance > 0 = not listed)
 * - For each asset with balance, create a new DEX order
 * - Uses lowest fee rate from mempool.space
 * - Bails early if insufficient BTC or mempool at capacity
 *
 * Robustness features:
 * - Redis state persistence for recovery on restart
 * - Progressive retry with backoff for transient failures
 * - Post-broadcast mempool verification
 * - Detailed per-asset logging
 */
export class OrderMaintenanceService {
  private counterparty: CounterpartyService;
  private bitcoin: BitcoinService;
  private stateManager: MaintenanceStateManager;
  private config: OrderMaintenanceConfig;
  private prices: Map<string, number> = new Map();
  private isRunning: boolean = false;

  constructor(config: OrderMaintenanceConfig) {
    this.config = {
      ...config,
      maxMempoolTxs: config.maxMempoolTxs || TX_LIMITS.MAX_MEMPOOL_TXS,
      orderExpiration: config.orderExpiration || 8064, // ~8 weeks
      waitAfterBroadcast: config.waitAfterBroadcast || 10000,
    };

    this.counterparty = new CounterpartyService();
    this.bitcoin = new BitcoinService(config.network || 'mainnet');
    this.stateManager = new MaintenanceStateManager();
  }

  /**
   * Load prices from JSON data
   * Can be called externally with prices from CSV or config
   */
  loadPrices(prices: AssetPrice[]): void {
    this.prices.clear();
    for (const { asset, price } of prices) {
      if (asset && price > 0) {
        this.prices.set(asset, price);
      }
    }
    console.log(`[${this.timestamp()}] Loaded ${this.prices.size} asset prices`);
  }

  /**
   * Set prices from a Map
   */
  setPrices(prices: Map<string, number>): void {
    this.prices = prices;
    console.log(`[${this.timestamp()}] Set ${this.prices.size} asset prices`);
  }

  /**
   * Format timestamp for logging
   */
  private timestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Recover active orders from previous run
   * Checks if orders are confirmed or still pending, clears stale ones
   */
  private async recoverActiveOrders(): Promise<void> {
    console.log(`[${this.timestamp()}] Checking for active orders from previous run...`);

    // Clear stale orders (older than 2 hours)
    const staleAssets = await this.stateManager.clearStaleActiveOrders(
      MAINTENANCE_RETRY_STRATEGY.STALE_ORDER_AGE
    );
    if (staleAssets.length > 0) {
      console.log(`  Cleared ${staleAssets.length} stale orders: ${staleAssets.join(', ')}`);
    }

    const activeOrders = await this.stateManager.getActiveOrders();
    const activeCount = Object.keys(activeOrders).length;

    if (activeCount === 0) {
      console.log('  No active orders to recover');
      return;
    }

    console.log(`  Found ${activeCount} active orders to check`);

    // Get current state from chain
    const [existingOrders, pendingOrders] = await Promise.all([
      this.counterparty.getOpenOrderAssets(this.config.xcpfolioAddress),
      this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress)
    ]);

    let confirmed = 0;
    let pending = 0;
    let dropped = 0;

    for (const [asset, order] of Object.entries(activeOrders)) {
      if (existingOrders.has(asset)) {
        // Order is confirmed on chain
        await this.stateManager.clearActiveOrder(asset);
        confirmed++;
        console.log(`  ✓ ${asset}: confirmed on chain`);
      } else if (pendingOrders.has(asset)) {
        // Order still in mempool
        pending++;
        console.log(`  ⏳ ${asset}: still pending in mempool`);
      } else {
        // Order dropped - will be re-created
        await this.stateManager.clearActiveOrder(asset);
        dropped++;
        console.log(`  ⚠ ${asset}: dropped (will re-create)`);
      }
    }

    console.log(`  Recovery complete: ${confirmed} confirmed, ${pending} pending, ${dropped} dropped`);
  }

  /**
   * Calculate backoff delay based on failure count
   */
  private getBackoffDelay(failureCount: number): number {
    if (failureCount < MAINTENANCE_RETRY_STRATEGY.QUICK_ATTEMPTS) {
      return MAINTENANCE_RETRY_STRATEGY.QUICK_BACKOFF;
    } else if (failureCount < MAINTENANCE_RETRY_STRATEGY.MODERATE_ATTEMPTS) {
      return MAINTENANCE_RETRY_STRATEGY.MODERATE_BACKOFF;
    } else if (failureCount < MAINTENANCE_RETRY_STRATEGY.EXTENDED_ATTEMPTS) {
      return MAINTENANCE_RETRY_STRATEGY.EXTENDED_BACKOFF;
    }
    return MAINTENANCE_RETRY_STRATEGY.MAX_BACKOFF;
  }

  /**
   * Main maintenance run
   *
   * @returns Results array, or empty if bailed early
   */
  async run(): Promise<MaintenanceResult[]> {
    if (this.isRunning) {
      console.log(`[${this.timestamp()}] Already running (local), skipping`);
      return [];
    }

    // Try to acquire distributed lock (5 minute TTL)
    const lockAcquired = await this.stateManager.acquireLock(300);
    if (!lockAcquired) {
      console.log(`[${this.timestamp()}] Another instance is running (distributed lock), skipping`);
      return [];
    }

    this.isRunning = true;
    const results: MaintenanceResult[] = [];
    const startTime = Date.now();
    const processedThisRun = new Set<string>(); // Track assets we've broadcast in THIS run

    try {
      console.log(`\n[${this.timestamp()}] Order Maintenance starting...`);
      console.log('═'.repeat(60));
      console.log(`  Address: ${this.config.xcpfolioAddress}`);
      console.log(`  Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE'}`);
      console.log('═'.repeat(60));

      // Record run start
      await this.stateManager.setLastRun();

      // 1. Recover active orders from previous run
      await this.recoverActiveOrders();

      // 2. Clear failure tracking for fresh run (failures are per-run)
      await this.stateManager.clearFailures();

      // 3. Check mempool capacity - bail if at limit
      const unconfirmedCount = await this.bitcoin.getUnconfirmedTxCount(this.config.xcpfolioAddress);
      if (unconfirmedCount >= this.config.maxMempoolTxs!) {
        console.log(`\n❌ Mempool at capacity (${unconfirmedCount}/${this.config.maxMempoolTxs}). Bailing.`);
        return results;
      }
      console.log(`\nMempool: ${unconfirmedCount}/${this.config.maxMempoolTxs}`);

      // 4. Get actual minimum fee rate (supports sub-1 sat/vB)
      const feeRate = await this.bitcoin.getActualMinimumFeeRate();
      console.log(`Fee rate: ${feeRate.toFixed(2)} sat/vB`);

      // 5. Get XCPFOLIO.* balances (assets that need to be listed)
      const balances = await this.counterparty.getXcpfolioBalances(this.config.xcpfolioAddress);
      console.log(`Assets with balance: ${balances.size}`);

      if (balances.size === 0) {
        console.log('\n✅ No XCPFOLIO.* balances - all assets are listed!');
        return results;
      }

      // 6. Get existing orders (confirmed + unconfirmed) to avoid double-broadcasting
      const [existingOrders, pendingOrders] = await Promise.all([
        this.counterparty.getOpenOrderAssets(this.config.xcpfolioAddress),
        this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress)
      ]);

      // Also check our tracked active orders (for orders we just broadcast)
      const activeOrders = await this.stateManager.getActiveOrders();
      const activeAssets = new Set(Object.keys(activeOrders));

      // Combine existing, pending, and active orders
      const alreadyListed = new Set([...existingOrders, ...pendingOrders, ...activeAssets]);
      console.log(`Already listed: ${existingOrders.size} confirmed, ${pendingOrders.size} pending, ${activeAssets.size} tracked`);

      // 7. Build list of assets to process (only those with prices AND not already listed)
      const toProcess: ToProcess[] = [];
      const skipped = { alreadyListed: 0, noPrice: 0 };

      for (const [asset, qty] of balances) {
        if (alreadyListed.has(asset)) {
          skipped.alreadyListed++;
          continue;
        }

        const price = this.prices.get(asset);
        if (price && price > 0) {
          toProcess.push({ asset, price });
        } else {
          skipped.noPrice++;
        }
      }

      console.log(`To process: ${toProcess.length}`);
      console.log(`Skipped: ${skipped.alreadyListed} already listed, ${skipped.noPrice} no price`);

      if (toProcess.length === 0) {
        console.log('\n✅ No assets to list');
        return results;
      }

      if (this.config.dryRun) {
        console.log('\n🔍 DRY RUN - no transactions will be broadcast\n');
        for (const { asset, price } of toProcess.slice(0, 20)) {
          console.log(`  Would list: ${asset} @ ${price} XCP`);
        }
        if (toProcess.length > 20) {
          console.log(`  ... and ${toProcess.length - 20} more`);
        }
        return toProcess.map(({ asset, price }) => ({
          asset,
          price,
          success: true,
          txid: 'dry-run'
        }));
      }

      // 8. Process orders with retry support
      let currentUnconfirmed = unconfirmedCount;
      const toRetry: ToProcess[] = [];
      let processedCount = 0;
      let retryCount = 0;

      // DEFENSE IN DEPTH: Track pending orders in a mutable Set
      // This gets updated as we process, so we don't need to re-query mempool for each asset
      const pendingOrdersSet = new Set([...pendingOrders]);

      // Helper to process a single asset
      const processAsset = async (
        asset: string,
        price: number,
        index: number,
        total: number
      ): Promise<MaintenanceResult | null> => {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[${index + 1}/${total}] ${asset} @ ${price} XCP`);

        // Check mempool limit
        if (currentUnconfirmed >= this.config.maxMempoolTxs!) {
          console.log('  ⚠ Mempool at capacity - stopping');
          return null; // Signal to stop
        }

        // DUPLICATE PREVENTION LAYER 1: Check local tracking for this run
        if (processedThisRun.has(asset)) {
          console.log('  ⏭ Already processed in this run - skipping');
          return null;
        }

        // DUPLICATE PREVENTION LAYER 2: Check tracked pending orders Set
        if (pendingOrdersSet.has(asset)) {
          console.log('  ⏭ Already in pending orders Set - skipping');
          return null;
        }

        // DUPLICATE PREVENTION LAYER 3: Re-check Redis state (fresh, bypasses cache)
        const hasActiveOrder = await this.stateManager.hasActiveOrderFresh(asset);
        if (hasActiveOrder) {
          console.log('  ⏭ Already has active order in state - skipping');
          return null;
        }

        // DUPLICATE PREVENTION LAYER 4: Final mempool re-check before composing
        // This catches any external broadcasts since the run started
        const freshPending = await this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress);
        if (freshPending.has(asset)) {
          console.log('  ⏭ Detected in fresh mempool check - skipping');
          // Also update our local set
          pendingOrdersSet.add(asset);
          return null;
        }

        // CRITICAL: Mark as "in progress" BEFORE composing to prevent race conditions
        // This ensures even if we error out, we won't retry without checking
        processedThisRun.add(asset);
        pendingOrdersSet.add(asset);
        await this.stateManager.markOrderActive(asset, 'pending', price);

        try {
          // Compose order
          console.log('  Composing...');
          const getQuantity = BigInt(Math.round(price * 100000000)); // XCP has 8 decimals

          const rawTx = await this.counterparty.composeOrder(
            this.config.xcpfolioAddress,
            `${ASSET_CONFIG.XCPFOLIO_PREFIX}${asset}`,
            1, // give 1 unit
            ASSET_CONFIG.XCP,
            getQuantity,
            this.config.orderExpiration!,
            feeRate
          );

          // Sign transaction
          console.log('  Signing...');
          const signedTx = await this.bitcoin.signTransaction(
            rawTx,
            this.config.xcpfolioAddress,
            this.config.privateKey
          );
          console.log(`  Signed: ${signedTx.vsize} vbytes, ${signedTx.fee} sats`);

          // Broadcast
          console.log('  Broadcasting...');
          const txid = await this.bitcoin.broadcastTransaction(signedTx.hex);
          console.log(`  Broadcast: ${txid}`);

          // Update active order with actual txid (was marked as 'pending' before compose)
          await this.stateManager.markOrderActive(asset, txid, price);

          // Post-broadcast verification (optional, adds latency)
          console.log('  Verifying...');
          await this.sleep(MAINTENANCE_RETRY_STRATEGY.MEMPOOL_CHECK_DELAY);
          const pendingCheck = await this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress);
          if (pendingCheck.has(asset)) {
            console.log('  ✅ Verified in mempool');
          } else {
            console.log('  ⚠ Warning: not yet in mempool (may still propagate)');
          }

          currentUnconfirmed++;
          await this.stateManager.clearFailure(asset);

          return { asset, price, success: true, txid };

        } catch (err: any) {
          const msg = err.message || String(err);
          console.log(`  ❌ ${msg}`);

          // CRITICAL: Check if order actually made it to mempool despite the error
          // This handles cases where broadcast succeeds but we get a network error on response
          console.log('  Checking mempool after error...');
          await this.sleep(2000); // Give it a moment to propagate
          const mempoolAfterError = await this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress);

          if (mempoolAfterError.has(asset)) {
            console.log('  ✅ Order found in mempool despite error - treating as success');
            currentUnconfirmed++;
            await this.stateManager.clearFailure(asset);
            return { asset, price, success: true, txid: 'confirmed-after-error' };
          }

          // Order NOT in mempool - safe to retry
          // Clear "in progress" markers since the attempt truly failed
          console.log('  Order not in mempool - clearing markers for retry');
          processedThisRun.delete(asset);
          pendingOrdersSet.delete(asset);
          await this.stateManager.clearActiveOrder(asset);

          // Check for insufficient BTC - bail completely
          if (this.isInsufficientFundsError(msg)) {
            console.log('\n💸 Insufficient BTC - bailing early. Need to fund address.');
            await NotificationService.warning('Order maintenance: Insufficient BTC', {
              asset,
              error: msg
            });
            return { asset, price, success: false, error: msg };
          }

          // Track failure and check for retry
          const failureCount = await this.stateManager.trackFailure(asset, msg);

          if (failureCount >= MAINTENANCE_RETRY_STRATEGY.MAX_ATTEMPTS) {
            console.log(`  Max retries (${MAINTENANCE_RETRY_STRATEGY.MAX_ATTEMPTS}) reached for ${asset}`);
            await NotificationService.warning(`Order maintenance: Max retries for ${asset}`, {
              attempts: failureCount,
              lastError: msg
            });
            return { asset, price, success: false, error: msg, retries: failureCount };
          }

          // Alert at thresholds
          if (failureCount === MAINTENANCE_RETRY_STRATEGY.ALERT_AT_5) {
            await NotificationService.warning(`Order maintenance: 5 failures for ${asset}`, { error: msg });
          } else if (failureCount === MAINTENANCE_RETRY_STRATEGY.ALERT_AT_10) {
            await NotificationService.warning(`Order maintenance: 10 failures for ${asset}`, { error: msg });
          }

          // Queue for retry with backoff
          const backoffMs = this.getBackoffDelay(failureCount);
          console.log(`  Retry ${failureCount}/${MAINTENANCE_RETRY_STRATEGY.MAX_ATTEMPTS} after ${backoffMs / 1000}s backoff`);
          toRetry.push({ asset, price });

          return null; // Will retry
        }
      };

      // Process initial list
      for (let i = 0; i < toProcess.length; i++) {
        const { asset, price } = toProcess[i];
        const result = await processAsset(asset, price, processedCount, toProcess.length + toRetry.length);

        if (result === null && currentUnconfirmed >= this.config.maxMempoolTxs!) {
          // Mempool full - stop processing
          break;
        }

        if (result) {
          results.push(result);
          processedCount++;

          // Check if we should bail on insufficient funds
          if (!result.success && this.isInsufficientFundsError(result.error || '')) {
            break;
          }
        }

        // Wait between broadcasts
        await this.sleep(this.config.waitAfterBroadcast!);
      }

      // Process retries
      while (toRetry.length > 0 && currentUnconfirmed < this.config.maxMempoolTxs!) {
        const { asset, price } = toRetry.shift()!;
        const failure = await this.stateManager.getFailure(asset);
        const backoffMs = this.getBackoffDelay(failure?.count || 0);

        console.log(`\n⏳ Waiting ${backoffMs / 1000}s before retry of ${asset}...`);
        await this.sleep(backoffMs);

        retryCount++;
        const result = await processAsset(asset, price, processedCount, toProcess.length);

        if (result === null && currentUnconfirmed >= this.config.maxMempoolTxs!) {
          break;
        }

        if (result) {
          results.push(result);
          processedCount++;

          if (!result.success && this.isInsufficientFundsError(result.error || '')) {
            break;
          }
        }
      }

      // Summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      const remaining = toProcess.length - results.length + toRetry.length;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log('\n' + '═'.repeat(60));
      console.log('  SUMMARY');
      console.log('═'.repeat(60));
      console.log(`  Created: ${successful} orders`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Retries: ${retryCount}`);
      console.log(`  Remaining: ${remaining} (next run)`);
      console.log(`  Duration: ${elapsed}s`);
      console.log('═'.repeat(60) + '\n');

      // Notify if orders were created
      if (successful > 0) {
        await NotificationService.success('📦 Order maintenance complete', {
          created: successful,
          failed,
          retries: retryCount,
          remaining,
          duration: elapsed
        });
      }

      return results;

    } catch (error) {
      console.error(`[${this.timestamp()}] Fatal error:`, error);
      await NotificationService.error('Order maintenance failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      this.isRunning = false;
      // Release distributed lock
      await this.stateManager.releaseLock();
    }
  }

  /**
   * Check if error indicates insufficient BTC
   */
  private isInsufficientFundsError(msg: string): boolean {
    const lower = msg.toLowerCase();
    return lower.includes('insufficient') ||
           lower.includes('not enough') ||
           lower.includes('balance') ||
           lower.includes('utxo') && lower.includes('found');
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    pricesLoaded: number;
    lastRun: number;
    activeOrders: number;
    failedAssets: number;
  }> {
    const state = await this.stateManager.getState();
    return {
      isRunning: this.isRunning,
      pricesLoaded: this.prices.size,
      lastRun: state.lastRun,
      activeOrders: Object.keys(state.activeOrders).length,
      failedAssets: Object.keys(state.failedAssets).length,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
