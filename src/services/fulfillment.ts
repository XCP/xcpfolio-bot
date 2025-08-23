import { CounterpartyService, AssetInfo } from './counterparty';
import { BitcoinService, SignedTransaction } from './bitcoin';
import { StateManager } from './state';
import { OrderHistoryService, OrderStatus } from './order-history';
import { NotificationService } from './notifications';
import { Order } from '../types';
import { RETRY_STRATEGY, TX_LIMITS, TIME, ASSET_CONFIG } from '../constants';

export interface FulfillmentConfig {
  xcpfolioAddress: string;
  privateKey: string; // WIF format
  network?: 'mainnet' | 'testnet';
  dryRun?: boolean;
  maxMempoolTxs?: number; // Max unconfirmed txs (default: 25, hard limit)
  composeCooldown?: number; // MS to wait between compose calls (default: 10000)
  maxPreBroadcastRetries?: number; // Retries before broadcast (default: 10)
  rbfEnabled?: boolean; // Enable RBF for stuck transactions (default: true)
  stuckTxThreshold?: number; // Blocks before considering tx stuck (default: 3)
  maxTotalFeeSats?: number; // Maximum fee per transaction in satoshis (default: 10000 = 0.0001 BTC)
  maxFeeRateForNewTx?: number; // Maximum fee rate for new transactions in sat/vB (default: 100)
  orderHistoryPath?: string; // Path to save order history (default: .order-history.json)
  statePath?: string; // Path to save fulfillment state (default: .fulfillment-state.json)
}

export interface ProcessResult {
  orderHash: string;
  asset: string;
  buyer: string;
  success: boolean;
  txid?: string;
  error?: string;
  stage?: 'validation' | 'compose' | 'sign' | 'broadcast' | 'confirmed';
  isRbf?: boolean;
}

interface OrderTransaction {
  orderHash: string;
  asset: string;
  buyer: string;
  txid: string;  // Current txid
  originalTxid: string;  // Original txid before any RBF
  rbfHistory: string[];  // All txids including RBF replacements
  broadcastTime: number;
  broadcastBlock: number;
  feeRate: number;
  isRbf: boolean;
  rbfCount: number;
  needsRbf?: boolean;
  droppedFromMempool?: boolean;
}

interface ProcessingState {
  // Track active transactions per order
  orderTransactions: Map<string, OrderTransaction>;
  // Track compose cooldown
  lastComposeTime: number;
  // Pre-broadcast failures (safe to retry many times)
  preBroadcastFailures: Map<string, { 
    count: number; 
    lastError: string; 
    stage: string;
    firstFailureTime: number;
    lastAttemptTime: number;
  }>;
  // Last time we checked for orders
  lastCheckTime: number;
  // Current processing order (for crash recovery)
  currentProcessingOrder: string | null;
}

/**
 * Single-worker fulfillment processor for XCPFOLIO asset transfers
 * 
 * This service monitors the Counterparty DEX for filled XCPFOLIO.* orders
 * and automatically transfers ownership of the underlying asset to the buyer.
 * 
 * Key features:
 * - Single-threaded processing to prevent race conditions
 * - Progressive retry strategy for pre-broadcast failures
 * - RBF (Replace-By-Fee) support for stuck transactions
 * - Mempool management with 25 transaction limit
 * - Comprehensive error tracking and alerting
 * 
 * @example
 * const processor = new FulfillmentProcessor({
 *   xcpfolioAddress: '1Bot...',
 *   privateKey: 'WIF_KEY',
 *   network: 'mainnet',
 *   rbfEnabled: true
 * });
 * 
 * const results = await processor.process();
 */
export class FulfillmentProcessor {
  private counterparty: CounterpartyService;
  private bitcoin: BitcoinService;
  private state: StateManager;
  public orderHistory: OrderHistoryService;
  private config: FulfillmentConfig;
  private processingState: ProcessingState;
  
  // Single worker lock
  private isProcessing: boolean = false;
  private processingLock: Promise<void> | null = null;
  private shouldStop: boolean = false;

  constructor(config: FulfillmentConfig) {
    this.config = {
      ...config,
      maxMempoolTxs: config.maxMempoolTxs || TX_LIMITS.MAX_MEMPOOL_TXS,
      composeCooldown: config.composeCooldown || TX_LIMITS.COMPOSE_COOLDOWN,
      maxPreBroadcastRetries: config.maxPreBroadcastRetries || RETRY_STRATEGY.PRE_BROADCAST.QUICK_ATTEMPTS,
      rbfEnabled: config.rbfEnabled !== false,
      stuckTxThreshold: config.stuckTxThreshold || RETRY_STRATEGY.RBF.FIRST_THRESHOLD_BLOCKS,
      maxTotalFeeSats: config.maxTotalFeeSats || TX_LIMITS.MAX_TOTAL_FEE_SATS,
      maxFeeRateForNewTx: config.maxFeeRateForNewTx || TX_LIMITS.MAX_FEE_RATE_FOR_NEW_TX,
    };

    this.counterparty = new CounterpartyService();
    this.bitcoin = new BitcoinService(config.network || 'mainnet');
    this.state = new StateManager(config.statePath);
    this.orderHistory = new OrderHistoryService(config.orderHistoryPath);
    
    this.processingState = {
      orderTransactions: new Map(),
      lastComposeTime: 0,
      preBroadcastFailures: new Map(),
      lastCheckTime: 0,
      currentProcessingOrder: null,
    };
  }

  /**
   * Main processing loop - ensures single worker execution
   * 
   * This method is the entry point for order processing. It ensures only one
   * instance runs at a time through a locking mechanism, preventing double
   * broadcasts and race conditions.
   * 
   * Processing steps:
   * 1. Recover active transactions from mempool on startup
   * 2. Update mempool state (check for confirmations/drops)
   * 3. Handle stuck transactions with RBF
   * 4. Check mempool capacity (25 tx limit)
   * 5. Fetch and validate new filled orders
   * 6. Process each order sequentially
   * 7. Update state for next run
   * 
   * @returns Array of ProcessResult objects for each processed order
   * @throws Will throw if fatal processing error occurs
   */
  async process(): Promise<ProcessResult[]> {
    // If already processing, wait for it to complete
    if (this.isProcessing && this.processingLock) {
      console.log('Worker already running, waiting for completion...');
      await this.processingLock;
      return [];
    }

    // Create new processing lock
    let releaseLock: () => void;
    this.processingLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    
    this.isProcessing = true;
    const startTime = Date.now();
    
    try {
      console.log(`[${new Date().toISOString()}] Single worker starting...`);
      return await this.processInternal();
    } finally {
      this.isProcessing = false;
      this.processingState.lastCheckTime = Date.now();
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Worker completed in ${duration}ms`);
      releaseLock!();
      this.processingLock = null;
    }
  }

  /**
   * Internal processing logic
   */
  private async processInternal(): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];

    try {
      // 1. Check Bitcoin mempool capacity FIRST
      const actualMempoolCount = await this.bitcoin.getUnconfirmedTxCount(this.config.xcpfolioAddress);
      console.log(`Bitcoin mempool count: ${actualMempoolCount}/${this.config.maxMempoolTxs}`);
      
      if (actualMempoolCount >= this.config.maxMempoolTxs!) {
        console.log(`Mempool at capacity, waiting for confirmations`);
        await NotificationService.warning('Mempool at capacity', {
          current: actualMempoolCount,
          limit: this.config.maxMempoolTxs
        });
        return results;
      }

      // 2. Get all pending transfers from Counterparty mempool
      const pendingTransfers = await this.getPendingTransfers();
      console.log(`Found ${pendingTransfers.size} pending transfers in mempool`);
      
      // 3. Clean up old completed orders periodically (keep state small)
      await this.cleanupOldCompletedOrders();

      // 4. Get current block height
      const currentBlock = await this.bitcoin.getCurrentBlockHeight();
      
      // 4a. Track unconfirmed open orders (new listings)
      await this.trackMempoolOpenOrders();
      
      // 5. Get filled orders from Counterparty
      console.log('Fetching filled orders...');
      const orders = await this.counterparty.getFilledXCPFOLIOOrders(this.config.xcpfolioAddress);
      
      // Get processed orders set for checking
      const processedOrders = await this.state.getProcessedOrders();
      
      // Filter to unprocessed orders and check for already transferred assets
      const unprocessedOrders: Order[] = [];
      let consecutiveProcessed = 0;
      const stopAfterConsecutive = 10; // Stop after finding 10 consecutive already-processed orders
      
      for (const order of orders) {
        // Check if we've already processed this exact order
        if (processedOrders.has(order.tx_hash)) {
          consecutiveProcessed++;
          console.log(`Order ${order.tx_hash} already in processed list (${consecutiveProcessed} consecutive)`);
          
          // Stop checking if we've seen enough consecutive processed orders
          // This prevents checking ancient history every time
          if (consecutiveProcessed >= stopAfterConsecutive) {
            console.log(`Found ${stopAfterConsecutive} consecutive processed orders, stopping scan`);
            break;
          }
          continue;
        }
        
        // Reset counter since we found an unprocessed order
        consecutiveProcessed = 0;
        
        // Check if asset has already been transferred (double-check via Counterparty)
        const assetName = (order.give_asset_info?.asset_longname || order.give_asset).replace('XCPFOLIO.', '');
        
        try {
          const assetInfo = await this.counterparty.getAssetInfo(assetName);
          // Get the buyer address from order matches
          const matches = await this.counterparty.getOrderMatches(order.tx_hash);
          if (matches && matches.length > 0) {
            const match = matches[0];
            const buyer = match.tx0_address === this.config.xcpfolioAddress 
              ? match.tx1_address 
              : match.tx0_address;
            
            // If buyer already owns the asset, mark as processed and skip
            if (assetInfo.owner === buyer) {
              console.log(`Asset ${assetName} already owned by buyer ${buyer}, marking as processed`);
              await this.state.markOrderProcessed(order.tx_hash);
              
              // Update order history to show it's confirmed (for display only)
              let purchasedAt = Date.now();
              if (order.block_time && order.block_time > 1000000000) {
                purchasedAt = order.block_time * 1000;
              }
              
              // Check if this order already exists (may have been tracked from mempool)
              const existingOrder = await this.orderHistory.getOrder(order.tx_hash);
              
              // Get actual delivery info from blockchain
              let deliveryTime = Date.now();
              let deliveryBlock = order.block_index;
              let transferTxid: string | undefined;
              
              try {
                // Get issuances to find the actual transfer transaction
                const issuances = await this.counterparty.getAssetIssuances(assetName);
                const transfer = issuances.find(i => 
                  i.transfer === true &&
                  i.source === this.config.xcpfolioAddress &&
                  i.issuer === buyer
                );
                
                if (transfer) {
                  transferTxid = transfer.tx_hash;
                  deliveryBlock = transfer.block_index;
                  if (transfer.block_time) {
                    deliveryTime = transfer.block_time * 1000; // Convert to milliseconds
                  }
                }
              } catch (error) {
                console.error(`Error getting transfer details for ${assetName}:`, error);
              }
              
              await this.orderHistory.upsertOrder({
                orderHash: order.tx_hash,
                asset: assetName,
                assetLongname: order.give_asset_info?.asset_longname || undefined,
                price: order.get_quantity / 100000000,
                buyer,
                seller: this.config.xcpfolioAddress,
                status: 'confirmed',
                stage: 'confirmed',
                purchasedAt: existingOrder?.purchasedAt || purchasedAt, // Keep original purchase time if updating
                purchasedBlock: order.block_index,
                confirmedAt: deliveryTime,
                confirmedBlock: deliveryBlock,
                deliveredAt: deliveryTime, // Use actual delivery time from blockchain
                txid: transferTxid,
                confirmations: 1, // It's confirmed
                lastUpdated: Date.now()
              });
              continue;
            }
          }
        } catch (error) {
          console.error(`Error checking asset ${assetName}:`, error);
        }
        
        // This order needs processing
        unprocessedOrders.push(order);
      }
      
      if (unprocessedOrders.length === 0) {
        console.log(`No unprocessed orders found (checked ${orders.length} total)`);
        // Don't update lastBlock anymore - we're not using it for filtering
        return results;
      }

      console.log(`Found ${unprocessedOrders.length} unprocessed orders to fulfill`);
      
      // Notify about new confirmed orders
      for (const order of unprocessedOrders) {
        const assetName = (order.give_asset_info?.asset_longname || order.give_asset).replace('XCPFOLIO.', '');
        await NotificationService.success('✅ Order filled & confirmed!', {
          asset: assetName,
          orderHash: order.tx_hash.slice(0, 8) + '...',
          block: order.block_index
        });
      }

      // 6. Process new orders sequentially
      for (const order of unprocessedOrders) {
        // Check if we should stop
        if (this.shouldStop) {
          console.log('Stop requested, halting processing');
          break;
        }

        // Re-check ACTUAL mempool capacity before each order
        const currentMempoolCount = await this.bitcoin.getUnconfirmedTxCount(this.config.xcpfolioAddress);
        if (currentMempoolCount >= this.config.maxMempoolTxs!) {
          console.log(`Mempool at capacity (${currentMempoolCount}/${this.config.maxMempoolTxs}), stopping order processing`);
          break;
        }

        // Skip if already completed (confirmed transfer)
        if (await this.state.isOrderProcessed(order.tx_hash)) {
          console.log(`Order ${order.tx_hash} already completed`);
          continue;
        }

        // Get asset name for checking
        const assetName = (order.give_asset_info?.asset_longname || order.give_asset).replace('XCPFOLIO.', '');
        
        // Skip if transfer is pending in mempool
        const pendingKey = `${assetName}:${order.source}`;
        if (pendingTransfers.has(pendingKey)) {
          console.log(`Order ${order.tx_hash} has pending transfer in mempool`);
          continue;
        }

        // Mark as currently processing
        this.processingState.currentProcessingOrder = order.tx_hash;

        try {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`Processing order ${order.tx_hash}`);
          
          const assetName = (order.give_asset_info?.asset_longname || order.give_asset).replace('XCPFOLIO.', '');
          
          // Notify we're starting to process
          await NotificationService.info('⚙️ Processing order', {
            asset: assetName,
            orderHash: order.tx_hash.slice(0, 8) + '...'
          });
          
          const result = await this.processOrderSafely(order, currentBlock);
          results.push(result);

          if (result.success) {
            if (result.stage === 'broadcast') {
              console.log(`✅ Successfully broadcast tx ${result.txid}`);
            } else if (result.stage === 'confirmed') {
              console.log(`✅ Asset already transferred`);
            }
            // Clear pre-broadcast failures on success
            this.processingState.preBroadcastFailures.delete(order.tx_hash);
          } else {
            console.log(`❌ Failed at stage ${result.stage}: ${result.error}`);
            if (result.stage && result.stage !== 'broadcast') {
              this.trackPreBroadcastFailure(order.tx_hash, result.error || 'Unknown', result.stage);
            }
          }

          // Small delay between orders
          await this.sleep(1000);

        } catch (error) {
          console.error(`Unexpected error processing ${order.tx_hash}:`, error);
          const assetName = order.give_asset_info?.asset_longname || order.give_asset;
          results.push({
            orderHash: order.tx_hash,
            asset: assetName.replace('XCPFOLIO.', ''),
            buyer: order.source,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          this.processingState.currentProcessingOrder = null;
        }
      }

      // 7. Update state
      await this.state.setLastBlock(currentBlock);
      if (orders.length > 0) {
        await this.state.setLastOrderHash(orders[0].tx_hash);
      }

      return results;

    } catch (error) {
      console.error('Fatal processing error:', error);
      throw error;
    }
  }

  /**
   * Process a single order with all safety checks
   * 
   * Handles the complete lifecycle of fulfilling an order:
   * 1. Validation - Check order status and asset ownership
   * 2. Duplicate check - Verify asset hasn't already been transferred
   * 3. Retry management - Handle pre-broadcast failures with progressive backoff
   * 4. Transaction composition - Create the asset transfer transaction
   * 5. Signing - Sign with private key (RBF enabled)
   * 6. Broadcasting - Send to multiple endpoints for reliability
   * 
   * @param order - The filled order from Counterparty DEX
   * @param currentBlock - Current Bitcoin block height
   * @returns ProcessResult indicating success/failure and transaction details
   */
  private async processOrderSafely(order: Order, currentBlock: number): Promise<ProcessResult> {
    // Get asset name from longname or fallback
    const xcpfolioAsset = order.give_asset_info?.asset_longname || order.give_asset;
    const assetName = xcpfolioAsset.replace(ASSET_CONFIG.XCPFOLIO_PREFIX, '');
    
    // For filled orders, we need to find the buyer from order matches
    // The order.source is us (the seller), not the buyer
    let buyerAddress: string;
    
    try {
      const matches = await this.counterparty.getOrderMatches(order.tx_hash);
      
      if (!matches || matches.length === 0) {
        throw new Error('No order matches found for filled order');
      }
      
      // In an order match:
      // - tx0_address is the original order creator (us, selling XCPFOLIO.ASSET)
      // - tx1_address is the order filler (buyer, who sent XCP to buy our XCPFOLIO.ASSET)
      const match = matches[0];
      
      // We are tx0_address (original order creator)
      // The buyer is tx1_address (order filler)
      if (match.tx0_address === this.config.xcpfolioAddress) {
        buyerAddress = match.tx1_address;
      } else if (match.tx1_address === this.config.xcpfolioAddress) {
        // Shouldn't happen for our sell orders, but handle just in case
        buyerAddress = match.tx0_address;
      } else {
        throw new Error(`Order match doesn't involve our address: tx0=${match.tx0_address}, tx1=${match.tx1_address}`);
      }
      
      if (!buyerAddress) {
        throw new Error('Could not determine buyer address from order match');
      }
    } catch (error) {
      console.error('Failed to get buyer address from order match:', error);
      // This shouldn't happen for filled orders, but if it does, we can't proceed
      return {
        orderHash: order.tx_hash,
        asset: assetName,
        buyer: 'unknown',
        success: false,
        error: `Failed to determine buyer: ${error instanceof Error ? error.message : String(error)}`,
        stage: 'validation'
      };
    }

    console.log(`Asset: ${assetName} -> Buyer: ${buyerAddress}`);

    // Track order in history (non-critical, for display only)
    try {
      // Check if this order already exists in history (from mempool tracking)
      const existingOrder = await this.orderHistory.getOrder(order.tx_hash);
      
      // For filled orders, block_time is when the order was filled
      // Convert from Unix seconds to milliseconds, and validate it's reasonable
      let purchasedAt = Date.now(); // Default to now
      if (order.block_time && order.block_time > 1000000000) {
        // block_time is in seconds, convert to milliseconds
        purchasedAt = order.block_time * 1000;
      }
      
      // If order exists from mempool, update it. Otherwise create new entry.
      const orderStatus: OrderStatus = {
        orderHash: order.tx_hash,
        asset: assetName,
        assetLongname: order.give_asset_info?.asset_longname || undefined,
        price: order.get_quantity / 100000000, // Convert to XCP
        buyer: buyerAddress,
        seller: this.config.xcpfolioAddress,
        status: 'processing',
        stage: 'validation',
        purchasedAt: existingOrder?.purchasedAt || purchasedAt, // Keep original purchase time if updating
        purchasedBlock: order.block_index || undefined,
        confirmations: 1, // It's confirmed if we're processing it
        lastUpdated: Date.now()
      };
      await this.orderHistory.upsertOrder(orderStatus);
    } catch (error) {
      console.error('Error saving order to history (non-critical):', error);
      // Continue processing - order history is just for display
    }

    try {
      // Stage 1: Validation
      console.log('Stage 1: Validating order...');
      const validation = await this.validateOrderWithOwnership(order);
      if (!validation.valid) {
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: false,
          error: validation.reason,
          stage: 'validation'
        };
      }

      // Stage 2: Check if already transferred (CRITICAL!)
      console.log('Stage 2: Checking if already transferred (confirmed or pending)...');
      
      // First check if we have an active transaction in memory
      const existingTx = this.processingState.orderTransactions.get(order.tx_hash);
      if (existingTx) {
        console.log(`Active tx exists in memory: ${existingTx.txid}`);
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
          txid: existingTx.txid,
          stage: 'broadcast'
        };
      }
      
      // Check both confirmed AND unconfirmed transfers
      const alreadyTransferred = await this.counterparty.isAssetTransferredTo(
        assetName,
        buyerAddress,
        this.config.xcpfolioAddress
      );

      if (alreadyTransferred) {
        // Mark as processed and clean up
        await this.state.markOrderProcessed(order.tx_hash);
        this.processingState.orderTransactions.delete(order.tx_hash);
        
        // Update order history
        await this.orderHistory.updateOrderStatus(
          order.tx_hash,
          'confirmed',
          'confirmed'
        );
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
          stage: 'confirmed'
        };
      }

      // Check pre-broadcast retry limit with progressive strategy
      const preBroadcastFailure = this.processingState.preBroadcastFailures.get(order.tx_hash);
      if (preBroadcastFailure) {
        // Progressive retry strategy
        const timeSinceFirst = Date.now() - preBroadcastFailure.firstFailureTime;
        const timeSinceLastAttempt = Date.now() - preBroadcastFailure.lastAttemptTime;
        
        // Reset after 1 hour
        if (timeSinceFirst > RETRY_STRATEGY.PRE_BROADCAST.RESET_AFTER) {
          this.processingState.preBroadcastFailures.delete(order.tx_hash);
          console.log('Reset failure count after 1 hour');
        } else {
          // Progressive backoff strategy
          let maxRetries: number;
          let minWaitTime: number;
          
          if (preBroadcastFailure.count < RETRY_STRATEGY.PRE_BROADCAST.QUICK_ATTEMPTS) {
            // First 10 attempts: retry quickly
            maxRetries = RETRY_STRATEGY.PRE_BROADCAST.QUICK_ATTEMPTS;
            minWaitTime = RETRY_STRATEGY.PRE_BROADCAST.QUICK_BACKOFF;
          } else if (preBroadcastFailure.count < RETRY_STRATEGY.PRE_BROADCAST.MODERATE_ATTEMPTS) {
            // Next 15 attempts: moderate backoff
            maxRetries = RETRY_STRATEGY.PRE_BROADCAST.MODERATE_ATTEMPTS;
            minWaitTime = RETRY_STRATEGY.PRE_BROADCAST.MODERATE_BACKOFF;
          } else if (preBroadcastFailure.count < RETRY_STRATEGY.PRE_BROADCAST.EXTENDED_ATTEMPTS) {
            // Next 25 attempts: longer backoff
            maxRetries = RETRY_STRATEGY.PRE_BROADCAST.EXTENDED_ATTEMPTS;
            minWaitTime = RETRY_STRATEGY.PRE_BROADCAST.EXTENDED_BACKOFF;
          } else {
            // After 50 attempts: very long backoff
            maxRetries = RETRY_STRATEGY.PRE_BROADCAST.MAX_ATTEMPTS;
            minWaitTime = RETRY_STRATEGY.PRE_BROADCAST.HOURLY_BACKOFF;
          }
          
          // Check if we should wait before retrying
          if (timeSinceLastAttempt < minWaitTime) {
            console.log(`Waiting for backoff: ${Math.ceil((minWaitTime - timeSinceLastAttempt) / 1000)}s`);
            return {
              orderHash: order.tx_hash,
              asset: assetName,
              buyer: buyerAddress,
              success: false,
              error: `Backoff period (attempt ${preBroadcastFailure.count})`,
              stage: preBroadcastFailure.stage as any
            };
          }
          
          // Send alerts at key thresholds
          if (preBroadcastFailure.count === RETRY_STRATEGY.PRE_BROADCAST.ALERT_AT_10) {
            await this.sendCriticalAlert(
              `Order ${order.tx_hash} has failed 10 times!\n` +
              `Asset: ${assetName} -> ${buyerAddress}\n` +
              `Stage: ${preBroadcastFailure.stage}\n` +
              `Will continue retrying with backoff...`
            );
          } else if (preBroadcastFailure.count === RETRY_STRATEGY.PRE_BROADCAST.ALERT_AT_25) {
            await this.sendCriticalAlert(
              `Order ${order.tx_hash} has failed 25 times!\n` +
              `Asset: ${assetName} -> ${buyerAddress}\n` +
              `May need manual intervention.\n` +
              `Continuing with longer backoff...`
            );
          } else if (preBroadcastFailure.count === RETRY_STRATEGY.PRE_BROADCAST.ALERT_AT_50) {
            await this.sendCriticalAlert(
              `Order ${order.tx_hash} has failed 50 times!\n` +
              `Time since first failure: ${Math.floor(timeSinceFirst / 60000)} minutes\n` +
              `Manual intervention recommended.`
            );
          }
          
          // Log retry attempt
          console.log(`Retry attempt ${preBroadcastFailure.count + 1}/${maxRetries} for order ${order.tx_hash}`);
          
          // Only give up after hitting the absolute max
          if (preBroadcastFailure.count >= maxRetries) {
            console.error(`🚨 CRITICAL: Order ${order.tx_hash} exceeded ${maxRetries} retries over ${Math.floor(timeSinceFirst / 60000)} minutes`);
            // Don't return failure - keep trying but with long backoff
          }
        }
      }

      // Wait for compose cooldown
      await this.waitForComposeCooldown();

      // Dry run check
      if (this.config.dryRun) {
        console.log('[DRY RUN] Would transfer asset');
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
          txid: 'dry-run',
          stage: 'broadcast'
        };
      }

      // Stage 3: Compose transaction
      await this.orderHistory.updateOrderStatus(order.tx_hash, 'processing', 'compose');
      console.log('Stage 3: Composing transaction...');
      let rawTx: string;
      try {
        let feeRate = await this.bitcoin.getOptimalFeeRate();
        console.log(`Market fee rate: ${feeRate} sat/vB`);
        
        // Check if fee rate exceeds our limit for new transactions
        if (feeRate > this.config.maxFeeRateForNewTx!) {
          console.log(`⚠️ Fee rate ${feeRate} exceeds limit ${this.config.maxFeeRateForNewTx} for new tx, waiting for lower fees`);
          return {
            orderHash: order.tx_hash,
            asset: assetName,
            buyer: buyerAddress,
            success: false,
            error: `Fee rate too high: ${feeRate} > ${this.config.maxFeeRateForNewTx} sat/vB. Waiting for lower fees.`,
            stage: 'compose'
          };
        }
        
        // Estimate total fee to check against ceiling
        const estimatedTotalFee = feeRate * TX_LIMITS.ESTIMATED_TX_VSIZE;
        if (estimatedTotalFee > this.config.maxTotalFeeSats!) {
          console.log(`⚠️ Estimated fee ${estimatedTotalFee} sats exceeds ceiling ${this.config.maxTotalFeeSats}`);
          // Use the maximum rate that stays under our ceiling
          feeRate = Math.floor(this.config.maxTotalFeeSats! / TX_LIMITS.ESTIMATED_TX_VSIZE);
          console.log(`Using capped rate: ${feeRate} sat/vB to stay under fee ceiling`);
        }
        
        console.log(`Using fee rate: ${feeRate} sat/vB (max total: ${feeRate * TX_LIMITS.ESTIMATED_TX_VSIZE} sats)`);

        rawTx = await this.counterparty.composeTransfer(
          this.config.xcpfolioAddress,
          assetName,
          buyerAddress,
          feeRate,
          'auto',
          true // validate=true for normal tx
        );

        this.processingState.lastComposeTime = Date.now();
        console.log('Transaction composed successfully');
      } catch (error) {
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stage: 'compose'
        };
      }

      // Stage 4: Sign transaction
      await this.orderHistory.updateOrderStatus(order.tx_hash, 'processing', 'sign');
      console.log('Stage 4: Signing transaction...');
      let signedTx: SignedTransaction;
      try {
        signedTx = await this.bitcoin.signTransaction(
          rawTx,
          this.config.xcpfolioAddress,
          this.config.privateKey
        );
        console.log(`Signed: ${signedTx.txid} (${signedTx.vsize} vbytes, ${signedTx.fee} sats fee)`);
        
        // Final check: ensure actual fee doesn't exceed ceiling
        if (signedTx.fee > this.config.maxTotalFeeSats!) {
          console.error(`❌ Actual fee ${signedTx.fee} exceeds ceiling ${this.config.maxTotalFeeSats}, aborting`);
          return {
            orderHash: order.tx_hash,
            asset: assetName,
            buyer: buyerAddress,
            success: false,
            error: `Transaction fee ${signedTx.fee} sats exceeds maximum ${this.config.maxTotalFeeSats}`,
            stage: 'sign'
          };
        }
      } catch (error) {
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stage: 'sign'
        };
      }

      // Stage 5: Broadcast transaction
      await this.orderHistory.updateOrderStatus(order.tx_hash, 'broadcasting', 'broadcast');
      console.log('Stage 5: Broadcasting transaction...');
      
      // Final mempool check before broadcast
      const currentMempoolCount = this.processingState.orderTransactions.size;
      if (currentMempoolCount >= this.config.maxMempoolTxs!) {
        console.log(`Mempool at capacity (${currentMempoolCount}/${this.config.maxMempoolTxs}), aborting broadcast`);
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: false,
          error: `Mempool at capacity: ${currentMempoolCount}/${this.config.maxMempoolTxs}`,
          stage: 'broadcast'
        };
      }
      
      try {
        const txid = await this.bitcoin.broadcastTransaction(signedTx.hex);
        
        // Notify successful broadcast
        await NotificationService.success('🚀 Transfer broadcast!', {
          asset: assetName,
          buyer: buyerAddress,
          txid: txid.slice(0, 8) + '...',
          'Full TXID': txid,
          'Track at': `https://mempool.space/tx/${txid}`
        });
        
        // Update order history with txid
        await this.orderHistory.updateOrderStatus(order.tx_hash, 'confirming', 'mempool', txid);

        // Track the transaction with RBF history
        this.processingState.orderTransactions.set(order.tx_hash, {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          txid,
          originalTxid: txid,
          rbfHistory: [txid],
          broadcastTime: Date.now(),
          broadcastBlock: currentBlock,
          feeRate: Math.ceil(signedTx.fee / signedTx.vsize),
          isRbf: false,
          rbfCount: 0
        });

        // Mark as processed
        await this.state.markOrderProcessed(order.tx_hash);

        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
          txid,
          stage: 'broadcast'
        };

      } catch (error) {
        // Check if already in mempool
        const errorMsg = (error instanceof Error ? error.message : String(error)).toLowerCase();
        if (errorMsg.includes('already') && errorMsg.includes('mempool')) {
          console.log('Transaction already in mempool');
          await this.state.markOrderProcessed(order.tx_hash);
          return {
            orderHash: order.tx_hash,
            asset: assetName,
            buyer: buyerAddress,
            success: true,
            stage: 'broadcast'
          };
        }

        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stage: 'broadcast'
        };
      }

    } catch (error) {
      console.error('Unexpected error:', error);
      return {
        orderHash: order.tx_hash,
        asset: assetName,
        buyer: buyerAddress,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Validate order and check asset ownership
   */
  private async validateOrderWithOwnership(order: Order): Promise<{
    valid: boolean;
    reason?: string;
  }> {
    // Basic validation
    const validation = await this.counterparty.validateOrder(order);
    if (!validation.valid) {
      return validation;
    }

    // Check asset ownership
    const assetName = validation.asset!;
    try {
      const assetInfo = await this.counterparty.getAssetInfo(assetName);
      
      if (assetInfo.owner !== this.config.xcpfolioAddress) {
        return {
          valid: false,
          reason: `We don't own ${assetName} (owned by ${assetInfo.owner})`
        };
      }

      if (assetInfo.locked) {
        return {
          valid: false,
          reason: `Asset ${assetName} is locked`
        };
      }

      return { valid: true };
      
    } catch (error) {
      return {
        valid: false,
        reason: `Failed to verify ownership: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Handle stuck transactions with Replace-By-Fee (RBF)
   * 
   * Monitors active transactions and initiates RBF when:
   * - Transaction is dropped from mempool
   * - Transaction stuck for more than 3 blocks (configurable)
   * - Previous RBF attempt needs higher fee
   * 
   * Fee escalation strategy:
   * - First RBF: 1.5x original fee
   * - Subsequent RBFs: Progressive multipliers up to 2.5x
   * - After 12 blocks: Ensure 1.5x market rate
   * 
   * @returns Array of ProcessResult for successful RBF attempts
   */
  private async handleStuckTransactions(): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];
    const currentBlock = await this.bitcoin.getCurrentBlockHeight();

    for (const [orderHash, tx] of this.processingState.orderTransactions) {
      // Check if dropped from mempool first
      if (tx.droppedFromMempool || tx.needsRbf) {
        console.log(`Transaction ${tx.txid} needs RBF (dropped=${tx.droppedFromMempool})`);
        const rbfResult = await this.attemptRBF(tx, currentBlock);
        if (rbfResult) {
          results.push(rbfResult);
        }
        continue;
      }

      // Check if stuck
      const blocksSinceBroadcast = currentBlock - tx.broadcastBlock;
      if (blocksSinceBroadcast >= this.config.stuckTxThreshold!) {
        console.log(`Transaction ${tx.txid} stuck for ${blocksSinceBroadcast} blocks`);
        tx.needsRbf = true;
      }
    }

    return results;
  }

  /**
   * Attempt RBF for a stuck transaction
   */
  private async attemptRBF(tx: OrderTransaction, currentBlock: number): Promise<ProcessResult | null> {
    try {
      // Calculate new fee based on how stuck it is
      const blocksSinceBroadcast = currentBlock - tx.broadcastBlock;
      const currentMarketRate = await this.bitcoin.getOptimalFeeRate();
      
      // Calculate new fee with proper escalation
      let newFeeRate: number;
      if (blocksSinceBroadcast < RETRY_STRATEGY.RBF.MARKET_PREMIUM_BLOCKS) {
        newFeeRate = Math.max(tx.feeRate * RETRY_STRATEGY.RBF.EARLY_MULTIPLIER, currentMarketRate);
      } else if (blocksSinceBroadcast < RETRY_STRATEGY.RBF.MARKET_PREMIUM_BLOCKS * 2) {
        newFeeRate = Math.max(tx.feeRate * RETRY_STRATEGY.RBF.MIDDLE_MULTIPLIER, currentMarketRate * RETRY_STRATEGY.RBF.MARKET_BUFFER_MULTIPLIER);
      } else {
        const fees = await this.bitcoin.getFeeRates();
        newFeeRate = fees.fastestFee * RETRY_STRATEGY.RBF.MARKET_PREMIUM_MULTIPLIER;
      }

      // Ensure BIP-125 compliance: new fee must be at least old fee + 1 sat/vB
      newFeeRate = Math.max(newFeeRate, tx.feeRate + RETRY_STRATEGY.RBF.MIN_FEE_INCREMENT);
      
      // Check against total fee ceiling for RBF
      const estimatedNewTotalFee = newFeeRate * TX_LIMITS.ESTIMATED_TX_VSIZE;
      if (estimatedNewTotalFee > this.config.maxTotalFeeSats!) {
        // For RBF, we're more flexible - use the max allowed but warn
        const maxAllowedRate = Math.floor(this.config.maxTotalFeeSats! / TX_LIMITS.ESTIMATED_TX_VSIZE);
        
        // Ensure we're still increasing the fee (BIP-125 requirement)
        if (maxAllowedRate <= tx.feeRate) {
          console.error(`❌ Cannot RBF: fee ceiling prevents required increase`);
          console.error(`Current: ${tx.feeRate} sat/vB, Need: >${tx.feeRate}, Max allowed: ${maxAllowedRate}`);
          // Mark for removal and fresh retry instead
          this.processingState.orderTransactions.delete(tx.orderHash);
          // Note: unmarkOrderProcessed method doesn't exist in new state manager
          // Orders should not be unmarked once processed
          return null;
        }
        
        console.warn(`⚠️ RBF fee capped at ${maxAllowedRate} sat/vB due to ceiling (wanted ${newFeeRate})`);
        newFeeRate = maxAllowedRate;
      }
      
      // Apply protective cap
      if (newFeeRate > RETRY_STRATEGY.RBF.MAX_FEE_RATE) {
        console.warn(`Fee rate ${newFeeRate} exceeds max ${RETRY_STRATEGY.RBF.MAX_FEE_RATE}, capping`);
        newFeeRate = RETRY_STRATEGY.RBF.MAX_FEE_RATE;
      }

      console.log(`RBF: Bumping fee from ${tx.feeRate} to ${newFeeRate} sat/vB (${Math.round((newFeeRate / tx.feeRate - 1) * 100)}% increase)`);

      // Compose with validate=false for RBF
      const rawTx = await this.counterparty.composeTransfer(
        this.config.xcpfolioAddress,
        tx.asset,
        tx.buyer,
        newFeeRate,
        'auto',
        false // validate=false for RBF!
      );

      // Sign and broadcast
      const signedTx = await this.bitcoin.signTransaction(
        rawTx,
        this.config.xcpfolioAddress,
        this.config.privateKey
      );
      
      // Final check for RBF transaction fee
      if (signedTx.fee > this.config.maxTotalFeeSats!) {
        console.error(`❌ RBF actual fee ${signedTx.fee} exceeds ceiling, aborting`);
        // Don't RBF, wait for original to confirm or drop
        return null;
      }
      
      console.log(`RBF signed: ${signedTx.vsize} vbytes, ${signedTx.fee} sats total fee`);

      const txid = await this.bitcoin.broadcastTransaction(signedTx.hex);

      // Update tracking with RBF history
      const oldTxid = tx.txid;
      tx.txid = txid;
      tx.rbfHistory.push(txid);
      tx.feeRate = newFeeRate;
      tx.isRbf = true;
      tx.rbfCount++;
      tx.broadcastTime = Date.now();
      tx.broadcastBlock = currentBlock;
      tx.needsRbf = false;
      tx.droppedFromMempool = false;

      console.log(`RBF successful: ${oldTxid} -> ${txid}`);
      console.log(`RBF history: ${tx.rbfHistory.join(' -> ')}`);
      return {
        orderHash: tx.orderHash,
        asset: tx.asset,
        buyer: tx.buyer,
        success: true,
        txid,
        isRbf: true,
        stage: 'broadcast'
      };

    } catch (error) {
      console.error(`RBF failed for ${tx.txid}:`, error instanceof Error ? error.message : String(error));
      
      // If RBF failed, remove from tracking
      // Order will be retried as a new transaction
      this.processingState.orderTransactions.delete(tx.orderHash);
      // Note: We don't unmark as processed to avoid duplicate processing
      
      return null;
    }
  }

  /**
   * Track unconfirmed buy orders from mempool
   * 
   * Fetches OPEN_ORDER events where someone is trying to buy XCPFOLIO assets.
   * This allows buyers to see their order status immediately after placing it.
   * Note: These orders may not be fulfilled if invalid or if someone else's order confirms first.
   */
  private async trackMempoolOpenOrders(): Promise<void> {
    try {
      const mempoolBuyOrders = await this.counterparty.getMempoolBuyOrders();
      
      for (const event of mempoolBuyOrders) {
        const orderHash = event.tx_hash;
        const params = event.params;
        
        if (!params) continue;
        
        // Extract asset name from longname (what they're trying to buy)
        const assetLongname = params.get_asset_info?.asset_longname;
        if (!assetLongname) continue;
        
        const assetName = assetLongname.replace('XCPFOLIO.', '');
        
        // Calculate price in XCP (what they're paying)
        const price = params.give_quantity / 100000000; // Convert XCP satoshis to XCP
        
        // The source is the buyer (who placed the order)
        const buyer = params.source;
        
        // Track as unconfirmed buy order
        this.orderHistory.upsertOrder({
          orderHash,
          asset: assetName,
          assetLongname,
          price,
          buyer,
          seller: '', // Not yet matched with a seller
          status: 'unconfirmed',
          stage: 'mempool',
          confirmations: 0,
          orderType: 'open', // It's an open buy order
          purchasedAt: Date.now(),
          lastUpdated: Date.now()
        });
      }
      
      if (mempoolBuyOrders.length > 0) {
        console.log(`Tracked ${mempoolBuyOrders.length} unconfirmed buy orders`);
      }
    } catch (error) {
      console.error('Error tracking mempool buy orders:', error);
    }
  }

  /**
   * Update mempool state and track transaction status
   * 
   * Checks all active transactions to determine if they are:
   * - Still in mempool (pending)
   * - Confirmed on blockchain (success)
   * - Dropped from mempool (needs RBF)
   * 
   * For RBF transactions, checks all historical txids to detect
   * if any version has been confirmed.
   * 
   * @sideeffect Updates orderTransactions map
   * @sideeffect Marks transactions for RBF if dropped
   */
  private async updateMempoolState(): Promise<void> {
    const toRemove: string[] = [];

    for (const [orderHash, tx] of this.processingState.orderTransactions) {
      try {
        // Check current txid
        const inMempool = await this.bitcoin.isInMempool(tx.txid);
        if (!inMempool) {
          // Check if confirmed
          try {
            const txData = await this.bitcoin.getTransaction(tx.txid);
            if (txData.status?.confirmed) {
              console.log(`✅ Transaction ${tx.txid} confirmed`);
              
              // Notify about confirmation
              await NotificationService.success('💎 Transfer confirmed on blockchain!', {
                asset: tx.asset,
                buyer: tx.buyer,
                txid: tx.txid.slice(0, 8) + '...',
                'View on blockchain': `https://mempool.space/tx/${tx.txid}`
              });
              
              toRemove.push(orderHash);
              continue;
            }
          } catch {
            // Current txid not found, check if any RBF version is confirmed
            const anyConfirmed = await this.checkIfAnyVersionConfirmed(tx);
            if (anyConfirmed) {
              console.log(`✅ RBF version confirmed for order ${orderHash}`);
              toRemove.push(orderHash);
              continue;
            }
            
            // Transaction dropped - mark for RBF
            console.log(`⚠️ Transaction ${tx.txid} dropped from mempool`);
            tx.droppedFromMempool = true;
            tx.needsRbf = true;
          }
        }
      } catch (error) {
        console.error(`Error checking tx ${tx.txid}:`, error);
      }
    }

    // Remove confirmed transactions
    for (const orderHash of toRemove) {
      this.processingState.orderTransactions.delete(orderHash);
    }
  }

  /**
   * Check if any version of an RBF transaction is confirmed
   */
  private async checkIfAnyVersionConfirmed(tx: OrderTransaction): Promise<boolean> {
    for (const txid of tx.rbfHistory) {
      try {
        const txData = await this.bitcoin.getTransaction(txid);
        if (txData.status?.confirmed) {
          console.log(`Found confirmed RBF version: ${txid}`);
          return true;
        }
      } catch {
        // Transaction not found, continue checking others
      }
    }
    return false;
  }

  /**
   * Track pre-broadcast failure
   */
  private trackPreBroadcastFailure(orderHash: string, error: string, stage: string): void {
    const existing = this.processingState.preBroadcastFailures.get(orderHash);
    const now = Date.now();
    
    if (existing) {
      existing.count++;
      existing.lastError = error;
      existing.stage = stage;
      existing.lastAttemptTime = now;
    } else {
      this.processingState.preBroadcastFailures.set(orderHash, {
        count: 1,
        lastError: error,
        stage,
        firstFailureTime: now,
        lastAttemptTime: now
      });
    }
  }

  /**
   * Wait for compose cooldown
   */
  private async waitForComposeCooldown(): Promise<void> {
    const timeSinceLastCompose = Date.now() - this.processingState.lastComposeTime;
    const remainingCooldown = this.config.composeCooldown! - timeSinceLastCompose;
    
    if (remainingCooldown > 0) {
      console.log(`Waiting ${remainingCooldown}ms for compose cooldown...`);
      await this.sleep(remainingCooldown);
    }
  }

  /**
   * Request stop (graceful shutdown)
   */
  requestStop(): void {
    console.log('Stop requested, will halt after current order');
    this.shouldStop = true;
  }

  /**
   * Get current state
   */
  async getState() {
    return {
      ...(await this.state.getState()),
      isProcessing: this.isProcessing,
      currentOrder: this.processingState.currentProcessingOrder,
      mempool: {
        activeTransactions: this.processingState.orderTransactions.size,
        maxTxs: this.config.maxMempoolTxs,
        transactions: Array.from(this.processingState.orderTransactions.values()),
      },
      failures: {
        preBroadcast: this.processingState.preBroadcastFailures.size,
        details: Array.from(this.processingState.preBroadcastFailures.entries()).map(([k, v]) => ({
          order: k,
          ...v
        }))
      },
      lastCheckTime: this.processingState.lastCheckTime,
    };
  }

  /**
   * Send critical alert for issues requiring attention
   */
  private async sendCriticalAlert(message: string): Promise<void> {
    await NotificationService.critical(message);
  }

  /**
   * Get pending transfers from Counterparty mempool
   * Returns a Set of "asset:buyer" keys for quick lookup
   */
  private async getPendingTransfers(): Promise<Set<string>> {
    const pending = new Set<string>();
    
    try {
      const mempoolEvents = await this.counterparty.getMempoolTransfers(this.config.xcpfolioAddress);
      
      for (const event of mempoolEvents) {
        if (event.params?.asset && event.params?.issuer) {
          // issuer is the new owner for transfers
          const key = `${event.params.asset}:${event.params.issuer}`;
          pending.add(key);
          console.log(`Pending transfer: ${key}`);
        }
      }
    } catch (error) {
      console.error('Error getting pending transfers:', error);
    }
    
    return pending;
  }

  /**
   * Clean up old completed orders to keep state file small
   * Remove orders older than 1000 blocks
   */
  private async cleanupOldCompletedOrders(): Promise<void> {
    const currentBlock = await this.bitcoin.getCurrentBlockHeight();
    const lastCleanup = await this.state.getLastCleanup();
    
    // Only cleanup once per 100 blocks
    if (currentBlock - lastCleanup < 100) {
      return;
    }
    
    try {
      const orders = await this.counterparty.getFilledXCPFOLIOOrders(this.config.xcpfolioAddress);
      const oldOrders = new Set<string>();
      
      for (const order of orders) {
        if (order.block_index < currentBlock - 1000) {
          oldOrders.add(order.tx_hash);
        }
      }
      
      // Remove old orders from state
      // Clean up old orders from state
      await this.state.clearOldOrders(100);
      const cleaned = oldOrders.size;
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} old completed orders`);
      }
      
      await this.state.setLastCleanup(currentBlock);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  /**
   * Recover active transactions from mempool on startup
   * 
   * When the bot restarts, it needs to know about transactions
   * that are still unconfirmed in the mempool to avoid re-broadcasting.
   * This method checks for pending asset transfers from our address.
   */
  private async recoverMempoolTransactions(): Promise<void> {
    try {
      console.log('Recovering active transactions from mempool...');
      
      // Get all unconfirmed issuances (transfers) from our address
      const mempoolTransfers = await this.counterparty.getMempoolTransfers(this.config.xcpfolioAddress);
      
      if (mempoolTransfers.length > 0) {
        console.log(`Found ${mempoolTransfers.length} unconfirmed transfers in mempool`);
        const currentBlock = await this.bitcoin.getCurrentBlockHeight();
        
        for (const transfer of mempoolTransfers) {
          // Extract transfer details from the mempool event
          const { tx_hash, params } = transfer;
          if (!params) continue;
          
          const asset = params.asset;
          const destination = params.transfer_destination || params.destination;
          
          if (!asset || !destination) continue;
          
          // Try to find the corresponding order
          const orders = await this.counterparty.getFilledXCPFOLIOOrders(this.config.xcpfolioAddress);
          const matchingOrder = orders.find(o => {
            const orderAsset = (o.give_asset_info?.asset_longname || o.give_asset).replace('XCPFOLIO.', '');
            return orderAsset === asset;
          });
          
          if (matchingOrder) {
            // Track this transaction
            console.log(`Recovered unconfirmed transfer: ${asset} -> ${destination} (tx: ${tx_hash})`);
            this.processingState.orderTransactions.set(matchingOrder.tx_hash, {
              orderHash: matchingOrder.tx_hash,
              asset,
              buyer: destination,
              txid: tx_hash,
              originalTxid: tx_hash,
              rbfHistory: [tx_hash],
              broadcastTime: Date.now() - 60000, // Estimate 1 minute ago
              broadcastBlock: currentBlock - 1,
              feeRate: 10, // Default estimate
              isRbf: false,
              rbfCount: 0
            });
            
            // Also mark as processed in state
            this.state.markOrderProcessed(matchingOrder.tx_hash);
          }
        }
      }
      
      console.log(`Active transactions after recovery: ${this.processingState.orderTransactions.size}`);
    } catch (error) {
      console.error('Error recovering mempool transactions:', error);
      // Non-fatal - continue processing
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}