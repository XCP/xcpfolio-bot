import { CounterpartyService } from './counterparty';
import { BitcoinService, SignedTransaction } from './bitcoin';
import { NotificationService } from './notifications';
import { TX_LIMITS, TIME, ASSET_CONFIG } from '../constants';

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
}

interface AssetPrice {
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
 */
export class OrderMaintenanceService {
  private counterparty: CounterpartyService;
  private bitcoin: BitcoinService;
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
    console.log(`[OrderMaintenance] Loaded ${this.prices.size} asset prices`);
  }

  /**
   * Set prices from a Map
   */
  setPrices(prices: Map<string, number>): void {
    this.prices = prices;
    console.log(`[OrderMaintenance] Set ${this.prices.size} asset prices`);
  }

  /**
   * Main maintenance run
   *
   * @returns Results array, or empty if bailed early
   */
  async run(): Promise<MaintenanceResult[]> {
    if (this.isRunning) {
      console.log('[OrderMaintenance] Already running, skipping');
      return [];
    }

    this.isRunning = true;
    const results: MaintenanceResult[] = [];

    try {
      console.log('\n' + '═'.repeat(50));
      console.log('  ORDER MAINTENANCE');
      console.log('═'.repeat(50));
      console.log(`  Address: ${this.config.xcpfolioAddress}`);
      console.log(`  Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE'}`);
      console.log('═'.repeat(50) + '\n');

      // 1. Check mempool capacity - bail if at limit
      const unconfirmedCount = await this.bitcoin.getUnconfirmedTxCount(this.config.xcpfolioAddress);
      if (unconfirmedCount >= this.config.maxMempoolTxs!) {
        console.log(`[OrderMaintenance] Mempool at capacity (${unconfirmedCount}/${this.config.maxMempoolTxs}). Bailing.`);
        return results;
      }
      console.log(`[OrderMaintenance] Mempool: ${unconfirmedCount}/${this.config.maxMempoolTxs}`);

      // 2. Get lowest fee rate from mempool.space
      const feeRates = await this.bitcoin.getFeeRates();
      // Use minimumFee for the cheapest rate
      const feeRate = Math.max(feeRates.minimumFee, 0.15);
      console.log(`[OrderMaintenance] Fee rate: ${feeRate} sat/vB (minimum from mempool.space)`);

      // 3. Get XCPFOLIO.* balances (assets that need to be listed)
      const balances = await this.counterparty.getXcpfolioBalances(this.config.xcpfolioAddress);

      if (balances.size === 0) {
        console.log('[OrderMaintenance] No XCPFOLIO.* balances - all assets are listed!');
        return results;
      }
      console.log(`[OrderMaintenance] Found ${balances.size} assets with balance`);

      // 4. Get existing orders (confirmed + unconfirmed) to avoid double-broadcasting
      const [existingOrders, pendingOrders] = await Promise.all([
        this.counterparty.getOpenOrderAssets(this.config.xcpfolioAddress),
        this.counterparty.getMempoolOrderAssets(this.config.xcpfolioAddress)
      ]);

      // Combine existing and pending orders
      const alreadyListed = new Set([...existingOrders, ...pendingOrders]);
      console.log(`[OrderMaintenance] Already listed: ${existingOrders.size} confirmed, ${pendingOrders.size} pending`);

      // 5. Build list of assets to process (only those with prices AND not already listed)
      const toProcess: { asset: string; price: number }[] = [];
      for (const [asset, qty] of balances) {
        // Skip if already has an order (confirmed or pending)
        if (alreadyListed.has(asset)) {
          console.log(`  ✓  ${asset}: already listed, skipping`);
          continue;
        }

        const price = this.prices.get(asset);
        if (price && price > 0) {
          toProcess.push({ asset, price });
        } else {
          console.log(`  ⚠️  ${asset}: no price configured, skipping`);
        }
      }

      if (toProcess.length === 0) {
        console.log('[OrderMaintenance] No assets with prices to list');
        return results;
      }

      console.log(`\n🎯 ${toProcess.length} assets to list:\n`);
      for (const { asset, price } of toProcess.slice(0, 10)) {
        console.log(`   ${asset}: ${price} XCP`);
      }
      if (toProcess.length > 10) {
        console.log(`   ... and ${toProcess.length - 10} more`);
      }

      if (this.config.dryRun) {
        console.log('\n🔍 Dry run - no transactions will be broadcast');
        return toProcess.map(({ asset, price }) => ({
          asset,
          price,
          success: true,
          txid: 'dry-run'
        }));
      }

      // 5. Process orders
      let currentUnconfirmed = unconfirmedCount;

      for (let i = 0; i < toProcess.length; i++) {
        const { asset, price } = toProcess[i];
        console.log(`\n[${i + 1}/${toProcess.length}] ${asset} @ ${price} XCP`);

        // Check mempool limit before each order
        if (currentUnconfirmed >= this.config.maxMempoolTxs!) {
          console.log(`\n[OrderMaintenance] Mempool at capacity. Bailing (next run handles remaining).`);
          break;
        }

        try {
          // Compose order
          console.log('   Composing...');
          const getQuantity = BigInt(Math.round(price * 100000000)); // XCP has 8 decimals

          const rawTx = await this.counterparty.composeOrder(
            this.config.xcpfolioAddress,
            `${ASSET_CONFIG.XCPFOLIO_PREFIX}${asset}`, // XCPFOLIO.ASSETNAME
            1, // give 1 unit
            ASSET_CONFIG.XCP, // get XCP
            getQuantity,
            this.config.orderExpiration!,
            feeRate
          );

          // Sign transaction
          console.log('   Signing...');
          const signedTx = await this.bitcoin.signTransaction(
            rawTx,
            this.config.xcpfolioAddress,
            this.config.privateKey
          );
          console.log(`   Signed: ${signedTx.vsize} vbytes, ${signedTx.fee} sats fee`);

          // Broadcast
          console.log('   Broadcasting...');
          const txid = await this.bitcoin.broadcastTransaction(signedTx.hex);
          console.log(`   ✅ ${txid}`);

          results.push({ asset, price, success: true, txid });
          currentUnconfirmed++;

          // Wait between broadcasts
          await this.sleep(this.config.waitAfterBroadcast!);

        } catch (err: any) {
          const msg = err.message || String(err);
          console.log(`   ❌ ${msg}`);

          // Check for insufficient BTC - bail completely
          if (this.isInsufficientFundsError(msg)) {
            console.log('\n💸 Insufficient BTC - bailing early. Need to fund address.');
            await NotificationService.warning('Order maintenance: Insufficient BTC', {
              asset,
              error: msg
            });
            results.push({ asset, price, success: false, error: msg });
            break;
          }

          results.push({ asset, price, success: false, error: msg });
          // Continue to next asset on other errors
        }
      }

      // Summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log('\n' + '═'.repeat(50));
      console.log('  SUMMARY');
      console.log('═'.repeat(50));
      console.log(`  Created: ${successful} orders`);
      console.log(`  Failed: ${failed}`);
      console.log(`  Remaining: ${toProcess.length - results.length} (next run)`);
      console.log('═'.repeat(50) + '\n');

      // Notify if orders were created
      if (successful > 0) {
        await NotificationService.success('📦 Order maintenance complete', {
          created: successful,
          failed,
          remaining: toProcess.length - results.length
        });
      }

      return results;

    } catch (error) {
      console.error('[OrderMaintenance] Fatal error:', error);
      await NotificationService.error('Order maintenance failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      this.isRunning = false;
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
  getStatus(): { isRunning: boolean; pricesLoaded: number } {
    return {
      isRunning: this.isRunning,
      pricesLoaded: this.prices.size
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
