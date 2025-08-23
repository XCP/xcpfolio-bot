/**
 * Monitor and update confirmation status for pending transactions
 */

import { OrderHistoryService } from './order-history';
import { CounterpartyService } from './counterparty';
import { BitcoinService } from './bitcoin';
import { NotificationService } from './notifications';

export class ConfirmationMonitor {
  private orderHistory: OrderHistoryService;
  private counterparty: CounterpartyService;
  private bitcoin: BitcoinService;
  private isMonitoring: boolean = false;

  constructor(orderHistory: OrderHistoryService) {
    this.orderHistory = orderHistory;
    this.counterparty = new CounterpartyService();
    this.bitcoin = new BitcoinService('mainnet');
  }

  /**
   * Check and update confirmation status for all pending orders
   */
  async checkConfirmations(): Promise<void> {
    if (this.isMonitoring) {
      console.log('Confirmation check already in progress, skipping...');
      return;
    }

    this.isMonitoring = true;
    
    try {
      console.log('Checking order confirmations...');
      
      // Get all pending/confirming orders
      const allOrders = await this.orderHistory.getOrders();
      const pendingOrders = allOrders.filter(o => 
        o.status === 'confirming' || 
        o.status === 'broadcasting' || 
        (o.status === 'confirmed' && !o.deliveredAt) // Confirmed but missing delivery time
      );

      if (pendingOrders.length === 0) {
        console.log('No orders pending confirmation');
        return;
      }

      console.log(`Checking ${pendingOrders.length} orders for confirmation...`);

      for (const order of pendingOrders) {
        try {
          console.log(`Checking order ${order.orderHash.slice(0,8)}... Asset: ${order.asset}, Status: ${order.status}, Buyer: ${order.buyer}`);
          
          // Check if the asset has been transferred (ownership changed)
          const assetInfo = await this.counterparty.getAssetInfo(order.asset);
          
          if (assetInfo.owner === order.buyer) {
            // Asset is now owned by buyer - mark as confirmed/delivered
            console.log(`✅ ${order.asset} confirmed as delivered to ${order.buyer}`);
            
            // Get the transfer transaction details from issuances (most reliable source)
            let deliveryBlock: number | undefined;
            let deliveryTime: number | undefined;
            let transferTxid: string | undefined = order.txid;
            
            try {
              // Get issuances to find the actual transfer transaction
              const issuances = await this.counterparty.getAssetIssuances(order.asset);
              
              // Find the transfer from seller to buyer
              // The transfer will have transfer=true, source=seller, issuer=buyer (new owner)
              const transfer = issuances.find(i => 
                i.transfer === true &&
                i.source === order.seller &&
                i.issuer === order.buyer
              );
              
              if (transfer) {
                transferTxid = transfer.tx_hash;
                deliveryBlock = transfer.block_index;
                // Use the actual block_time from when the transfer was confirmed
                if (transfer.block_time) {
                  deliveryTime = transfer.block_time * 1000; // Convert to milliseconds
                  console.log(`  Found transfer in block ${deliveryBlock} at ${new Date(deliveryTime).toISOString()}`);
                }
              } else {
                console.log(`  Warning: Could not find transfer transaction in issuances`);
              }
            } catch (error) {
              console.error(`Error fetching issuances for ${order.asset}:`, error);
            }
            
            // If we still don't have delivery time but have a txid, try mempool.space
            if (!deliveryTime && transferTxid) {
              try {
                const txData = await this.bitcoin.getTransaction(transferTxid);
                if (txData.status?.confirmed) {
                  if (!deliveryBlock) {
                    deliveryBlock = txData.status.block_height;
                  }
                  if (!deliveryTime && txData.status.block_time) {
                    deliveryTime = txData.status.block_time * 1000;
                    console.log(`  Got delivery time from mempool.space: block ${deliveryBlock}`);
                  }
                }
              } catch (error) {
                console.error(`Error fetching tx data for ${transferTxid}:`, error);
              }
            }
            
            // Last resort: if we still don't have delivery time, use order purchase time
            // This is better than using "now" for historical orders
            if (!deliveryTime) {
              if (order.purchasedAt && order.purchasedAt < Date.now() - 3600000) {
                // If purchased more than 1 hour ago, use purchase time + a reasonable delay
                deliveryTime = order.purchasedAt + 600000; // Add 10 minutes
                console.log(`  Warning: Using estimated delivery time based on purchase time`);
              } else {
                deliveryTime = Date.now();
                console.log(`  Warning: Using current time as delivery time (no blockchain data found)`);
              }
            }
            
            // Update order with confirmation details
            await this.orderHistory.updateOrderStatus(
              order.orderHash,
              'confirmed',
              'confirmed',
              order.txid
            );
            
            // Update delivery details
            const updatedOrder = await this.orderHistory.getOrder(order.orderHash);
            if (updatedOrder) {
              updatedOrder.deliveredAt = deliveryTime || Date.now();
              updatedOrder.confirmedAt = deliveryTime || Date.now();
              if (deliveryBlock) {
                updatedOrder.confirmedBlock = deliveryBlock;
              }
              await this.orderHistory.upsertOrder(updatedOrder);
            }
            
            // Send notification
            await NotificationService.success('💎 Order delivered!', {
              asset: order.asset,
              buyer: order.buyer,
              orderHash: order.orderHash.slice(0, 8) + '...',
              deliveredAt: new Date(deliveryTime || Date.now()).toISOString()
            });
            
          } else {
            console.log(`Asset ${order.asset} owner is ${assetInfo.owner}, not ${order.buyer} yet`);
            
            if (order.txid) {
              // Check if transaction is still in mempool or confirmed
              try {
                const txData = await this.bitcoin.getTransaction(order.txid);
                if (txData.status?.confirmed) {
                  // Transaction confirmed but asset not transferred yet
                  // This might be a different kind of transaction
                  console.log(`TX ${order.txid} confirmed but asset ${order.asset} not yet transferred`);
                  
                  // Update confirmations count
                  const confirmations = txData.status.block_height ? 
                    (await this.bitcoin.getCurrentBlockHeight()) - txData.status.block_height + 1 : 0;
                  
                  await this.orderHistory.updateOrderConfirmations(order.orderHash, confirmations);
                } else {
                  // Still in mempool
                  console.log(`Order ${order.orderHash.slice(0,8)}... still in mempool (txid: ${order.txid.slice(0,8)}...)`);
                }
              } catch (error) {
                // Transaction might have been dropped
                console.log(`TX ${order.txid} not found, may have been dropped`);
              }
            } else {
              console.log(`Order ${order.orderHash.slice(0,8)}... has no txid yet`);
            }
          }
          
        } catch (error) {
          console.error(`Error checking order ${order.orderHash}:`, error);
        }
      }
      
    } catch (error) {
      console.error('Error during confirmation check:', error);
    } finally {
      this.isMonitoring = false;
    }
  }
}