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
          // Check if the asset has been transferred (ownership changed)
          const assetInfo = await this.counterparty.getAssetInfo(order.asset);
          
          if (assetInfo.owner === order.buyer) {
            // Asset is now owned by buyer - mark as confirmed/delivered
            console.log(`✅ ${order.asset} confirmed as delivered to ${order.buyer}`);
            
            // Get the transfer transaction details if we have a txid
            let deliveryBlock: number | undefined;
            let deliveryTime: number | undefined;
            
            if (order.txid) {
              try {
                const txData = await this.bitcoin.getTransaction(order.txid);
                if (txData.status?.confirmed) {
                  deliveryBlock = txData.status.block_height;
                  deliveryTime = txData.status.block_time ? txData.status.block_time * 1000 : Date.now();
                }
              } catch (error) {
                console.error(`Error fetching tx data for ${order.txid}:`, error);
              }
            }
            
            // If we don't have delivery time from tx, try to get from issuances
            if (!deliveryTime) {
              try {
                const issuances = await this.counterparty.getAssetIssuances(order.asset);
                const transfer = issuances.find(i => 
                  i.transfer === true &&
                  i.issuer === order.buyer
                );
                
                if (transfer) {
                  if (!order.txid) {
                    order.txid = transfer.tx_hash;
                  }
                  deliveryBlock = transfer.block_index;
                  if (transfer.block_time) {
                    deliveryTime = transfer.block_time * 1000;
                  }
                }
              } catch (error) {
                console.error(`Error fetching issuances for ${order.asset}:`, error);
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
            
          } else if (order.txid) {
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
                console.log(`Order ${order.orderHash} still in mempool`);
              }
            } catch (error) {
              // Transaction might have been dropped
              console.log(`TX ${order.txid} not found, may have been dropped`);
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