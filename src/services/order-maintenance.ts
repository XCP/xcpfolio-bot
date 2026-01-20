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
   * Log active orders status (read-only, NO clearing)
   * Clearing is ONLY done by TTL (2 hours) - never programmatically
   */
  private async logActiveOrders(): Promise<void> {
    const activeOrders = await this.stateManager.getActiveOrders();
    const count = Object.keys(activeOrders).length;
    if (count > 0) {
      console.log(`[${this.timestamp()}] Active orders in Redis: ${count} (will skip these)`);
    }
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
    let consecutiveUtxoFailures = 0;
    let lastFailedUtxo: string | null = null;

    try {
      console.log(`\n[${this.timestamp()}] Order Maintenance starting...`);
      console.log('═'.repeat(60));
      console.log(`  Address: ${this.config.xcpfolioAddress}`);
      console.log(`  Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE'}`);
      console.log('═'.repeat(60));

      // Record run start
      await this.stateManager.setLastRun();

      // 1. Log active orders (read-only - no clearing!)
      await this.logActiveOrders();

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

      // 4b. Fetch UTXOs from mempool.space to avoid Counterparty stale UTXO issue
      const utxos = await this.bitcoin.fetchUTXOs(this.config.xcpfolioAddress);
      const inputsSet = this.bitcoin.formatInputsSet(utxos);
      console.log(`UTXOs available: ${utxos.length}`);

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

      // 8. Process orders sequentially (no in-run retries - failures handled by next cron run)
      let currentUnconfirmed = unconfirmedCount;
      let processedCount = 0;

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
            feeRate,
            inputsSet  // Use our fetched UTXOs to avoid Counterparty stale UTXO issue
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

          // Update Redis state with actual txid
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

          // Check mempool to see if order actually made it despite the error
          console.log('  Checking mempool after error...');
          await this.sleep(5000);
          const mempoolAfterError = await this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress);

          if (mempoolAfterError.has(asset)) {
            console.log('  ✅ Order found in mempool despite error - success');
            currentUnconfirmed++;
            return { asset, price, success: true, txid: 'found-in-mempool' };
          }

          // Asset stays marked in Redis - NEVER clear it here
          // Better to skip for 2 hours than create duplicates
          console.log('  Keeping marked in Redis (TTL will expire in 2h if truly failed)');

          // Check for insufficient BTC - bail completely
          if (this.isInsufficientFundsError(msg)) {
            console.log('\n💸 Insufficient BTC - bailing early.');
            return { asset, price, success: false, error: msg };
          }

          // Track consecutive UTXO failures (same stale UTXO = pending tx blocking)
          const utxoMatch = msg.match(/UTXO not found.*?([a-f0-9]{64}:\d+)/i);
          if (utxoMatch) {
            const failedUtxo = utxoMatch[1];
            if (failedUtxo === lastFailedUtxo) {
              consecutiveUtxoFailures++;
            } else {
              consecutiveUtxoFailures = 1;
              lastFailedUtxo = failedUtxo;
            }
          }

          return { asset, price, success: false, error: msg };
        }
      };

      // Process each asset once - no in-run retries (like fulfillment service)
      for (let i = 0; i < toProcess.length; i++) {
        const { asset, price } = toProcess[i];
        const result = await processAsset(asset, price, i, toProcess.length);

        if (result === null && currentUnconfirmed >= this.config.maxMempoolTxs!) {
          // Mempool full - stop processing
          console.log(`Stopping: mempool at capacity`);
          break;
        }

        if (result) {
          results.push(result);
          if (result.success) {
            processedCount++;
          }

          // Check if we should bail on insufficient funds
          if (!result.success && this.isInsufficientFundsError(result.error || '')) {
            break;
          }

          // Bail if same UTXO keeps failing (pending tx needs to confirm)
          if (consecutiveUtxoFailures >= 3) {
            console.log(`\n⏳ Same UTXO failed ${consecutiveUtxoFailures}x - pending tx blocking. Waiting for confirmation.`);
            break;
          }
        }

        // Wait between broadcasts
        await this.sleep(this.config.waitAfterBroadcast!);
      }

      // Summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      const notProcessed = toProcess.length - results.length;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log('\n' + '═'.repeat(60));
      console.log('  SUMMARY');
      console.log('═'.repeat(60));
      console.log(`  Created: ${successful} orders`);
      console.log(`  Failed: ${failed} (will retry next run)`);
      console.log(`  Not processed: ${notProcessed} (mempool full or bailed)`);
      console.log(`  Duration: ${elapsed}s`);
      console.log('═'.repeat(60) + '\n');

      // Notify if orders were created
      if (successful > 0) {
        await NotificationService.success('📦 Order maintenance complete', {
          created: successful,
          failed,
          notProcessed,
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
    // "UTXO not found" is a stale UTXO issue, not insufficient funds
    if (lower.includes('utxo') && lower.includes('not found')) {
      return false;
    }
    return lower.includes('insufficient') ||
           lower.includes('not enough') ||
           lower.includes('balance') ||
           lower.includes('no utxos');
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
