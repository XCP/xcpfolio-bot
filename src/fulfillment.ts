import { CounterpartyService } from './services/counterparty';
import { BitcoinService } from './services/bitcoin';
import { StateManager } from './services/state';
import { Order } from './types';

export interface FulfillmentConfig {
  xcpfolioAddress: string;
  privateKey: string;
  network?: 'mainnet' | 'testnet';
  dryRun?: boolean;
}

export interface ProcessResult {
  orderHash: string;
  asset: string;
  buyer: string;
  success: boolean;
  txid?: string;
  error?: string;
}

export class FulfillmentProcessor {
  private counterparty: CounterpartyService;
  private bitcoin: BitcoinService;
  private state: StateManager;
  private config: FulfillmentConfig;

  constructor(config: FulfillmentConfig) {
    this.config = config;
    this.counterparty = new CounterpartyService();
    this.bitcoin = new BitcoinService(config.network);
    this.state = new StateManager();
  }

  /**
   * Main processing loop - call this periodically
   */
  async process(): Promise<ProcessResult[]> {
    console.log('Starting fulfillment check...');

    try {
      // 1. Check current block height
      const currentBlock = await this.bitcoin.getCurrentBlockHeight();
      const lastBlock = this.state.getLastBlock();
      
      console.log(`Current block: ${currentBlock}, Last checked: ${lastBlock}`);

      // Only proceed if we have a new block
      if (!this.state.shouldCheckForNewOrders(currentBlock)) {
        console.log('No new blocks since last check');
        return [];
      }

      // 2. Get filled orders from Counterparty
      const orders = await this.counterparty.getFilledXCPFOLIOOrders(this.config.xcpfolioAddress);
      
      if (orders.length === 0) {
        console.log('No filled orders found');
        this.state.setLastBlock(currentBlock);
        return [];
      }

      console.log(`Found ${orders.length} filled orders`);

      // 3. Check for new orders
      const latestOrderHash = orders[0].tx_hash;
      const lastOrderHash = this.state.getLastOrderHash();

      if (latestOrderHash === lastOrderHash) {
        console.log('No new orders since last check');
        this.state.setLastBlock(currentBlock);
        return [];
      }

      // 4. Process new orders
      const results: ProcessResult[] = [];
      const ordersToProcess: Order[] = [];

      // Collect orders to process (newest first)
      for (const order of orders) {
        // Stop when we reach the last processed order
        if (order.tx_hash === lastOrderHash) {
          break;
        }

        // Skip if already processed (safety check)
        if (this.state.isOrderProcessed(order.tx_hash)) {
          console.log(`Order ${order.tx_hash} already processed, skipping`);
          continue;
        }

        ordersToProcess.push(order);
      }

      console.log(`Processing ${ordersToProcess.length} new orders`);

      // Process each order
      for (const order of ordersToProcess) {
        const result = await this.processOrder(order);
        results.push(result);

        // Mark as processed regardless of success
        this.state.markOrderProcessed(order.tx_hash);

        // Add delay between orders to avoid rate limiting
        if (ordersToProcess.indexOf(order) < ordersToProcess.length - 1) {
          await this.sleep(2000);
        }
      }

      // 5. Update state
      this.state.setLastBlock(currentBlock);
      if (orders.length > 0) {
        this.state.setLastOrderHash(orders[0].tx_hash);
      }

      // Log summary
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      console.log(`Fulfillment complete: ${successful} successful, ${failed} failed`);

      return results;

    } catch (error) {
      console.error('Fulfillment process error:', error);
      throw error;
    }
  }

  /**
   * Process a single order
   */
  private async processOrder(order: Order): Promise<ProcessResult> {
    const assetName = order.give_asset.replace('XCPFOLIO.', '');
    const buyerAddress = order.source;

    console.log(`Processing order ${order.tx_hash}: ${assetName} to ${buyerAddress}`);

    try {
      // Check if already transferred (double-check using Counterparty API)
      const alreadyTransferred = await this.counterparty.isAssetTransferredTo(
        assetName,
        buyerAddress,
        this.config.xcpfolioAddress
      );

      if (alreadyTransferred) {
        console.log(`Asset ${assetName} already transferred to ${buyerAddress}`);
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
        };
      }

      // Dry run mode - don't actually send transaction
      if (this.config.dryRun) {
        console.log(`[DRY RUN] Would transfer ${assetName} to ${buyerAddress}`);
        return {
          orderHash: order.tx_hash,
          asset: assetName,
          buyer: buyerAddress,
          success: true,
          txid: 'dry-run',
        };
      }

      // Get optimal fee rate
      const feeRate = await this.bitcoin.getOptimalFeeRate();
      console.log(`Using fee rate: ${feeRate} sat/vB`);

      // Compose transfer transaction
      const rawTx = await this.counterparty.composeTransfer(
        this.config.xcpfolioAddress,
        assetName,
        buyerAddress,
        feeRate
      );

      // Sign transaction
      const signedTx = this.bitcoin.signTransaction(rawTx, this.config.privateKey);

      // Broadcast transaction
      const txid = await this.counterparty.broadcastTransaction(signedTx);
      console.log(`Successfully broadcast transfer: ${txid}`);

      return {
        orderHash: order.tx_hash,
        asset: assetName,
        buyer: buyerAddress,
        success: true,
        txid,
      };

    } catch (error) {
      console.error(`Error processing order ${order.tx_hash}:`, error);
      return {
        orderHash: order.tx_hash,
        asset: assetName,
        buyer: buyerAddress,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get current state
   */
  getState() {
    return this.state.getState();
  }

  /**
   * Reset state (use with caution!)
   */
  resetState() {
    this.state.reset();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}